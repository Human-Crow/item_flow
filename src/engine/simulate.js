// Step-by-step simulation of what is on each tile, like the game does it (port of FlowGraph._simulate).
// Every tile holds a small buffer, passes on up to its speed per step and only accepts what it has
// room for: full belts back up the line, splitters send more to outputs that have room, merging belts
// share a full belt. Runs until the flow is stable. Items are kept per (tile, item) "lane".
import { Building as B } from "../data.js";
import { SINK, INF, EPS, msum } from "./util.js";
import { settings, BELT_LIKE } from "./model.js";
import { balance } from "./balance.js";

const SIM_WINDOW = 10;
const SIM_TOL = 1e-9;
const SIM_BUFFER = 4.0;
const SIM_JUMP_TOL = 1e-9;
const SIM_SETTLE_STEPS = 6000;
const SIM_AVG_STEPS = 4000;
const SIM_SNAP_EVERY = 10;
const SIM_MIN_SPAN = 1000;
const SIM_MERGE_LINES = true;
const SIM_GROW_BUFFERS = true;
const ARM_YIELDS = true;
const SNAP_BUDGET = globalThis.FLOW_SNAP_BUDGET || 1.5e8;     // bytes for the snapshots of a non-settling flow (phones have little memory)
const TINY = 1e-300;

export function simulate(g, live, exact = null) {
  if (g._chains_for[0] !== live) g._chains_for = [live, SIM_MERGE_LINES ? g._chains(live) : new Map()];
  const chains = g._chains_for[1];
  const inner = new Set();
  for (const line of chains.values()) for (let j = 1; j < line.length; j++) inner.add(line[j]);
  const tail = new Map();
  for (const [h, line] of chains) tail.set(h, line[line.length - 1]);
  const nodes = [...live].filter((n) => n !== SINK && !inner.has(n)).sort((a, b) => a - b);
  const N = nodes.length;
  if (N === 0) return { flow: new Map(), links: [], bottlenecks: new Map(), held_back: new Map(), converged: true };
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const grid = g.grid;
  const srcs = nodes.filter((n) => grid.get(n).is_input || grid.get(n).is_source);
  const allItems = new Set(srcs.map((n) => grid.get(n).filter));
  for (const n of nodes) if (g._isFactory(n)) { const r = g.recipe.get(n); allItems.add(r.out_item); for (const m of r.mats.keys()) allItems.add(m); }
  let itemIds = [...allItems].sort((a, b) => a - b);
  if (!itemIds.length) itemIds = [0];
  const kidx = new Map(itemIds.map((it, k) => [it, k]));

  const wants = srcs.map((n) => [idx.get(n), kidx.get(grid.get(n).filter), g._supply(grid.get(n))]);
  let totalIn = 0; for (const w of wants) totalIn += w[2];
  let big = Math.max(1.0, totalIn);
  for (const n of nodes) { const c = g._tileCap(n); if (c < INF) big = Math.max(big, c); }
  big *= 4;
  const belt = settings.BELT_SPEED === null ? big : Math.min(settings.BELT_SPEED, big);
  const cap = new Float64Array(N);
  nodes.forEach((n, i) => { cap[i] = Math.min(g._tileCap(n), grid.get(n).id === B.Robotic_Arm ? belt : big); });
  const bounds = g._flowBounds(nodes, idx, wants, cap, tail);
  const roomCap = new Float64Array(N);
  for (let i = 0; i < N; i++) roomCap[i] = SIM_BUFFER * Math.min(cap[i], bounds[i]);
  const fac = new Uint8Array(N);
  nodes.forEach((n, i) => { fac[i] = g._isFactory(n) ? 1 : 0; });
  let roomMax = new Float64Array(roomCap);
  if (exact && exact.size && SIM_GROW_BUFFERS) {
    const guess = new Float64Array(N);
    for (const [n, it] of exact) { const i = idx.get(n); if (i !== undefined) guess[i] = msum(it); }
    for (let i = 0; i < N; i++) {
      if (fac[i]) continue;
      roomMax[i] = guess[i] > 0 ? Math.min(roomCap[i], Math.max(SIM_BUFFER * guess[i], 1e-3 * roomCap[i])) : roomCap[i];
    }
  }
  const sink = new Uint8Array(N);
  nodes.forEach((n, i) => { sink[i] = grid.get(n).is_output ? 1 : 0; });

  // links
  const esL = [], etL = [], psL = [], paL = [], pfL = [];
  for (const n of nodes) {
    const e = tail.get(n) ?? n;
    for (const t of g.push.get(e) || []) if (live.has(t) && t !== SINK) { esL.push(idx.get(n)); etL.push(idx.get(t)); }
    for (const a of g.pulls.get(e) || []) if (live.has(a)) {
      const f = grid.get(a).is_output ? 0 : grid.get(a).filter;
      psL.push(idx.get(n)); paL.push(idx.get(a)); pfL.push(f === 0 ? -1 : (kidx.has(f) ? kidx.get(f) : -2));
    }
  }
  const es = Int32Array.from(esL), et = Int32Array.from(etL), ps = Int32Array.from(psL), pa = Int32Array.from(paL), pf = Int32Array.from(pfL);
  const E = es.length, Pn = ps.length;
  const deg = new Float64Array(N);
  for (let e = 0; e < E; e++) deg[es[e]] += 1;
  const multi = new Float64Array(E);
  for (let e = 0; e < E; e++) multi[e] = deg[es[e]] > 1 ? 1 : 0;
  // factories
  const facRate = new Float64Array(N), facOutK = new Int32Array(N), facOutAmt = new Float64Array(N);
  const facMats = new Map();          // node -> [[k, amount]] sorted by k
  nodes.forEach((n, i) => {
    if (!fac[i]) return;
    const rec = g.recipe.get(n);
    facRate[i] = g.rate.get(n); facOutK[i] = kidx.get(rec.out_item); facOutAmt[i] = rec.out_amount;
    facMats.set(i, [...rec.mats].map(([m, a]) => [kidx.get(m), a]).sort((x, y) => x[0] - y[0]));
  });
  const intake = new Float64Array(cap);
  for (const [i, mats] of facMats) { let s = 0; for (const [, a] of mats) s += a * facRate[i]; intake[i] = s; }
  const inI = Int32Array.from(wants.map((w) => w[0])), inK = Int32Array.from(wants.map((w) => w[1]));
  const inW = Float64Array.from(wants.map((w) => w[2]));
  const nW = wants.length;

  // ---- lanes: which items can be on which tile
  const itemsOn = Array.from({ length: N }, () => new Set());
  const stack = [];
  const give = (i, k) => { if (!itemsOn[i].has(k)) { itemsOn[i].add(k); stack.push(i); } };
  for (const [i, k] of wants) give(i, k);
  for (let i = 0; i < N; i++) if (fac[i]) give(i, facOutK[i]);
  if (exact && exact.size) for (const [n, it] of exact) { const i = idx.get(n); if (i !== undefined && !fac[i]) for (const item of it.keys()) if (kidx.has(item)) give(i, kidx.get(item)); }
  const outEdges = Array.from({ length: N }, () => []);
  for (let e = 0; e < E; e++) outEdges[es[e]].push(et[e]);
  const outPulls = Array.from({ length: N }, () => []);
  for (let p = 0; p < Pn; p++) outPulls[ps[p]].push([pa[p], pf[p]]);
  while (stack.length) {
    const i = stack.pop();
    for (const k of [...itemsOn[i]]) {
      if (fac[i] && k !== facOutK[i]) continue;
      for (const t of outEdges[i]) if (!fac[t]) give(t, k);
      for (const [a, f] of outPulls[i]) if (f === -1 || f === k) give(a, k);
    }
  }
  for (let i = 0; i < N; i++) if (fac[i]) itemsOn[i] = new Set([facOutK[i]]);
  const sortedOn = itemsOn.map((s) => [...s].sort((a, b) => a - b));
  const laneT = [], laneK = [], laneOf = new Map();
  const lk = (i, k) => i * 65536 + k;
  for (let i = 0; i < N; i++) for (const k of sortedOn[i]) { laneOf.set(lk(i, k), laneT.length); laneT.push(i); laneK.push(k); }
  const L = laneT.length;
  const lane_t = Int32Array.from(laneT), lane_k = Int32Array.from(laneK);
  // factory input slots
  const finOf = new Map(), finTL = [], finKL = [], finAmtL = [];
  const facRows = [], facStart = [], facCount = [];
  for (let i = 0; i < N; i++) {
    if (!fac[i]) continue;
    facRows.push(i); facStart.push(finTL.length);
    for (const [k, a] of facMats.get(i)) if (a > 0) { finOf.set(lk(i, k), finTL.length); finTL.push(i); finKL.push(k); finAmtL.push(a); }
    facCount.push(finTL.length - facStart[facStart.length - 1]);
  }
  const fin_t = Int32Array.from(finTL), finAmt = Float64Array.from(finAmtL);
  const F = fin_t.length;
  const finRoomMax = new Float64Array(F);
  for (let f = 0; f < F; f++) finRoomMax[f] = 2.0 * finAmt[f] * facRate[fin_t[f]];
  const facOutLane = facRows.map((i) => laneOf.get(lk(i, facOutK[i])));
  // push lanes
  const plE = [], plSrc = [], plDst = [];
  for (let e = 0; e < E; e++) {
    const s = es[e], t = et[e];
    for (const k of sortedOn[s]) {
      plE.push(e); plSrc.push(laneOf.get(lk(s, k)));
      plDst.push(fac[t] ? (finOf.has(lk(t, k)) ? finOf.get(lk(t, k)) : -1) : laneOf.get(lk(t, k)));
    }
  }
  const pl_e = Int32Array.from(plE), pl_src = Int32Array.from(plSrc), pl_dst = Int32Array.from(plDst);
  const nPl = pl_e.length;
  const plFac = new Uint8Array(nPl), plOk = new Uint8Array(nPl), plCm = new Uint8Array(nPl), plFm = new Uint8Array(nPl);
  for (let j = 0; j < nPl; j++) {
    plFac[j] = fac[et[pl_e[j]]]; plOk[j] = pl_dst[j] >= 0 ? 1 : 0;
    plCm[j] = !plFac[j] && plOk[j] ? 1 : 0; plFm[j] = plFac[j] && plOk[j] ? 1 : 0;
  }
  const fe = new Uint8Array(E);
  let feAny = false;
  for (let e = 0; e < E; e++) { fe[e] = fac[et[e]]; if (fe[e]) feAny = true; }
  const lowE = new Uint8Array(E);
  let lowAny = false;
  if (ARM_YIELDS) for (let e = 0; e < E; e++) {
    const s = grid.get(nodes[es[e]]), t = grid.get(nodes[et[e]]);
    if (s.id === B.Robotic_Arm && !s.is_input && BELT_LIKE.has(t.id)) { lowE[e] = 1; lowAny = true; }
  }
  // pull lanes
  const qlP = [], qlSrc = [], qlDst = [];
  for (let p = 0; p < Pn; p++) {
    const s = ps[p], a = pa[p], f = pf[p];
    for (const k of sortedOn[s]) if (f === -1 || f === k) { qlP.push(p); qlSrc.push(laneOf.get(lk(s, k))); qlDst.push(laneOf.get(lk(a, k))); }
  }
  const ql_p = Int32Array.from(qlP), ql_src = Int32Array.from(qlSrc), ql_dst = Int32Array.from(qlDst);
  const nQl = ql_p.length;
  const qlItem = new Uint8Array(nQl);
  for (let j = 0; j < nQl; j++) qlItem[j] = pf[ql_p[j]] >= 0 ? 1 : 0;
  const pFl = new Int32Array(Pn).fill(-1);
  for (let p = 0; p < Pn; p++) if (pf[p] >= 0) { const l = laneOf.get(lk(ps[p], pf[p])); pFl[p] = l === undefined ? -1 : l; }
  const inLane = Int32Array.from(wants.map(([i, k]) => laneOf.get(lk(i, k))));
  const laneCounts = new Int32Array(N);
  for (let l = 0; l < L; l++) laneCounts[lane_t[l]]++;
  const mx = [];
  for (let l = 0; l < L; l++) if (laneCounts[lane_t[l]] > 1) mx.push(l);
  const anyMixed = mx.length > 0;

  // ---- state
  let comp = new Float64Array(L), fin = new Float64Array(F), q = new Float64Array(N);
  let sentPrev = new Float64Array(N);
  // per-step work arrays
  const free = new Float64Array(N), inRoom = new Float64Array(F), frac = new Float64Array(L), avail = new Float64Array(N);
  const totr = new Float64Array(N), gp = new Float64Array(Pn), rArm = new Float64Array(Pn);
  const pulled = new Float64Array(L), remL = new Float64Array(L), rem = new Float64Array(N), pushMix = new Float64Array(L);
  const oAll = new Float64Array(E), o = new Float64Array(E), toto = new Float64Array(N), gE = new Float64Array(E);
  const incF = new Float64Array(F), oi = new Float64Array(nPl), gF = new Float64Array(E), resid = new Float64Array(N), sumG = new Float64Array(N);
  const leftE = new Float64Array(E), Lsum = new Float64Array(N), wE = new Float64Array(E), Wsum = new Float64Array(N);
  const offer2 = new Float64Array(E), tot2 = new Float64Array(N), gpush = new Float64Array(E), totLo = new Float64Array(N), roomLeft = new Float64Array(N);
  const partPush = new Float64Array(nPl), partPull = new Float64Array(nQl), partSink = new Float64Array(L);
  const moved = new Float64Array(L), Tn = new Float64Array(N), scaleL = new Float64Array(L);
  const outL = new Float64Array(L), inc = new Float64Array(L), toFin = new Float64Array(F), incoming = new Float64Array(F), sumInRoom = new Float64Array(N);
  const add = new Float64Array(nW);
  const sentAvg = new Float64Array(N);
  const crafts = new Float64Array(facRows.length);

  const zerosAcc = () => [new Float64Array(nPl), new Float64Array(nQl), new Float64Array(L), new Float64Array(nW), new Float64Array(N)];
  let [accPush, accPull, accSink, accIn, accQ] = zerosAcc();
  let snapComp = new Float64Array(comp), snapFin = new Float64Array(fin);
  let prev = null, result = null, converged = false, steps = 0;
  let longAvg = null;
  const snaps = [];
  const perSnap = 8 * (2 * L + F + nPl + nQl + nW + N);
  const snapEvery = Math.max(SIM_SNAP_EVERY, Math.floor(SIM_AVG_STEPS * perSnap / SNAP_BUDGET) + 1);
  const warm = g._sim_state;
  let settle;
  if (warm && warm[0] === N && warm[1] === L && warm[2] === F) {
    comp = new Float64Array(warm[3]); fin = new Float64Array(warm[4]);
    for (let i = 0; i < N; i++) roomMax[i] = Math.min(roomCap[i], Math.max(roomMax[i], warm[5][i]));
    q.fill(0); for (let l = 0; l < L; l++) q[lane_t[l]] += comp[l];
    settle = Math.floor(SIM_SETTLE_STEPS / 4);
  } else settle = g._sim_quick ? Math.floor(SIM_SETTLE_STEPS / 2) : SIM_SETTLE_STEPS;
  const avgSteps = g._sim_quick ? Math.floor(SIM_AVG_STEPS / 4) : SIM_AVG_STEPS;
  const tolIn = SIM_TOL * Math.max(1.0, totalIn), jumpTol = SIM_JUMP_TOL * Math.max(1.0, totalIn);

  while (steps < settle + avgSteps) {
    steps++;
    for (let i = 0; i < N; i++) free[i] = Math.max(roomMax[i] - q[i] + sentPrev[i], 0);
    for (let f = 0; f < F; f++) inRoom[f] = Math.max(finRoomMax[f] - fin[f], 0);
    if (F) {
      sumInRoom.fill(0);
      for (let f = 0; f < F; f++) sumInRoom[fin_t[f]] += inRoom[f];
      for (const i of facRows) free[i] = sumInRoom[i];
    }
    for (let l = 0; l < L; l++) { const qt = q[lane_t[l]]; frac[l] = qt > 0 ? comp[l] / qt : 0; }
    for (let i = 0; i < N; i++) avail[i] = Math.min(q[i], cap[i]);

    // arms grab first (their filter item only)
    pulled.fill(0);
    if (Pn) {
      totr.fill(0);
      for (let p = 0; p < Pn; p++) {
        const fa = pf[p] >= 0 ? (pFl[p] >= 0 ? frac[pFl[p]] : 0) * avail[ps[p]] : (pf[p] === -1 ? avail[ps[p]] : 0);
        rArm[p] = Math.min(fa, cap[pa[p]]);
        totr[ps[p]] += rArm[p];
      }
      for (let p = 0; p < Pn; p++) {
        const s = ps[p];
        const sc = totr[s] > avail[s] ? avail[s] / Math.max(totr[s], TINY) : 1.0;
        gp[p] = Math.min(rArm[p] * sc, free[pa[p]]);
      }
      for (let j = 0; j < nQl; j++) {
        const v = qlItem[j] ? gp[ql_p[j]] : frac[ql_src[j]] * gp[ql_p[j]];
        partPull[j] = v; pulled[ql_src[j]] += v;
      }
    }
    // what is left moves on along the belt
    rem.fill(0);
    for (let l = 0; l < L; l++) {
      const t = lane_t[l];
      remL[l] = sink[t] ? 0 : Math.max(frac[l] * avail[t] - pulled[l], 0);
      rem[t] += remL[l];
    }
    for (let l = 0; l < L; l++) { const r = rem[lane_t[l]]; pushMix[l] = r > 0 ? remL[l] / r : 0; }

    if (E) {
      toto.fill(0);
      for (let e = 0; e < E; e++) {
        const s = es[e], t = et[e];
        oAll[e] = Math.min(rem[s] / deg[s], Math.min(intake[t], fac[t] ? INF : free[t]));
        o[e] = lowE[e] ? 0 : oAll[e];
        toto[t] += o[e];
      }
      for (let e = 0; e < E; e++) { const t = et[e]; gE[e] = o[e] * (toto[t] > free[t] ? free[t] / Math.max(toto[t], TINY) : 1.0); }
      if (feAny) {
        incF.fill(0);
        for (let j = 0; j < nPl; j++) { oi[j] = pushMix[pl_src[j]] * o[pl_e[j]]; if (plFm[j]) incF[pl_dst[j]] += oi[j]; }
        gF.fill(0);
        for (let j = 0; j < nPl; j++) if (plFac[j] && plFm[j]) {
          const f = pl_dst[j];
          gF[pl_e[j]] += oi[j] * (incF[f] > inRoom[f] ? inRoom[f] / Math.max(incF[f], TINY) : 1.0);
        }
        for (let e = 0; e < E; e++) if (fe[e]) gE[e] = gF[e];
      }
      sumG.fill(0);
      for (let e = 0; e < E; e++) sumG[et[e]] += gE[e];
      for (let i = 0; i < N; i++) resid[i] = Math.max(free[i] - sumG[i], 0);
      Lsum.fill(0); Wsum.fill(0);
      for (let e = 0; e < E; e++) {
        const s = es[e];
        leftE[e] = (rem[s] / deg[s] - gE[e]) * multi[e];
        wE[e] = resid[et[e]] * multi[e];
        Lsum[s] += leftE[e]; Wsum[s] += wE[e];
      }
      tot2.fill(0);
      for (let e = 0; e < E; e++) { const s = es[e]; offer2[e] = Wsum[s] > 0 ? Lsum[s] * wE[e] / Math.max(Wsum[s], TINY) : 0; tot2[et[e]] += offer2[e]; }
      for (let e = 0; e < E; e++) { const t = et[e]; gpush[e] = gE[e] + offer2[e] * (tot2[t] > resid[t] ? resid[t] / Math.max(tot2[t], TINY) : 1.0); }
      if (lowAny) {
        roomLeft.fill(0);
        for (let e = 0; e < E; e++) { const t = et[e]; roomLeft[t] += offer2[e] * (tot2[t] > resid[t] ? resid[t] / Math.max(tot2[t], TINY) : 1.0); }
        for (let i = 0; i < N; i++) roomLeft[i] = Math.max(resid[i] - roomLeft[i], 0);
        totLo.fill(0);
        for (let e = 0; e < E; e++) if (lowE[e]) totLo[et[e]] += oAll[e];
        for (let e = 0; e < E; e++) if (lowE[e]) { const t = et[e]; gpush[e] += oAll[e] * (totLo[t] > roomLeft[t] ? roomLeft[t] / Math.max(totLo[t], TINY) : 1.0); }
      }
      for (let j = 0; j < nPl; j++) partPush[j] = plOk[j] ? pushMix[pl_src[j]] * gpush[pl_e[j]] : 0;
      if (F && feAny) {
        incoming.fill(0);
        for (let j = 0; j < nPl; j++) if (plFm[j]) incoming[pl_dst[j]] += partPush[j];
        for (let j = 0; j < nPl; j++) if (plFm[j]) {
          const f = pl_dst[j];
          partPush[j] *= incoming[f] > 0 ? Math.min(1.0, inRoom[f] / Math.max(incoming[f], TINY)) : 1.0;
        }
      }
    }
    for (let l = 0; l < L; l++) partSink[l] = sink[lane_t[l]] ? frac[l] * avail[lane_t[l]] : 0;

    // belts are first-in-first-out: items leave in the mix they are on the tile
    if (anyMixed) {
      moved.set(partSink);
      for (let j = 0; j < nPl; j++) moved[pl_src[j]] += partPush[j];
      for (let j = 0; j < nQl; j++) moved[ql_src[j]] += partPull[j];
      Tn.fill(INF);
      for (const l of mx) {
        const per = frac[l] > 1e-12 ? moved[l] / Math.max(frac[l], TINY) : INF;
        if (per < Tn[lane_t[l]]) Tn[lane_t[l]] = per;
      }
      for (let i = 0; i < N; i++) if (!Number.isFinite(Tn[i])) Tn[i] = 0;
      scaleL.fill(1);
      for (const l of mx) scaleL[l] = moved[l] > 0 ? Math.min(1.0, Tn[lane_t[l]] * frac[l] / Math.max(moved[l], TINY)) : 0;
      for (let j = 0; j < nPl; j++) partPush[j] *= scaleL[pl_src[j]];
      for (let j = 0; j < nQl; j++) partPull[j] *= scaleL[ql_src[j]];
      for (let l = 0; l < L; l++) partSink[l] *= scaleL[l];
    }
    outL.set(partSink); inc.fill(0); toFin.fill(0);
    for (let j = 0; j < nPl; j++) {
      outL[pl_src[j]] += partPush[j];
      if (plCm[j]) inc[pl_dst[j]] += partPush[j];
      else if (plFm[j]) toFin[pl_dst[j]] += partPush[j];
    }
    for (let j = 0; j < nQl; j++) { outL[ql_src[j]] += partPull[j]; inc[ql_dst[j]] += partPull[j]; }
    q.fill(0);
    for (let l = 0; l < L; l++) { comp[l] = Math.max(comp[l] + inc[l] - outL[l], 0); q[lane_t[l]] += comp[l]; }
    for (let f = 0; f < F; f++) fin[f] += toFin[f];
    // craft: as much as inputs, speed and output room allow
    for (let j = 0; j < facRows.length; j++) {
      const i = facRows[j];
      let possible = INF;
      if (facCount[j]) { for (let f = facStart[j]; f < facStart[j] + facCount[j]; f++) possible = Math.min(possible, fin[f] / Math.max(finAmt[f], TINY)); }
      let c = Math.min(Math.min(facRate[i], possible), Math.max(roomMax[i] - q[i], 0) / Math.max(facOutAmt[i], TINY));
      crafts[j] = Math.max(c, 0);
    }
    for (let j = 0; j < facRows.length; j++) {
      const i = facRows[j];
      for (let f = facStart[j]; f < facStart[j] + facCount[j]; f++) fin[f] = Math.max(fin[f] - crafts[j] * finAmt[f], 0);
      const made = crafts[j] * facOutAmt[i];
      comp[facOutLane[j]] += made; q[i] += made;
    }
    for (let w = 0; w < nW; w++) add[w] = Math.min(inW[w], Math.max(roomMax[inI[w]] - q[inI[w]], 0));
    for (let w = 0; w < nW; w++) { comp[inLane[w]] += add[w]; q[inI[w]] += add[w]; }
    sentPrev = new Float64Array(N);
    for (let l = 0; l < L; l++) sentPrev[lane_t[l]] += outL[l];
    for (let i = 0; i < N; i++) {
      sentAvg[i] += 0.05 * (sentPrev[i] - sentAvg[i]);
      if (!fac[i] && sentAvg[i] > 0.5 * roomMax[i] && roomMax[i] < roomCap[i]) roomMax[i] = Math.min(roomCap[i], 2.0 * roomMax[i]);
    }
    for (let j = 0; j < nPl; j++) accPush[j] += partPush[j];
    for (let j = 0; j < nQl; j++) accPull[j] += partPull[j];
    for (let l = 0; l < L; l++) accSink[l] += partSink[l];
    for (let w = 0; w < nW; w++) accIn[w] += add[w];
    const finSum = new Float64Array(N);
    for (let f = 0; f < F; f++) finSum[fin_t[f]] += fin[f];
    for (let i = 0; i < N; i++) accQ[i] += q[i] + finSum[i];
    if (steps > settle) {                       // doesn't settle: average the rest
      if (longAvg === null) longAvg = zerosAcc();
      for (let j = 0; j < nPl; j++) longAvg[0][j] += partPush[j];
      for (let j = 0; j < nQl; j++) longAvg[1][j] += partPull[j];
      for (let l = 0; l < L; l++) longAvg[2][l] += partSink[l];
      for (let w = 0; w < nW; w++) longAvg[3][w] += add[w];
      for (let i = 0; i < N; i++) longAvg[4][i] += q[i] + finSum[i];
      if ((steps - settle) % snapEvery === 0) {
        const st = new Float64Array(L + F); st.set(comp); st.set(fin, L);
        snaps.push([steps, st, longAvg.map((a) => new Float64Array(a))]);
      }
      continue;
    }
    if (steps % SIM_WINDOW === 0) {
      const cur = [accPush, accPull, accSink, accIn, accQ].map((a) => a.map((v) => v / SIM_WINDOW));
      if (prev !== null) {
        let diff = 0;
        for (let a = 0; a < 4; a++) { const x = cur[a], y = prev[a]; for (let j = 0; j < x.length; j++) { const d = Math.abs(x[j] - y[j]); if (d > diff) diff = d; } }
        let grow = 0;
        for (let i = 0; i < N; i++) { const d = Math.abs(cur[4][i] - prev[4][i]); if (d > grow) grow = d; }
        if (diff < tolIn && grow < tolIn * SIM_WINDOW) { result = cur; converged = true; break; }
        if (diff < jumpTol) {
          // flows are steady but some buffers still fill / empty at a steady pace: jump ahead
          const gComp = new Float64Array(L), gFin = new Float64Array(F), gQ = new Float64Array(N);
          for (let l = 0; l < L; l++) { gComp[l] = (comp[l] - snapComp[l]) / SIM_WINDOW; gQ[lane_t[l]] += gComp[l]; }
          for (let f = 0; f < F; f++) gFin[f] = (fin[f] - snapFin[f]) / SIM_WINDOW;
          let jump = INF, any = false;
          for (let i = 0; i < N; i++) {
            if (gQ[i] > 1e-12) { jump = Math.min(jump, (roomMax[i] - q[i]) / gQ[i]); any = true; }
            else if (gQ[i] < -1e-12) { jump = Math.min(jump, q[i] / -gQ[i]); any = true; }
          }
          for (let f = 0; f < F; f++) {
            if (gFin[f] > 1e-12) { jump = Math.min(jump, (finRoomMax[f] - fin[f]) / gFin[f]); any = true; }
            else if (gFin[f] < -1e-12) { jump = Math.min(jump, fin[f] / -gFin[f]); any = true; }
          }
          if (!any) jump = 0;
          if (jump > 1) {
            q.fill(0);
            for (let l = 0; l < L; l++) { comp[l] = Math.max(comp[l] + gComp[l] * jump, 0); q[lane_t[l]] += comp[l]; }
            for (let f = 0; f < F; f++) fin[f] = Math.min(Math.max(fin[f] + gFin[f] * jump, 0), Math.max(finRoomMax[f], 0));
          }
        }
      }
      prev = result = cur;
      [accPush, accPull, accSink, accIn, accQ] = zerosAcc();
      snapComp = new Float64Array(comp); snapFin = new Float64Array(fin);
    }
  }
  g._sim_steps = steps;
  g._sim_state = [N, L, F, new Float64Array(comp), new Float64Array(fin), new Float64Array(roomMax)];
  if (!converged && longAvg !== null) {
    // average over the stretch that starts and ends with (nearly) the same items on every tile
    let best = [settle, steps, longAvg.map((a) => new Float64Array(a.length)), longAvg];
    if (snaps.length >= 2) {
      const S = snaps.length, sq = snaps.map(([, v]) => { let s = 0; for (const x of v) s += x * x; return s; });
      let bestScore = INF, bi = -1, bj = -1;
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
        const span = snaps[j][0] - snaps[i][0];
        if (span < SIM_MIN_SPAN) continue;
        const a = snaps[i][1], b = snaps[j][1];
        let dot = 0; for (let t = 0; t < a.length; t++) dot += a[t] * b[t];
        const d2 = Math.max(sq[i] + sq[j] - 2 * dot, 0);
        const score = Math.sqrt(d2) / Math.max(span, 1.0);
        if (score < bestScore) { bestScore = score; bi = i; bj = j; }
      }
      if (bi >= 0 && Number.isFinite(bestScore)) best = [snaps[bi][0], snaps[bj][0], snaps[bi][2], snaps[bj][2]];
    }
    const [t0, t1, c0, c1] = best;
    const nAvg = Math.max(1, t1 - t0);
    result = c1.map((a, j) => a.map((v, t) => (v - c0[j][t]) / nAvg));
  }
  if (result === null) result = [accPush, accPull, accSink, accIn, accQ].map((a) => a.map((v) => v / Math.max(steps, 1)));
  let [sPush, sPull, sSink, rIn, rQ] = result;
  if (!converged) {
    const fixed = balance({ sPush, sPull, sSink, rIn, pl_e, pl_src, ql_p, ql_src, lane_t, lane_k, es, et, ps, pa,
      inI, inK, inW, fac, facMats, facOutK, facOutAmt, facRate, cap, sink, N });
    g._balanced = fixed !== null;
    if (fixed !== null) [sPush, sPull, sSink, rIn] = fixed;
  }

  // ---- back to tiles and links
  const flow = new Map(), links = [];
  const inflow = new Float64Array(N), outflow = new Float64Array(N);
  const fl = (k) => { let m = flow.get(k); if (!m) flow.set(k, m = new Map()); return m; };
  const addLink = (s, t, entries) => {   // entries: [[k, v]]
    const it = new Map();
    let tot = 0;
    for (const [k, v] of entries) { tot += v; if (v > 1e-9) it.set(itemIds[k], (it.get(itemIds[k]) || 0) + v); }
    if (!it.size) return;
    links.push([tail.get(nodes[s]) ?? nodes[s], t, it]);
    outflow[s] += tot;
    if (t !== SINK) {
      const ft = fl(t);
      for (const [i, v] of it) ft.set(i, (ft.get(i) || 0) + v);
      inflow[idx.get(t)] += tot;
    }
  };
  // group lane values per link (lanes of a link are next to each other)
  {
    let j = 0;
    for (let e = 0; e < E; e++) {
      const ent = [];
      while (j < nPl && pl_e[j] === e) { ent.push([lane_k[pl_src[j]], sPush[j]]); j++; }
      addLink(es[e], nodes[et[e]], ent);
    }
  }
  {
    let j = 0;
    for (let p = 0; p < Pn; p++) {
      const ent = [];
      while (j < nQl && ql_p[j] === p) { ent.push([lane_k[ql_src[j]], sPull[j]]); j++; }
      addLink(ps[p], nodes[pa[p]], ent);
    }
  }
  {
    let l = 0;
    for (let i = 0; i < N; i++) {
      const ent = [];
      while (l < L && lane_t[l] === i) { ent.push([lane_k[l], sSink[l]]); l++; }
      if (sink[i]) addLink(i, SINK, ent);
    }
  }
  wants.forEach(([i, k], j) => {
    const v = rIn[j];
    if (v > 1e-9) { const m = fl(nodes[i]); m.set(itemIds[k], (m.get(itemIds[k]) || 0) + v); inflow[i] += v; }
  });
  for (const n of srcs) fl(n);

  // bottleneck = running at its own max while something before it is backed up
  const full = new Uint8Array(N);
  for (let i = 0; i < N; i++) full[i] = rQ[i] > 0.6 * roomMax[i] && cap[i] < big ? 1 : 0;
  const senders = Array.from({ length: N }, () => []);
  for (let e = 0; e < E; e++) senders[et[e]].push(es[e]);
  for (let p = 0; p < Pn; p++) senders[pa[p]].push(ps[p]);
  const bottlenecks = new Map(), held_back = new Map();
  nodes.forEach((n, i) => {
    const c = cap[i];
    if (c >= big) return;
    const atMax = outflow[i] >= c * (1 - 1e-6) || (!fac[i] && inflow[i] >= c * (1 - 1e-6));
    const b = grid.get(n);
    if (atMax && (senders[i].some((s) => full[s]) || (b.is_input && (b.flow ?? 0) > c + EPS))) bottlenecks.set(n, c);
  });
  nodes.forEach((n, i) => { if (full[i] && !bottlenecks.has(n)) held_back.set(n, inflow[i]); });
  // a merged belt line: every tile carries what its first tile carries
  for (const [h, line] of chains) {
    const items = flow.get(h);
    if (!items || !items.size) continue;
    for (let j = 0; j + 1 < line.length; j++) {
      links.push([line[j], line[j + 1], new Map(items)]);
      flow.set(line[j + 1], new Map(items));
    }
    if (held_back.has(h)) for (const m of line.slice(1)) held_back.set(m, held_back.get(h));
  }
  return { flow, links, bottlenecks, held_back, converged };
}
