// Balancer / splitter / ratio tests (port of item_flow.test_balancer / test_splitter / test_ratio).
import { Item, Building as B } from "../data.js";
import { P, SINK, msum, fmtNum, seededRandom, Fraction, lcmBig } from "./util.js";
import { settings, blueprintEdges, isInput, isOutput, copyBuilding, itemName, TEST_ITEM, ANY_ITEM } from "./model.js";
import { buildAndSolve } from "./graph.js";

export const BAL_RANDOM_RUNS = 6;
export const SPLIT_RUNS = 3;
const BAL_TOL = 0.01;
const BAL_SPLIT_PART = 0.5;
const BAL_SPEED = 480.0;
const RATIO_PART = 0.25;
const RATIO_MAX_DEN = 256;
const RATIO_MAX_COMMON = 1000;
const EXACT_MAX_COMMON = 10n ** 9n;
const EXACT_SHARE_DEN = 12;
const EXACT_MAX_NODES = 600;
const FRAC_TOL = 1e-7;
const RATIO_TOL = 1e-4;

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
export function fmtItems(items) {
  if (!items || !items.size) return "nothing";
  return [...items].sort((a, b) => a[0] - b[0]).map(([i, v]) => `${itemName(i)} ${fmtNum(v)}`).join(", ");
}

/** one check: {name, passed, lines, amounts: [[pos, amount]], optional} */
const check = (name, passed, lines, amounts = new Map(), optional = false) => ({ name, passed, lines, amounts, optional });

class TestBench {
  constructor(buildings, runs, progress) {
    this.buildings = buildings;
    this.error = "";
    this.ins = []; this.outs = [];
    if (!buildings.length) { this.error = "! nothing loaded"; return; }
    const base = buildings.map(copyBuilding);
    const e = blueprintEdges(base);
    this.ins = base.filter((b) => isInput(b, e)).map((b) => b.pos).sort((a, b) => a - b);
    this.outs = base.filter((b) => isOutput(b, e) && b.id === B.Robotic_Arm).map((b) => b.pos).sort((a, b) => a - b);
    if (!this.ins.length || !this.outs.length)
      this.error = `! found ${this.ins.length} input and ${this.outs.length} output arms, need at least one of each (arms on the edge as markers)`;
    this.n = this.ins.length; this.m = this.outs.length;
    this.speed = settings.BELT_SPEED ? Number(settings.BELT_SPEED) : BAL_SPEED;
    const insSet = new Set(this.ins);
    const first = base.find((b) => insSet.has(b.pos) && b.filter)?.filter || ANY_ITEM;
    this.same = new Map(this.ins.map((p) => [p, first]));
    this.total = runs; this.done = 0; this.progress = progress;
    this.graph = null;
  }
  run(amounts, items = null) {
    items = items || this.same;
    const builds = this.buildings.map(copyBuilding);
    for (const b of builds) if (items.has(b.pos)) { b.filter = items.get(b.pos); b.auto_item = false; }
    const old = settings.ARM_LIMIT;
    settings.ARM_LIMIT = false;
    let res;
    try { [this.graph, res] = buildAndSolve(builds, amounts); } finally { settings.ARM_LIMIT = old; }
    this.done++;
    if (this.progress) this.progress(this.done, this.total);
    return res;
  }
  got(res, p, item = null) {
    const its = res.outputs.get(p) || new Map();
    return item === null ? msum(its) : its.get(item) || 0;
  }
  problems(res) {
    const out = [...res.jams].sort((a, b) => a[0] - b[0]).map(([p, i]) => `! jam at ${P(p)} (${itemName(i)})`);
    for (const [p, its] of [...res.backed_up].sort((a, b) => a[0] - b[0])) if (its.size) out.push(`! left over at ${P(p)}: ${fmtItems(its)}`);
    return out;
  }
  equalRuns(name, cases, head) {
    const lines = [head];
    let ok = true, failAt = new Map();
    for (const amounts of cases) {
      const res = this.run(amounts);
      const want = Math.min(msum(amounts), this.m * this.speed) / this.m;
      const vals = this.outs.map((q) => this.got(res, q));
      const good = vals.every((v) => Math.abs(v - want) <= BAL_TOL);
      const bad = this.problems(res);
      if (!good || bad.length) { ok = false; if (!failAt.size) failAt = amounts; }
      lines.push(`${good && !bad.length ? "" : "! "}in ` + this.ins.map((p) => fmtNum(amounts.get(p), 1)).join(" ")
        + "  ->  out " + vals.map((v) => fmtNum(v, 2)).join(" ") + `  (want ${fmtNum(want, 2)})`);
      for (const b of bad) lines.push("   " + b);
    }
    return check(name, ok, lines, failAt);
  }
  fullLoad(name, each, head) {
    const amounts = new Map(this.ins.map((p) => [p, each]));
    const res = this.run(amounts);
    const want = this.n * each / this.m;
    const lines = [head + (settings.BELT_SPEED ? "" : ` (belt speed is empty, tested with ${fmtNum(this.speed)})`)];
    let ok = true;
    for (const p of this.ins) {
      const took = msum(res.inputs.get(p) || new Map());
      if (took < each - BAL_TOL) { ok = false; lines.push(`! input ${P(p)} only takes ${fmtNum(took, 2)} of ${fmtNum(each, 2)}`); }
    }
    const vals = this.outs.map((q) => this.got(res, q));
    const good = vals.every((v) => Math.abs(v - want) <= BAL_TOL);
    ok = ok && good;
    lines.push(`${good ? "" : "! "}outputs: ` + vals.map((v) => fmtNum(v, 2)).join(" ") + `  (want ${fmtNum(want, 2)} each)`);
    const bad = this.problems(res);
    lines.push(...bad, ...res.warnings.slice(0, 5).map((w) => `note: ${w}`));
    if (ok && !bad.length) lines.push(`all ${fmtNum(this.n * each, 2)} goes in, no jams`);
    return check(name, ok && !bad.length, lines, amounts);
  }
}

function sample(rng, arr, k) {      // k different elements
  const a = [...arr];
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}
const randint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** test a balancer: [checks] */
export function testBalancer(buildings, { runs = BAL_RANDOM_RUNS, seed = null, progress = null } = {}) {
  const t = new TestBench(buildings, 2 + runs, progress);
  if (t.error) return [check("Balancer", false, [t.error])];
  const rng = seededRandom(seed);
  const { ins, outs, n, m, speed } = t;
  const checks = [];
  // 1. split: every input its own imaginary item, all at once
  const items = new Map(ins.map((p, k) => [p, TEST_ITEM + k + 1]));
  const a = round(speed * BAL_SPLIT_PART * Math.min(n, m) / n, 4);
  let amounts = new Map(ins.map((p) => [p, a]));
  const res = t.run(amounts, items);
  const lines = [`each input ${fmtNum(a)} of its own item, every output should get ${fmtNum(a / m)} of each`];
  let ok = true;
  lines.push("outputs: " + outs.map(P).join("  "));
  for (const p of ins) {
    const vals = outs.map((q) => t.got(res, q, items.get(p)));
    const good = vals.every((v) => Math.abs(v - a / m) <= BAL_TOL);
    ok = ok && good;
    lines.push(`${good ? "" : "! "}input ${P(p)} ${itemName(items.get(p))}: ` + vals.map((v) => fmtNum(v, 2)).join(" / "));
  }
  const bad = t.problems(res);
  checks.push(check("Split per input", ok && !bad.length, [...lines, ...bad], !ok || bad.length ? amounts : new Map()));
  // 2. random amounts (all inputs carry the same item)
  const cases = [];
  for (let r = 0; r < runs; r++) {
    amounts = new Map(ins.map((p) => [p, round(rng() * speed, 1)]));
    if (r % 2 === 1 && n > 1) for (const p of sample(rng, ins, randint(rng, 1, n - 1))) amounts.set(p, 0.0);
    const cap = speed * Math.min(n, m);
    if (msum(amounts) > cap) { const k = cap / msum(amounts); amounts = new Map([...amounts].map(([p, v]) => [p, Math.floor(v * k * 10) / 10])); }
    cases.push(amounts);
  }
  checks.push(t.equalRuns("Random amounts", cases, `${runs} runs, every output should get (total in) / ${m}`));
  // 3. full belt speed
  const each = speed * Math.min(n, m) / n;
  checks.push(t.fullLoad("Full belt speed", each, n <= m ? `every input at ${fmtNum(speed)}`
    : `${n} inputs -> ${m} output${m !== 1 ? "s" : ""}: total ${fmtNum(speed * m)} = ${fmtNum(speed)} x min(${n}, ${m}), so ${fmtNum(each, 2)} per input`));
  return checks;
}

/** test a splitter (equal inputs): [checks] */
export function testSplitter(buildings, { runs = SPLIT_RUNS, seed = null, progress = null } = {}) {
  const t = new TestBench(buildings, 1 + runs, progress);
  if (t.error) return [check("Splitter", false, [t.error])];
  const rng = seededRandom(seed);
  const { n, m, speed } = t;
  const each = speed * Math.min(n, m) / n;
  const checks = [t.fullLoad("Full load", each, `${n} input${n !== 1 ? "s" : ""} -> ${m} output${m !== 1 ? "s" : ""}: total ${fmtNum(speed * Math.min(n, m))} = ${fmtNum(speed)} x min(${n}, ${m}), so ${fmtNum(each, 2)} per input`)];
  const cases = [];
  for (let r = 0; r < runs; r++) { const v = round((0.05 + 0.9 * rng()) * each, 1); cases.push(new Map(t.ins.map((p) => [p, v]))); }
  checks.push(t.equalRuns("Lower amounts", cases, `${runs} runs with the same amount on every input, every output should get (total in) / ${m}`));
  return checks;
}

/**
 * The exact part of the total input each output gets, as fractions (471/1159 too): the simple
 * shares every building passes on are read from the solved flow, and the network is solved again
 * with exact fractions. null when that isn't possible.
 */
export function exactParts(graph, amounts, outs) {
  const outOf = new Map();
  for (const [a, b, its] of graph.links()) {
    const v = msum(its);
    if (v > 1e-9) { if (!outOf.has(a)) outOf.set(a, []); outOf.get(a).push([b, v]); }
  }
  const total = msum(amounts);
  if (!total || outOf.size > EXACT_MAX_NODES) return null;
  const nodes = [...outOf.keys()].sort((a, b) => a - b);
  const idx = new Map(nodes.map((p, k) => [p, k]));
  const share = new Map();
  for (const [a, outsA] of outOf) {
    const o = outsA.reduce((s, [, v]) => s + v, 0);
    const sh = outsA.map(([b, v]) => [b, Fraction.fromNumber(v / o).limitDenominator(EXACT_SHARE_DEN)]);
    let sum = new Fraction(0);
    for (const [, s] of sh) sum = sum.add(s);
    if (sh.some(([, s], j) => Math.abs(s.valueOf() - outsA[j][1] / o) > 1e-6) || !sum.eq(1)) return null;
    if (sh.some(([b]) => b !== SINK && !idx.has(b))) return null;
    share.set(a, sh);
  }
  const n = nodes.length;
  const rows = Array.from({ length: n }, () => Array.from({ length: n + 1 }, () => new Fraction(0)));
  for (const x of nodes) {
    const i = idx.get(x);
    rows[i][i] = rows[i][i].add(1);
    rows[i][n] = Fraction.fromString(String(amounts.get(x) ?? 0));
  }
  for (const [a, sh] of share) for (const [b, s] of sh) if (b !== SINK) { const r = rows[idx.get(b)]; r[idx.get(a)] = r[idx.get(a)].sub(s); }
  for (let c = 0; c < n; c++) {
    let piv = -1;
    for (let r = c; r < n; r++) if (!rows[r][c].isZero()) { piv = r; break; }
    if (piv < 0) return null;
    [rows[c], rows[piv]] = [rows[piv], rows[c]];
    const inv = new Fraction(1).div(rows[c][c]);
    rows[c] = rows[c].map((v) => (v.isZero() ? v : v.mul(inv)));
    for (let r = 0; r < n; r++) if (r !== c && !rows[r][c].isZero()) {
      const f = rows[r][c];
      rows[r] = rows[r].map((v, j) => (rows[c][j].isZero() ? v : v.sub(f.mul(rows[c][j]))));
    }
  }
  const T = new Map(nodes.map((p) => [p, rows[idx.get(p)][n]]));
  const tot = Fraction.fromString(String(total));
  const parts = outs.map((q) => {
    let s = new Fraction(0);
    for (const [b, f] of share.get(q) || []) if (b === SINK) s = s.add(f);
    return s.mul(T.get(q) || new Fraction(0)).div(tot);
  });
  const measured = outs.map((q) => (outOf.get(q) || []).filter(([b]) => b === SINK).reduce((s, [, v]) => s + v, 0) / total);
  if (parts.some((p, j) => Math.abs(p.toNumber() - measured[j]) > 1e-6)) return null;
  return parts;
}

/** 0.142857 -> "1/7 = 0.1429", 0.5 -> "1/2 = 0.5", 1 -> "1", 0.3183 -> "0.3183" */
export function fmtFrac(v) {
  const f = Fraction.fromNumber(v).limitDenominator(RATIO_MAX_DEN);
  if (Math.abs(f.valueOf() - v) > FRAC_TOL || f.d === 1n) return fmtNum(v);
  return `${f.n}/${f.d} = ${fmtNum(v)}`;
}
/** parts over one common denominator: [[texts], "3 : 1 : 2"] (exact: Fractions from exactParts) */
export function fmtFracs(values, exact = null) {
  let fr;
  if (exact !== null) { fr = exact; values = fr.map((f) => f.toNumber()); }
  else {
    fr = values.map((v) => Fraction.fromNumber(v).limitDenominator(RATIO_MAX_DEN));
    if (!fr.length || fr.some((f, j) => Math.abs(f.valueOf() - values[j]) > FRAC_TOL)) return [values.map(fmtFrac), ""];
  }
  if (!fr.length) return [[], ""];
  let d = 1n;
  for (const f of fr) d = lcmBig(d, f.d);
  if (d > (exact !== null ? EXACT_MAX_COMMON : BigInt(RATIO_MAX_COMMON)))
    return [fr.map((f, j) => (f.d > 1n ? `${f.n}/${f.d} = ${fmtNum(values[j])}` : fmtNum(values[j]))), ""];
  const nums = fr.map((f) => f.n * (d / f.d));
  if (d === 1n) return [values.map((v) => fmtNum(v)), ""];
  return [nums.map((k, j) => `${k}/${d} = ${fmtNum(values[j])}`), nums.join(" : ")];
}
/** outputs that get exactly the same part, grouped in the order they first appear */
export function sameRatioGroups(values, exact = null) {
  const groups = [];
  values.forEach((v, k) => {
    for (const g of groups) {
      const j = g[0];
      const same = exact !== null ? exact[j].eq(exact[k]) : Math.abs(values[j] - v) <= FRAC_TOL;
      if (same) { g.push(k); return; }
    }
    groups.push([k]);
  });
  return groups;
}

/** test a ratio splitter: [checks] */
export function testRatio(buildings, { runs = BAL_RANDOM_RUNS, seed = null, progress = null } = {}) {
  const t = new TestBench(buildings, 2 + runs, progress);
  if (t.error) return [check("Ratio", false, [t.error])];
  const rng = seededRandom(seed);
  const { ins, outs, n, speed } = t;
  const checks = [];
  const measure = (amounts) => {
    const res = t.run(amounts);
    const total = msum(amounts);
    const vals = outs.map((q) => t.got(res, q));
    const bad = t.problems(res);
    const sv = vals.reduce((s, v) => s + v, 0);
    if (Math.abs(sv - total) > BAL_TOL) bad.push(`! total out ${fmtNum(sv, 2)} is not total in ${fmtNum(total, 2)}`);
    return [res, vals.map((v) => (total ? v / total : 0)), bad];
  };
  // 1. ratio with equal inputs
  let each = round(speed * RATIO_PART, 4);
  let amounts = new Map(ins.map((p) => [p, each]));
  let [, ratio, bad] = measure(amounts);
  const exact = t.graph && !bad.length ? exactParts(t.graph, amounts, outs) : null;
  let lines = [`every input ${fmtNum(each)}, part of the total input per output` + (exact !== null ? " (exact):" : ":")];
  const [parts, asRatio] = fmtFracs(ratio, exact);
  outs.forEach((q, j) => lines.push(`output ${P(q)}: ${parts[j]}`));
  if (asRatio && outs.length > 1) lines.push(`ratio ${asRatio}`);
  const groups = sameRatioGroups(ratio, exact);
  if (groups.length > 1 && groups.some((g) => g.length > 1)) {
    const sums = groups.map((g) => g.reduce((s, k) => s + ratio[k], 0));
    const exSums = exact !== null ? groups.map((g) => g.reduce((s, k) => s.add(exact[k]), new Fraction(0))) : null;
    const [gParts, gRatio] = fmtFracs(sums, exSums);
    lines.push("outputs with the same part, together:");
    groups.forEach((g, j) => {
      const who = g.length === 1 ? `output ${P(outs[g[0]])}` : `${g.length} outputs ` + g.map((k) => P(outs[k])).join(" ");
      lines.push(`  ${who}: ${gParts[j]}`);
    });
    if (gRatio) lines.push(`  ratio ${gRatio}`);
  }
  lines.push(...bad);
  if (!bad.length) lines.push(`sum ${fmtFrac(ratio.reduce((s, v) => s + v, 0))}, nothing lost or jammed`);
  checks.push(check("Ratio", !bad.length, lines, bad.length ? amounts : new Map()));
  // 2. uneven inputs: the same ratio? (optional feature)
  lines = [`${runs} runs with random amounts, same ratio as above?`];
  let lost = false, changed = false, failAt = new Map();
  for (let r = 0; r < runs; r++) {
    amounts = new Map(ins.map((p) => [p, round(rng() * speed, 1)]));
    if (r % 2 === 1 && n > 1) for (const p of sample(rng, ins, randint(rng, 1, n - 1))) amounts.set(p, 0.0);
    const busiest = Math.max(...ratio.map((x) => x * msum(amounts)));
    if (busiest > speed) { const k = speed / busiest * 0.95; amounts = new Map([...amounts].map(([p, v]) => [p, round(v * k, 1)])); }
    let [res, gotR, bd] = measure(amounts);
    let same = gotR.every((x, j) => Math.abs(x - ratio[j]) <= RATIO_TOL);
    if (bd.length && !res.jams.size && outs.some((q) => t.got(res, q) >= speed - BAL_TOL)) {
      bd = bd.map((b) => b.replace("! ", "! (output belt full) "));
      same = false;
    } else lost = lost || bd.length > 0;
    changed = changed || !same;
    if ((bd.length || !same) && !failAt.size) failAt = amounts;
    lines.push(`${same && !bd.length ? "" : "! "}in ` + ins.map((p) => fmtNum(amounts.get(p), 1)).join(" ") + "  ->  " + gotR.map((v) => fmtNum(v, 4)).join(" | "));
    for (const b of bd) lines.push("   " + b);
  }
  if (lost) checks.push(check("Uneven inputs", false, lines, failAt));
  else if (changed) { lines.push("note: the ratio changes with uneven inputs, so it only works with equal inputs"); checks.push(check("Uneven inputs", false, lines, failAt, true)); }
  else { lines.push("the ratio stays the same with uneven inputs"); checks.push(check("Uneven inputs", true, lines)); }
  // 3. full belt speed (as far as the busiest output allows)
  const top = ratio.length ? Math.max(...ratio) : 0;
  each = top * n <= 1 + 1e-9 ? speed : speed / (top * n);
  let head = `every input at ${fmtNum(each, 2)}`;
  if (each < speed) {
    const j = ratio.indexOf(top);
    head += ` (output ${P(outs[j])} gets ${fmtFracs(ratio, exact)[0][j]} of the total and is then full)`;
  }
  if (!settings.BELT_SPEED) head += ` (belt speed is empty, tested with ${fmtNum(speed)})`;
  amounts = new Map(ins.map((p) => [p, each]));
  let res;
  [res, , bad] = measure(amounts);
  lines = [head];
  let ok = true;
  for (const p of ins) {
    const took = msum(res.inputs.get(p) || new Map());
    if (took < each - BAL_TOL) { ok = false; lines.push(`! input ${P(p)} only takes ${fmtNum(took, 2)} of ${fmtNum(each, 2)}`); }
  }
  const vals = outs.map((q) => t.got(res, q));
  const sv = vals.reduce((s, v) => s + v, 0);
  const gotR = vals.map((v) => (sv ? v / sv : 0));
  const same = gotR.every((x, j) => Math.abs(x - ratio[j]) <= RATIO_TOL);
  ok = ok && same;
  lines.push(`${same ? "" : "! "}outputs: ` + vals.map((v) => fmtNum(v, 2)).join(" ") + "  (" + fmtFracs(gotR, same ? exact : null)[0].join(" | ") + ")");
  lines.push(...bad, ...res.warnings.slice(0, 5).map((w) => `note: ${w}`));
  if (ok && !bad.length) lines.push(`all ${fmtNum(n * each, 2)} goes in, same ratio, no clogging`);
  checks.push(check("Full belt speed", ok && !bad.length, lines, amounts));
  return checks;
}
