// Make a non-settling (averaged) flow add up exactly (port of item_flow._balance / _within_limits).
// When the flow never settles, the average over a stretch is close to the real flow but not exact:
// a little more or less sits on the belts at the end than at the start. This makes the averages add
// up exactly - what goes into every tile comes out, factories use their recipe amounts, full inputs
// and factories at full speed stay exactly at their limit - while changing every number as little as
// possible (relative). Returns null if that doesn't work out.
import { solveLP, toCSC, hasHighs } from "./lp.js";

// ---------------------------------------------------------------- sparse LDL^T (symmetric positive definite)
/**
 * Factorize a symmetric positive definite matrix given as rows: Array<Map<col, value>> (both
 * triangles stored). Greedy minimum-degree elimination keeps the fill small (the matrices here are
 * like a graph of belts). Returns a solver: (b: Float64Array) => x.
 */
function ldl(rows) {
  const n = rows.length;
  const R = rows.map((m) => new Map(m));
  const done = new Uint8Array(n);
  const order = [], D = new Float64Array(n), Lc = new Array(n);
  // lazy min-heap of [degree, node]
  const heap = [];
  const hpush = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] < heap[i][0] || (heap[p][0] === heap[i][0] && heap[p][1] <= heap[i][1])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && (heap[l][0] < heap[m][0] || (heap[l][0] === heap[m][0] && heap[l][1] < heap[m][1]))) m = l; if (r < heap.length && (heap[r][0] < heap[m][0] || (heap[r][0] === heap[m][0] && heap[r][1] < heap[m][1]))) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const degree = (i) => R[i].size - (R[i].has(i) ? 1 : 0);
  for (let i = 0; i < n; i++) hpush([degree(i), i]);
  while (order.length < n) {
    const [dg, p] = hpop();
    if (done[p] || dg !== degree(p)) { if (!done[p]) hpush([degree(p), p]); continue; }
    done[p] = 1;
    order.push(p);
    const row = R[p];
    const d = row.get(p);
    D[p] = d;
    const nb = [];
    for (const [j, v] of row) if (j !== p) nb.push([j, v]);
    const lcol = nb.map(([j, v]) => [j, v / d]);
    Lc[p] = lcol;
    // update the rest: M[i][j] -= M[i][p] * M[p][j] / d
    for (let a = 0; a < nb.length; a++) {
      const [i, vi] = nb[a];
      const Ri = R[i];
      Ri.delete(p);
      const li = vi / d;
      for (let b = 0; b < nb.length; b++) {
        const [j, vj] = nb[b];
        Ri.set(j, (Ri.get(j) || 0) - li * vj);
      }
    }
    for (const [i] of nb) hpush([degree(i), i]);
    R[p] = null;
  }
  return (b) => {
    const y = Float64Array.from(b);
    for (const p of order) { const yp = y[p]; if (yp !== 0) for (const [i, l] of Lc[p]) y[i] -= l * yp; }
    for (let p = 0; p < n; p++) y[p] /= D[p];
    for (let t = n - 1; t >= 0; t--) { const p = order[t]; let s = y[p]; for (const [i, l] of Lc[p]) s -= l * y[i]; y[p] = s; }
    return y;
  };
}

// ---------------------------------------------------------------- balance
/**
 * Input: the simulation's averages per lane.
 *  sPush[j]: push lane j (link pl_e[j], item lane_k[pl_src[j]]); sPull[j]: pull lane; sSink[l]: per tile lane
 *  rIn[w]: what each input put in. Returns [sPush, sPull, sSink, rIn] adjusted, or null.
 */
export function balance(a) {
  const { sPush, sPull, sSink, rIn, pl_e, pl_src, ql_p, ql_src, lane_t, lane_k, es, et, ps, pa,
    inI, inK, inW, fac, facMats, facOutK, facOutAmt, facRate, cap, sink, N } = a;
  let sumIn = 0; for (const v of rIn) sumIn += v;
  const tol = 1e-13 * Math.max(1.0, sumIn);
  // variables: every (link, item) that carries something, input amounts, crafts per factory
  const pe = [], qe = [], sn = [], ji = [];
  for (let j = 0; j < sPush.length; j++) if (sPush[j] > tol) pe.push(j);
  for (let j = 0; j < sPull.length; j++) if (sPull[j] > tol) qe.push(j);
  for (let l = 0; l < sSink.length; l++) if (sSink[l] > tol && sink[lane_t[l]]) sn.push(l);
  for (let w = 0; w < rIn.length; w++) if (rIn[w] > tol) ji.push(w);
  // what leaves a factory = crafts x amount
  const outK = new Float64Array(N);
  for (let j = 0; j < sPush.length; j++) { const s = es[pl_e[j]]; if (fac[s] && lane_k[pl_src[j]] === facOutK[s]) outK[s] += sPush[j]; }
  for (let j = 0; j < sPull.length; j++) { const s = ps[ql_p[j]]; if (fac[s] && lane_k[ql_src[j]] === facOutK[s]) outK[s] += sPull[j]; }
  for (let l = 0; l < sSink.length; l++) { const s = lane_t[l]; if (fac[s] && lane_k[l] === facOutK[s]) outK[s] += sSink[l]; }
  const fi = [], craftsFi = [];
  for (let i = 0; i < N; i++) if (fac[i]) {
    const c = facOutAmt[i] > 0 ? outK[i] / Math.max(facOutAmt[i], 1e-300) : 0;
    if (c > tol) { fi.push(i); craftsFi.push(c); }
  }
  const oPull = pe.length, oSink = oPull + qe.length, oIn = oSink + sn.length, oFac = oIn + ji.length;
  const nVar = oFac + fi.length;
  if (nVar === 0) return null;
  let v0 = new Float64Array(nVar);
  pe.forEach((j, c) => { v0[c] = sPush[j]; });
  qe.forEach((j, c) => { v0[oPull + c] = sPull[j]; });
  sn.forEach((l, c) => { v0[oSink + c] = sSink[l]; });
  ji.forEach((w, c) => { v0[oIn + c] = rIn[w]; });
  fi.forEach((i, c) => { v0[oFac + c] = craftsFi[c]; });
  // held exactly at their limit: inputs that put in all they can, factories at full speed
  const fix = new Uint8Array(nVar);
  ji.forEach((w, c) => { fix[oIn + c] = rIn[w] >= inW[w] * (1 - 1e-4) ? 1 : 0; v0[oIn + c] = Math.min(v0[oIn + c], inW[w]); });
  fi.forEach((i, c) => { fix[oFac + c] = craftsFi[c] >= facRate[i] * (1 - 1e-4) ? 1 : 0; v0[oFac + c] = Math.min(v0[oFac + c], facRate[i]); });
  // balance rows: (tile, item) -> row
  const rowsOf = new Map(), Ar = [], Ac = [], Av = [];
  const put = (node, item, col, val) => {
    const key = node * 65536 + item;
    let r = rowsOf.get(key);
    if (r === undefined) { r = rowsOf.size; rowsOf.set(key, r); }
    Ar.push(r); Ac.push(col); Av.push(val);
  };
  pe.forEach((j, c) => { const e = pl_e[j], k = lane_k[pl_src[j]]; put(es[e], k, c, -1.0); put(et[e], k, c, 1.0); });
  qe.forEach((j, c) => { const p = ql_p[j], k = lane_k[ql_src[j]]; put(ps[p], k, oPull + c, -1.0); put(pa[p], k, oPull + c, 1.0); });
  sn.forEach((l, c) => { put(lane_t[l], lane_k[l], oSink + c, -1.0); });
  ji.forEach((w, c) => { put(inI[w], inK[w], oIn + c, 1.0); });
  fi.forEach((i, c) => {
    for (const [k, amt] of facMats.get(i)) if (amt > 0) put(i, k, oFac + c, -amt);
    put(i, facOutK[i], oFac + c, facOutAmt[i]);
  });
  const nRows = rowsOf.size, nnz = Ar.length;
  const ADot = (x) => { const out = new Float64Array(nRows); for (let t = 0; t < nnz; t++) out[Ar[t]] += Av[t] * x[Ac[t]]; return out; };
  const AtDot = (y) => { const out = new Float64Array(nVar); for (let t = 0; t < nnz; t++) out[Ac[t]] += Av[t] * y[Ar[t]]; return out; };
  const maxAbs = (x) => { let m = 0; for (const v of x) { const a = Math.abs(v); if (a > m) m = a; } return m; };
  // entries per column (for building A W A^T)
  const colEnt = Array.from({ length: nVar }, () => []);
  for (let t = 0; t < nnz; t++) colEnt[Ac[t]].push([Ar[t], Av[t]]);

  let maxV0 = 0; for (const v of v0) maxV0 = Math.max(maxV0, v);
  const floor = 1e-6 * Math.max(1e-9, maxV0);
  const scale = 1e-8 * Math.max(1.0, maxAbs(v0));

  const solve = (w, v0) => {
    // smallest weighted change d = w * A^T y with A d = r: solve (A W A^T) y = r
    const r = ADot(v0).map((x) => -x);
    if (nRows === 0) return Float64Array.from(v0);
    const M = Array.from({ length: nRows }, () => new Map());
    const diag = new Float64Array(nRows);
    for (let c = 0; c < nVar; c++) {
      const wc = w[c];
      if (wc === 0) continue;
      const ent = colEnt[c];
      for (const [ri, ai] of ent) {
        diag[ri] += ai * ai * wc;
        const Mi = M[ri];
        for (const [rj, aj] of ent) Mi.set(rj, (Mi.get(rj) || 0) + ai * aj * wc);
      }
    }
    // a tiny shift per row keeps it solvable when rows depend on each other
    for (let i = 0; i < nRows; i++) M[i].set(i, (M[i].get(i) || 0) + (diag[i] > 0 ? 1e-10 * diag[i] : 1.0));
    const lu = ldl(M);
    let y = lu(r);
    const rmax = Math.max(1.0, maxAbs(r));
    for (let it = 0; it < 20; it++) {            // polish (undo what the tiny shift changed)
      const Aty = AtDot(y);
      for (let c = 0; c < nVar; c++) Aty[c] *= w[c];
      const dres = ADot(Aty);
      for (let i = 0; i < nRows; i++) dres[i] = r[i] - dres[i];
      if (maxAbs(dres) <= 1e-13 * rmax) break;
      const dy = lu(dres);
      for (let i = 0; i < nRows; i++) y[i] += dy[i];
    }
    const Aty = AtDot(y);
    const out = new Float64Array(nVar);
    for (let c = 0; c < nVar; c++) out[c] = v0[c] + w[c] * Aty[c];
    return out;
  };

  const base = new Float64Array(nVar);
  for (let c = 0; c < nVar; c++) base[c] = Math.max(v0[c], floor) ** 2;
  const vSim = Float64Array.from(v0);
  const freeV = Uint8Array.from(fix, (f) => (f ? 0 : 1));
  const near = Uint8Array.from(fix);
  let vNew = Float64Array.from(v0);
  const stiff = new Float64Array(nVar).fill(1e-4);
  const hardW = () => Float64Array.from(base, (b, c) => (freeV[c] ? b : 0));
  // links / sinks per tile (for the limits)
  const outTile = new Int32Array(oSink);
  pe.forEach((j, c) => { outTile[c] = es[pl_e[j]]; });
  qe.forEach((j, c) => { outTile[oPull + c] = ps[ql_p[j]]; });
  for (let round = 0; round < 8; round++) {
    let hard = hardW();
    vNew = solve(hard, v0);
    let anyNear = false;
    for (let c = 0; c < nVar; c++) if (near[c] && !freeV[c]) { anyNear = true; break; }
    if (maxAbs(ADot(vNew)) > scale && anyNear) {
      for (let c = 0; c < nVar; c++) if (near[c]) freeV[c] = 1;
      near.fill(0);
      hard = hardW();
      vNew = solve(hard, v0);
    }
    if (maxAbs(ADot(vNew)) > scale) {
      const soft = Float64Array.from(base, (b, c) => (freeV[c] ? b : stiff[c] * b));
      const vSoft = solve(soft, v0);
      v0 = Float64Array.from(v0, (x, c) => (freeV[c] ? x : Math.max(vSoft[c], 0)));
      vNew = solve(hard, v0);
    }
    if (maxAbs(ADot(vNew)) > scale) return null;
    // nothing may go over its limit
    const over = new Uint8Array(nVar), lim = Float64Array.from(v0);
    if (sn.length) {
      const totS = new Float64Array(N);
      sn.forEach((l, c) => { totS[lane_t[l]] += vNew[oSink + c]; });
      sn.forEach((l, c) => {
        const t = lane_t[l];
        if (totS[t] > cap[t] * (1 + 1e-9)) { over[oSink + c] = 1; lim[oSink + c] = vNew[oSink + c] * cap[t] / Math.max(totS[t], 1e-300); }
      });
    }
    ji.forEach((w, c) => { if (vNew[oIn + c] > inW[w] * (1 + 1e-9)) { over[oIn + c] = 1; lim[oIn + c] = inW[w]; } });
    fi.forEach((i, c) => { if (vNew[oFac + c] > facRate[i] * (1 + 1e-9)) { over[oFac + c] = 1; lim[oFac + c] = facRate[i]; } });
    if (oSink) {
      const totO = new Float64Array(N);
      for (let c = 0; c < oSink; c++) totO[outTile[c]] += vNew[c];
      for (let c = 0; c < oSink; c++) {
        const t = outTile[c];
        if (totO[t] > cap[t] * (1 + 1e-9) && !fac[t]) { over[c] = 1; lim[c] = vNew[c] * cap[t] / Math.max(totO[t], 1e-300); }
      }
    }
    let anyOver = false;
    for (let c = 0; c < nVar; c++) { over[c] = over[c] && freeV[c] ? 1 : 0; if (over[c]) anyOver = true; }
    if (!anyOver) break;
    for (let c = 0; c < nVar; c++) if (over[c]) { freeV[c] = 0; v0[c] = lim[c]; stiff[c] = 1e-8; }
  }
  v0 = Float64Array.from(v0, (x, c) => (freeV[c] ? vSim[c] : x));
  let maxv = 0; for (const x of v0) maxv = Math.max(maxv, x);
  let dmax = 0;
  for (let c = 0; c < nVar; c++) if (freeV[c]) dmax = Math.max(dmax, Math.abs(vNew[c] - v0[c]));
  if (dmax > 0.05 * Math.max(1e-9, maxv)) return null;          // too far from what the simulation saw
  let v = Float64Array.from(v0);
  for (let c = 0; c < nVar; c++) if (freeV[c]) v[c] = vNew[c];

  // limits as groups: (variables, most they may carry together)
  const gVar = [], gCap = [];
  const groupBy = (cols, tiles) => {
    const keep = cols.map((c, j) => [c, tiles[j]]).filter(([, t]) => !fac[t] && Number.isFinite(cap[t]));
    keep.sort((x, y) => x[1] - y[1]);                        // stable: same tile keeps column order
    let j = 0;
    while (j < keep.length) {
      const t = keep[j][1], grp = [];
      while (j < keep.length && keep[j][1] === t) { grp.push(keep[j][0]); j++; }
      gVar.push(grp); gCap.push(cap[t]);
    }
  };
  if (oSink) groupBy([...Array(oSink).keys()], [...outTile]);
  if (sn.length) groupBy(sn.map((_, c) => oSink + c), sn.map((l) => lane_t[l]));
  ji.forEach((w, c) => { gVar.push([oIn + c]); gCap.push(inW[w]); });
  fi.forEach((i, c) => { gVar.push([oFac + c]); gCap.push(facRate[i]); });
  const used = gVar.map((g) => g.reduce((s, c) => s + v[c], 0));
  let bad = used.some((u, g) => u > gCap[g] * (1 + 1e-9) + 1e-12);
  if (!bad) for (const x of v) if (x < -1e-12) { bad = true; break; }
  if (bad) {
    if (!hasHighs()) return null;
    const fixed = withinLimits(v, gVar, gCap, used, Ar, Ac, Av, nRows, nVar, floor);
    if (fixed === null) return null;
    v = fixed;
  }
  for (let c = 0; c < nVar; c++) v[c] = Math.max(v[c], 0);
  const outPush = new Float64Array(sPush.length), outPull = new Float64Array(sPull.length);
  const outSink = new Float64Array(sSink.length), outIn = new Float64Array(rIn.length);
  pe.forEach((j, c) => { outPush[j] = v[c]; });
  qe.forEach((j, c) => { outPull[j] = v[oPull + c]; });
  sn.forEach((l, c) => { outSink[l] = v[oSink + c]; });
  ji.forEach((w, c) => { outIn[w] = v[oIn + c]; });
  return [outPush, outPull, outSink, outIn];
}

/**
 * Smallest (relative) change to v that keeps every balance row adding up and every limit group
 * under its limit (a linear program). Only groups near their limit are included.
 */
function withinLimits(v, gVar, caps, used, Ar, Ac, Av, nRows, nVar, floor) {
  const idx = [];
  used.forEach((u, g) => { if (u > caps[g] * (1 - 1e-3)) idx.push(g); });
  // variables: increase p and decrease n per value
  const cost = new Float64Array(2 * nVar);
  for (let c = 0; c < nVar; c++) { const w = 1.0 / Math.max(v[c], floor); cost[c] = w; cost[nVar + c] = w; }
  const R = [], C = [], V = [];
  for (let t = 0; t < Ar.length; t++) { R.push(Ar[t]); C.push(Ac[t]); V.push(Av[t]); R.push(Ar[t]); C.push(nVar + Ac[t]); V.push(-Av[t]); }
  idx.forEach((g, r) => { for (const c of gVar[g]) { R.push(nRows + r); C.push(c); V.push(1); R.push(nRows + r); C.push(nVar + c); V.push(-1); } });
  const Av0 = new Float64Array(nRows);
  for (let t = 0; t < Ar.length; t++) Av0[Ar[t]] += Av[t] * v[Ac[t]];
  const rowLower = [], rowUpper = [];
  for (let i = 0; i < nRows; i++) { rowLower.push(-Av0[i]); rowUpper.push(-Av0[i]); }
  for (const g of idx) { rowLower.push(-Infinity); rowUpper.push(caps[g] - used[g]); }
  const colLower = [], colUpper = [];
  for (let c = 0; c < nVar; c++) { colLower.push(Math.max(-v[c], 0)); colUpper.push(Infinity); }
  for (let c = 0; c < nVar; c++) { colLower.push(0); colUpper.push(Math.max(v[c], 0)); }
  const csc = toCSC(R, C, V, 2 * nVar);
  const res = solveLP({ numCols: 2 * nVar, numRows: nRows + idx.length, colCost: cost, colLower, colUpper, rowLower, rowUpper, ...csc });
  if (!res.ok) return null;
  return Float64Array.from(v, (x, c) => Math.max(x + res.x[c] - res.x[nVar + c], 0));
}
