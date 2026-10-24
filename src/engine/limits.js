// Why the output isn't higher (port of FlowGraph._best_output / explain_limits).
import { Building as B } from "../data.js";
import { P, SINK, EPS, INF, msum, fmtNum } from "./util.js";
import { itemName } from "./model.js";
import { solveLP, toCSC, hasHighs } from "./lp.js";

const LIMIT_GAP_TOL = 1e-3;
const LIMIT_MAX_TARGETS = 12;
const getOr = (m, k, d) => { const v = m.get(k); return v === undefined ? d : v; };
const byName = (a, b) => { const x = itemName(a), y = itemName(b); return x < y ? -1 : x > y ? 1 : 0; };
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Most of each output item these buildings could make if every belt and arm could carry
 * everything (only factory speeds and what extractors / inputs give): a linear program.
 * Returns [Map item -> best, Map item -> [factory kinds that are then all needed at full speed]].
 */
export function bestOutput(g, res, extraCaps = null) {
  const prods = [...g.recipe.keys()].filter((p) => (g._isFactory(p) || g.grid.get(p).is_source) && g.live.has(p));
  const ins = [...g.grid].filter(([p, b]) => b.is_input && g.live.has(p)).map(([p]) => p);
  if (!prods.length || !hasHighs()) return [new Map(), new Map()];
  const demand = new Map(), targets = new Map();
  const madeByFactory = new Set(prods.filter((p) => g._isFactory(p)).map((p) => g.recipe.get(p).out_item));
  for (const [pos, items] of res.outputs) {
    const b = g.grid.get(pos);
    for (const [i, v] of items) {
      if (b.id === B.Coal_Power_Plant || b.id === B.Nuclear_Power_Plant || !madeByFactory.has(i)) demand.set(i, getOr(demand, i, 0) + v);
      else targets.set(i, getOr(targets, i, 0) + v);
    }
  }
  const itemSet = new Set();
  for (const p of prods) { const r = g.recipe.get(p); itemSet.add(r.out_item); for (const m of r.mats.keys()) itemSet.add(m); }
  for (const p of ins) itemSet.add(g.grid.get(p).filter);
  for (const i of targets.keys()) itemSet.add(i);
  for (const i of demand.keys()) itemSet.add(i);
  const items = [...itemSet].sort((a, b) => a - b);
  const ki = new Map(items.map((it, k) => [it, k]));
  const R = [], C = [], V = [], ub = [];
  prods.forEach((p, j) => {
    const rec = g.recipe.get(p);
    R.push(ki.get(rec.out_item)); C.push(j); V.push(rec.out_amount);
    for (const [m, a] of rec.mats) { R.push(ki.get(m)); C.push(j); V.push(-a); }
    let cap = getOr(g.rate, p, 0.0);
    if (extraCaps && extraCaps.has(p)) cap = Math.min(cap, extraCaps.get(p));
    ub.push(cap);
  });
  ins.forEach((p, j) => {
    R.push(ki.get(g.grid.get(p).filter)); C.push(prods.length + j); V.push(1.0);
    let cap = getOr(g.want, p, 0.0);
    if (extraCaps && extraCaps.has(p)) cap = Math.min(cap, extraCaps.get(p));
    ub.push(cap);
  });
  const n0 = ub.length;
  const best = new Map(), binding = new Map();
  const order = [...targets.keys()].sort((a, b) => targets.get(b) - targets.get(a)).slice(0, LIMIT_MAX_TARGETS);
  for (const t of order) {
    // A x - take >= need  (rows per item): rowLower = need, rowUpper = inf
    const need = new Float64Array(items.length);
    for (const [i, v] of demand) need[ki.get(i)] += v;
    for (const [i, v] of targets) if (i !== t) need[ki.get(i)] += v * (1 - 1e-9);
    const rr = [...R, ki.get(t)], cc = [...C, n0], vv = [...V, -1.0];
    const csc = toCSC(rr, cc, vv, n0 + 1);
    const cost = new Float64Array(n0 + 1); cost[n0] = -1.0;
    const lp = solveLP({
      numCols: n0 + 1, numRows: items.length, colCost: cost,
      colLower: new Array(n0 + 1).fill(0), colUpper: [...ub, Infinity],
      rowLower: [...need], rowUpper: new Array(items.length).fill(Infinity), ...csc,
    });
    if (!lp.ok) continue;
    best.set(t, lp.x[n0]);
    const kinds = new Map();
    // reduced cost < 0 at an upper bound = the objective would get better with more of it
    prods.forEach((p, j) => { const m = lp.dual[j]; if (m < -1e-9) { const k = itemName(g.recipe.get(p).out_item); kinds.set(k, getOr(kinds, k, 0) + -m * ub[j]); } });
    ins.forEach((p, j) => { const m = lp.dual[prods.length + j]; if (m < -1e-9) { const k = `input ${itemName(g.grid.get(p).filter)}`; kinds.set(k, getOr(kinds, k, 0) + -m * ub[prods.length + j]); } });
    binding.set(t, [...kinds].sort((a, b) => b[1] - a[1]).map(([k]) => k));
  }
  return [best, binding];
}

/** Why the output isn't higher, in a few lines: [lines, Map tile -> why it limits the output] */
export function explainLimits(g, res) {
  const lines = [], limiting = new Map();
  const [best, binding] = bestOutput(g, res);
  if (!best.size) return [lines, limiting];
  const got = new Map();
  for (const items of res.outputs.values()) for (const [i, v] of items) got.set(i, getOr(got, i, 0) + v);
  const gotOf = (i) => getOr(got, i, 0);
  let main = null, mainScore = -INF;
  for (const [i, bv] of best) { const s = (bv - gotOf(i)) / Math.max(bv, 1e-9); if (s > mainScore) { mainScore = s; main = i; } }
  for (const t of [...best.keys()].sort(byName)) {
    const bt = best.get(t), gap = bt - gotOf(t);
    if (gap > LIMIT_GAP_TOL * Math.max(1e-9, bt))
      lines.push(`${itemName(t)}: ${fmtNum(gotOf(t))}/min, these buildings could make ${fmtNum(bt)}/min (if every belt and arm could carry everything)`);
    else if (gap > 1e-6 * Math.max(1.0, bt))
      lines.push(`${itemName(t)}: ${fmtNum(gotOf(t))}/min, practically the most these buildings can make (${fmtNum(bt)}/min)`);
    else lines.push(`${itemName(t)}: ${fmtNum(gotOf(t))}/min, the most these buildings can make`);
    if ((binding.get(t) || []).length) lines.push("    to make more, it needs more: " + binding.get(t).slice(0, 6).join(", "));
  }
  // raw materials that can't all get to where they are needed
  const raw = new Map();
  for (const [p, b] of g.grid) {
    if (b.is_source && g.recipe.has(p) && g.live.has(p)) { const k = g.recipe.get(p).out_item; if (!raw.has(k)) raw.set(k, []); raw.get(k).push(p); }
    else if (b.is_input && g.live.has(p)) { if (!raw.has(b.filter)) raw.set(b.filter, []); raw.get(b.filter).push(p); }
  }
  const gives = (p) => {
    const b = g.grid.get(p);
    if (b.is_input) return [msum(b.items || new Map()), getOr(g.want, p, 0.0)];
    const rec = g.recipe.get(p);
    return [msum(res.made.get(p) || new Map()), getOr(g.rate, p, 0.0) * rec.out_amount];
  };
  const bm = best.get(main);
  const gapMain = bm - gotOf(main);
  const rows = [];
  if (gapMain > LIMIT_GAP_TOL * Math.max(1e-9, bm)) {
    for (const [item, poss] of raw) {
      const gc = poss.map(gives);
      let have = 0, can = 0, waiting = 0;
      for (const [a, c] of gc) { have += a; can += c; if (a < c * 0.99) waiting++; }
      if (!waiting) continue;
      const caps = new Map();
      for (const p of poss) { const [a] = gives(p); caps.set(p, g.grid.get(p).is_source ? a / g.recipe.get(p).out_amount : a); }
      const [b2] = bestOutput(g, res, caps);
      const loss = bm - getOr(b2, main, bm);
      if (loss > 1e-6 * Math.max(1.0, bm))
        rows.push([loss, `${itemName(item)}: ${fmtNum(have, 1)} of ${fmtNum(can, 1)}/min gets out (${waiting} of ${poss.length} wait, their belts are full): up to ${fmtNum(loss, 3)} ${itemName(main)}/min less`]);
    }
  }
  if (rows.length) {
    const allCaps = new Map();
    for (const poss of raw.values()) for (const p of poss) { const [a] = gives(p); allCaps.set(p, g.grid.get(p).is_source ? a / g.recipe.get(p).out_amount : a); }
    const [bAll] = bestOutput(g, res, allCaps);
    const bM = getOr(bAll, main, 0.0);
    if (bM - gotOf(main) > 1e-4 * Math.max(1.0, bm))
      lines.push(`With the raw materials that get out now, at most ${fmtNum(bM)} ${itemName(main)}/min: ${fmtNum(bm - bM)} is lost because raw materials can't get out, ${fmtNum(bM - gotOf(main))} between factories`);
    else lines.push(`All of the difference is raw materials that can't get out: with what gets out now ${fmtNum(gotOf(main))} ${itemName(main)}/min is the most`);
    lines.push("Raw materials that can't all get to where they're needed (each alone):");
    for (const [, r] of rows.sort((a, b) => b[0] - a[0])) lines.push("    " + r);
  }
  if (![...best].some(([t, bt]) => bt - gotOf(t) > LIMIT_GAP_TOL * Math.max(1e-9, bt))) return [lines, limiting];

  // belts / arms at full speed and factories at full speed that leave factories after them short
  const links = g.links();
  const fwd = new Map(), rev = new Map();
  for (const [a, t, it] of links) {
    if (!fwd.has(a)) fwd.set(a, []); fwd.get(a).push([t, it]);
    if (!rev.has(t)) rev.set(t, []); rev.get(t).push([a, it]);
  }
  const full = new Set([...res.held_back.keys(), ...res.bottlenecks.keys()]);
  const shortMemo = new Map();
  const shortOf = (t) => {
    if (shortMemo.has(t)) return shortMemo.get(t);
    const rec = g.recipe.get(t);
    const madeT = rec.out_amount ? msum(res.made.get(t) || new Map()) / rec.out_amount : 0.0;
    let out = new Set();
    if (madeT < getOr(g.rate, t, 0.0) * (1 - 1e-4)) {
      const feeds = new Map();
      for (const [a, it] of rev.get(t) || []) for (const i of it.keys()) { if (!feeds.has(i)) feeds.set(i, []); feeds.get(i).push(a); }
      out = new Set([...rec.mats.keys()].filter((m) => !(feeds.get(m) || []).some((a) => full.has(a))));
    }
    shortMemo.set(t, out);
    return out;
  };
  const ratio = (p) => {
    const b = g.grid.get(p);
    if (b.is_input) return msum(b.items || new Map()) / Math.max(getOr(g.want, p, 0.0), 1e-9);
    const rec = g.recipe.get(p);
    return msum(res.made.get(p) || new Map()) / Math.max(getOr(g.rate, p, 0.0) * rec.out_amount, 1e-12);
  };
  const suppliers = (p, m) => {
    const seen = new Set([p]), stack = [p], out = [], capped = [];
    while (stack.length) {
      const x = stack.pop();
      for (const [a, it] of rev.get(x) || []) {
        if (getOr(it, m, 0.0) <= EPS || seen.has(a)) continue;
        seen.add(a);
        const b = g.grid.get(a);
        if (b.is_input || (g.recipe.has(a) && (g._isFactory(a) || b.is_source))) out.push(a);
        else { if (res.bottlenecks.has(a)) capped.push(a); stack.push(a); }
      }
    }
    return [out, capped];
  };
  const argminBy = (arr, f) => { let best = null, bv = INF; for (const x of arr) { const v = f(x); if (v < bv) { bv = v; best = x; } } return best; };
  const makers = [...g.recipe.keys()].filter((p) => g._isFactory(p) && g.recipe.get(p).out_item === main);
  let cur = makers.length ? argminBy(makers, ratio) : null;
  const chain = [], visited = new Set();
  while (cur !== null && !visited.has(cur) && chain.length < 20) {
    visited.add(cur);
    if (ratio(cur) >= 1 - 1e-4) break;
    const short = [...shortOf(cur)].sort(byName);
    const rec = g.recipe.get(cur);
    const head = `${P(cur)} ${g._name(cur)} makes ${fmtNum(msum(res.made.get(cur) || new Map()), 3)} of ${fmtNum(getOr(g.rate, cur, 0.0) * rec.out_amount, 3)} ${itemName(rec.out_item)}`;
    if (!short.length) { chain.push(head + " (its output is backed up)"); break; }
    const m = short[0];
    const [sup, capped] = suppliers(cur, m);
    chain.push(head + `, short on ${itemName(m)}`);
    if (!sup.length) break;
    const low = sup.filter((q) => ratio(q) < 1 - 1e-4 && !res.held_back.has(q));
    if (!low.length) {
      const kinds = [...new Set(sup.map((q) => g._name(q)))].sort(cmpStr);
      if (sup.some((q) => res.held_back.has(q)))
        chain.push(`its ${sup.length} supplier(s) have ${itemName(m)} waiting: it can't get through` + (capped.length ? ` (full belt / arm on the way: ${P(capped[0])})` : " (it goes to other buildings first)"));
      else {
        const near = [...sup].sort((a, b) => a - b)[Math.floor(sup.length / 2)];
        chain.push(`all ${sup.length} ${kinds.join("/")} that bring it run at full speed (around ${P(near)}): more of them would help here`);
      }
      break;
    }
    cur = argminBy(low, ratio);
  }
  if (chain.length) {
    lines.push(`What limits ${itemName(main)} (follow the shortest supply):`);
    chain.forEach((c, k) => lines.push("    " + (k ? "<- " : "") + c));
  }
  const transport = new Map(), factories = new Map();
  for (const p of res.bottlenecks.keys()) {
    const b = g.grid.get(p);
    if (b.is_output) continue;
    const isFac = g._isFactory(p);
    const its = isFac ? new Set([g.recipe.get(p).out_item]) : new Set((b.items || new Map()).keys());
    const seen = new Set([p]), stack = [p], starved = new Set();
    while (stack.length) {
      const x = stack.pop();
      for (const [t, it] of fwd.get(x) || []) {
        if (t === SINK || seen.has(t) || ![...it.keys()].some((i) => its.has(i))) continue;
        seen.add(t);
        if (g._isFactory(t)) { if ([...shortOf(t)].some((i) => its.has(i))) starved.add(t); }
        else if (!g.grid.get(t).is_output) stack.push(t);
      }
    }
    if (starved.size) {
      const key = its.values().next().value;
      const tgt = isFac ? factories : transport;
      if (!tgt.has(key)) tgt.set(key, []);
      tgt.get(key).push([p, starved.size]);
    }
  }
  if (transport.size) {
    lines.push("Belts / arms at full speed that leave factories after them short:");
    for (const [item, lst] of [...transport].sort((a, b) => b[1].length - a[1].length)) {
      lst.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const where = lst.slice(0, 4).map(([p]) => P(p)).join(", ") + (lst.length > 4 ? " ..." : "");
      lines.push(`    ${itemName(item)}: ${lst.length} tile${lst.length !== 1 ? "s" : ""} (${where})`);
      for (const [p, n] of lst)
        limiting.set(p, `${P(p)} ${g._name(p)} carries ${itemName(item)} at its full speed (${fmtNum(res.bottlenecks.get(p))}/min) and ${n} factor${n !== 1 ? "ies" : "y"} after it get too little`);
    }
  }
  if (factories.size) {
    lines.push("Factories at full speed whose product is too little for what comes after them:");
    for (const [item, lst] of [...factories].sort((a, b) => (b[1].length - a[1].length) || byName(a[0], b[0]))) {
      lst.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const nAfter = Math.max(...lst.map(([, n]) => n));
      const where = lst.slice(0, 3).map(([p]) => P(p)).join(", ") + (lst.length > 3 ? " ..." : "");
      lines.push(`    ${lst.length} x ${itemName(item)} (${where}): ${nAfter}+ factories after them get too little`);
      for (const [p, n] of lst)
        limiting.set(p, `${P(p)} ${g._name(p)} runs at its max speed and ${n} factor${n !== 1 ? "ies" : "y"} after it get too little ${itemName(item)}`);
    }
  }
  return [lines, limiting];
}
