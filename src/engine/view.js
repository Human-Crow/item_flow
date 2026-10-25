// What the page draws and lists: drawing data, side lists, problems, tile details and tests.
// Texts and colours are the same as in flow_gui.py (the desktop viewer).
import { Building as B, Item } from "../data.js";
import { pk, px, py, P, SINK, INF, fmtNum, pyFixed, msum } from "./util.js";
import {
  ANY_ITEM, settings, FACTORIES, END_POINTS, PRODUCERS, LOGISTICS, SIDE_INPUTS, NO_BELT_OUTPUT, BELT_LIKE,
  COAL_FUEL_PER_MIN, NUCLEAR_FUEL_PER_MIN, itemName, idLabel, oLabel, recipeLabel, buildingsFromSave,
  copyBuilding, footprint, backRow, beltInputs, outputTile, plantArea, altUsage, altBuildings, blueprintEdges,
  isInput, guessInOut,
} from "./model.js";
import { buildAndSolve } from "./graph.js";
import { testBalancer, testSplitter, testRatio, fmtItems } from "./tests.js";

// ---------------------------------------------------------------- colours (as in flow_gui.py)
const BG = "#141519";
const TILE = { [B.Belt]: "#2c2f37", [B.Belt_Splitter]: "#3b2a52", [B.Underground_Belt_Input]: "#15384d",
  [B.Underground_Belt_Output]: "#14452f", [B.Robotic_Arm]: "#4a3618", [B.Storage]: "#3a3b40" };
const ACCENT = { [B.Belt]: "#7c808b", [B.Belt_Splitter]: "#b59be3", [B.Underground_Belt_Input]: "#6db8e0",
  [B.Underground_Belt_Output]: "#6fdba6", [B.Robotic_Arm]: "#ffcf7a", [B.Storage]: "#d0d2d8" };
const FACTORY_STYLE = ["#4a2a2a", "#e68a8a"];
const END_STYLE = ["#25304d", "#8fa2f0"];
const PRODUCER_STYLE = ["#2e3d1c", "#b7d968"];
const OTHER_TILE = "#24262c";
const DETAIL_COLOR = "#7c808b";
const IN_COLOR = "#4cd07d", OUT_COLOR = "#4ca8f0", JAM_COLOR = "#ff4d4d";
const NUCLEAR_COLOR = "#c6ff4d", COAL_COLOR = "#ff9f43";
const BOTTLENECK_COLOR = "#ffb347", LIMIT_COLOR = "#ff5fd2", HELD_COLOR = "#8a6a3a";
const LINE_DIM = 0.12;
const SHORT_NAMES = {
  [B.Workshop]: "Workshop", [B.Furnace]: "Furnace", [B.Machine_Shop]: "Machine Shop", [B.Forge]: "Forge",
  [B.Industrial_Factory]: "Industrial", [B.Manufacturer]: "Manufacturer", [B.Earth_Teleporter]: "Teleporter",
  [B.Coal_Power_Plant]: "Coal Plant", [B.Nuclear_Power_Plant]: "Nuclear Plant", [B.Extractor]: "Extractor",
  [B.Uranium_Extractor]: "U Extractor", [B.Gem_Tree]: "Gem Tree", [B.Storage]: "Storage",
  [B.Gold_Vault]: "Gold Vault", [B.Research_Lab]: "Research Lab",
};
const ITEM_COLORS = {
  [Item.Wood_Log]: "#a0703c", [Item.Wood_Plank]: "#d4a05a", [Item.Wood_Frame]: "#e8c27a",
  [Item.Copper_Ore]: "#e07b39", [Item.Copper_Ingot]: "#ff9a52", [Item.Copper_Wire]: "#ffbe7d",
  [Item.Iron_Ore]: "#8fa3b8", [Item.Iron_Ingot]: "#b9c7d6", [Item.Iron_Gear]: "#d9e2ec",
  [Item.Stone]: "#9a9a9a", [Item.Sand]: "#e3d18a", [Item.Glass]: "#9ee7f0",
  [Item.Coal]: "#3c3c3c", [Item.Wolframite]: "#7b5ea7", [Item.Uranium_Ore]: "#7fe05a",
  [ANY_ITEM]: "#9af0cf",       // imaginary "Default" item (nothing says which item it is)
};
const RAW_ORDER = ["Wood_Log", "Stone", "Iron_Ore", "Copper_Ore", "Coal", "Wolframite", "Uranium_Ore"];
const MAX_PROBLEM_LINES = 300;
const KIND = { [B.Belt]: 0, [B.Belt_Splitter]: 1, [B.Underground_Belt_Input]: 2, [B.Underground_Belt_Output]: 3,
  [B.Robotic_Arm]: 4, [B.Storage]: 5 };
const BLOCK = 9;

const hex2 = (v) => Math.trunc(v).toString(16).padStart(2, "0");
function hsvToRgb(h, s, v) {          // like Python's colorsys.hsv_to_rgb
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}
export function itemColor(i) {
  if (ITEM_COLORS[i]) return ITEM_COLORS[i];
  const [r, g, b] = hsvToRgb((i * 0.61803398875) % 1.0, 0.6, 0.95);
  return `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}`;
}
function itemOrderCmp(a, b) {
  const na = itemName(a), nb = itemName(b);
  const ra = RAW_ORDER.includes(na) ? RAW_ORDER.indexOf(na) : RAW_ORDER.length;
  const rb = RAW_ORDER.includes(nb) ? RAW_ORDER.indexOf(nb) : RAW_ORDER.length;
  return ra - rb || (na < nb ? -1 : na > nb ? 1 : 0);
}
function dim(color, amount = LINE_DIM) {
  const c = (s, k) => parseInt(s.slice(k, k + 2), 16);
  const mix = (a, z) => Math.trunc(a * (1 - amount) + z * amount);
  return `#${hex2(mix(c(color, 1), c(BG, 1)))}${hex2(mix(c(color, 3), c(BG, 3)))}${hex2(mix(c(color, 5), c(BG, 5)))}`;
}
function buildingStyle(b) {
  if (FACTORIES.has(b.id) || b.id === B.Earth_Teleporter) return FACTORY_STYLE;
  if (END_POINTS.has(b.id)) return END_STYLE;
  if (PRODUCERS.has(b.id)) return PRODUCER_STYLE;
  return [TILE[b.id] ?? OTHER_TILE, ACCENT[b.id] ?? DETAIL_COLOR];
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const byPos = (a, b) => a[0] - b[0];
const sortedKeys = (m) => [...m.keys()].sort((a, b) => a - b);
const s = (n, w) => `${n} ${w}${n !== 1 ? "s" : ""}`;

// ---------------------------------------------------------------- state
const S = { signs: new Map(), base: [], name: "", graph: null, res: null, wanted: [], flows: new Map(), guesses: [], guessOn: false, guessSet: new Map() };

/** sign text colour: stored as 0xRRGGBBAA (alpha isn't used by the game) -> "#rrggbb", null = not set */
function signColor(v) {
  if (v === undefined || v === null) return null;
  v = Number(v) >>> 0;
  return "#" + (v >>> 8).toString(16).padStart(6, "0");
}

/** a blueprint read by the worker (the SaveFile from downloadAndRead / readBlp) */
export function loadSave(save, name = "") {
  S.base = buildingsFromSave(save);
  // text of writable signs (the SaveFile's text: one string per building, "" = none)
  S.signs = new Map();
  const bs = save && save.buildings, texts = bs && bs.text;
  if (texts) for (let i = 0; i < bs.count; i++) {
    const t = texts[i];
    if (t && bs.id[i] === B.Writable_Sign && String(t).trim())
      S.signs.set(pk(bs.x[i], bs.y[i]), { text: String(t), color: signColor(bs.color ? bs.color[i] : undefined) });
  }
  S.name = (save && save.name) || name;
  S.graph = S.res = null;
  S.guesses = S.base.length ? guessInOut(S.base.map(copyBuilding)) : [];
  S.guessSet = new Map();
  return { count: S.base.length, name: S.name };
}

/** settings from the page */
function apply(st) {
  settings.BELT_SPEED = st.belt === null || st.belt === undefined || st.belt === "" ? null : Number(st.belt);
  settings.UG_MAX_DIST = Number(st.ug ?? 6);
  settings.WORLD_GEN = Number(st.gen ?? 1);
  settings.ARM_LIMIT = st.arm ?? true;
  S.guessOn = !!st.guess;
  S.guessSet = new Map((st.guess_set || []).map(([x, y, on]) => [pk(x, y), !!on]));
}
const active = (g) => (S.guessSet.has(g.arm.pos) ? S.guessSet.get(g.arm.pos) : g.likely);
function buildings() {
  const out = S.base.map(copyBuilding);
  if (S.guessOn) for (const g of S.guesses) if (active(g)) out.push(copyBuilding(g.arm));
  return out;
}

export function solve(st) {
  apply(st);
  if (!S.base.length) return { empty: true };
  const builds = buildings();
  const e = blueprintEdges(builds);
  const given = new Map((st.flows || []).map(([x, y, v]) => [pk(x, y), Number(v)]));
  const def = Number(st.default_input ?? 0);
  S.flows = new Map(builds.filter((b) => isInput(b, e)).map((b) => [b.pos, given.has(b.pos) ? given.get(b.pos) : def]));
  const [graph, res] = buildAndSolve(builds, S.flows);
  S.graph = graph; S.res = res;
  S.wanted = builds.filter((b) => b.is_input).map((b) => b.pos).sort((a, b) => a - b);
  return view();
}

// ---------------------------------------------------------------- drawing data and lists
/** a producer (extractor, ...) that nothing takes from: no belt in front, no arm behind */
function loose(p) {
  const g = S.graph;
  return PRODUCERS.has(g.grid.get(p).id) && !(g.push.get(p) || []).length && !(g.pulls.get(p) || []).length;
}
const short = (p) => { const b = S.graph.grid.get(p); return SHORT_NAMES[b.id] ?? idLabel(b).replaceAll("_", " "); };
function maxOutput(p) {
  const rec = S.graph.recipe.get(p);
  return rec ? (S.res.max_speed.get(p) || 0) * rec.out_amount : 0;
}
function outline(p, b) {
  const res = S.res;
  let o = "#000", w = 1.0;
  if (b.is_input) [o, w] = [IN_COLOR, 3];
  if (b.is_output) [o, w] = [OUT_COLOR, 3];
  if (res.held_back.has(p)) [o, w] = [HELD_COLOR, 3];
  if (res.bottlenecks.has(p)) [o, w] = [BOTTLENECK_COLOR, 3];
  if (res.limiting.has(p)) [o, w] = [LIMIT_COLOR, 4];
  if (res.jams.has(p)) [o, w] = [JAM_COLOR, 4];
  if (!LOGISTICS.has(b.id) && b.is_output && b.id !== B.Robotic_Arm && !res.jams.has(p)) [o, w] = ["#000", 1.0];
  return [o, w];
}
function blockDetails(p, b) {
  const d = { acc: buildingStyle(b)[1] };
  const [dx, dy] = [[0, -1], [-1, 0], [0, 1], [1, 0]][b.o];
  const takesBelts = (FACTORIES.has(b.id) && b.recipe) || END_POINTS.has(b.id);
  if (SIDE_INPUTS.has(b.id)) d.side = 1;
  else if (takesBelts) {
    const back = b.id === B.Earth_Teleporter ? [pk(px(p) - dx, py(p) - dy)] : beltInputs(b);
    const xs = back.map(px), ys = back.map(py);
    d.back = [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1, dx, dy];
  }
  const hasOutput = (FACTORIES.has(b.id) && b.recipe) || (PRODUCERS.has(b.id) && !NO_BELT_OUTPUT.has(b.id)) || b.id === B.Earth_Teleporter;
  if (hasOutput) { const o = outputTile(b); d.out = [px(o), py(o), dx, dy]; }
  d.name = SHORT_NAMES[b.id] ?? idLabel(b).replaceAll("_", " ");
  if (b.id === B.Writable_Sign && S.signs.has(p)) {
    const sg = S.signs.get(p);
    d.text = sg.text; d.name = "";
    if (sg.color) d.tcol = sg.color;
  }
  if (FACTORIES.has(b.id)) d.sub = b.recipe ? recipeLabel(b).replaceAll("_", " ") : "no recipe";
  else if (PRODUCERS.has(b.id) && loose(p)) d.sub = "not connected";
  else if (PRODUCERS.has(b.id)) { d.sub = itemName(b.filter).replaceAll("_", " "); d.prod = itemColor(b.filter); }
  else if (END_POINTS.has(b.id) && b.filter) d.sub = "takes " + itemName(b.filter).replaceAll("_", " ");
  const sh = S.res.boosts.get(p);
  if (sh) d.boost = sh[0] >= sh[1] ? NUCLEAR_COLOR : COAL_COLOR;
  return d;
}

function view() {
  const { graph, res } = S;
  const grid = graph.grid;
  const pal = [], pidx = new Map();
  const ci = (c) => { let k = pidx.get(c); if (k === undefined) { k = pal.length; pidx.set(c, k); pal.push(c); } return k; };
  const tiles = [];
  for (const [p, b] of grid) {
    const fp = footprint(b), xs = fp.map(px), ys = fp.map(py);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
    const [o, w] = outline(p, b);
    const num = res.made.has(p) ? msum(res.made.get(p)) : b.flow || 0;
    let kind, fill, acc, extra = 0;
    if (LOGISTICS.has(b.id)) {
      kind = KIND[b.id] ?? 6;
      fill = TILE[b.id] ?? OTHER_TILE; acc = ACCENT[b.id] ?? DETAIL_COLOR;
      if (b.id === B.Robotic_Arm) {
        const ex = {};
        if (b.filter) ex.f = itemColor(b.filter);
        const sh = res.boosts.get(p);
        if (sh) ex.boost = sh[0] >= sh[1] ? NUCLEAR_COLOR : COAL_COLOR;
        extra = Object.keys(ex).length ? ex : 0;
      }
    } else {
      kind = BLOCK;
      [fill, acc] = buildingStyle(b);
      extra = blockDetails(p, b);
    }
    const [dx, dy] = [[0, -1], [-1, 0], [0, 1], [1, 0]][b.o];
    tiles.push([px(p), py(p), x0, y0, x1, y1, kind, dx, dy, ci(fill), ci(acc), ci(o), w, r6(num), extra]);
  }
  const links = [];
  let maxFlow = 0;
  const allLinks = graph.links();
  for (const [a, b2, items] of allLinks) {
    const tot = msum(items);
    maxFlow = Math.max(maxFlow, tot);
    let ta, tb;
    if (b2 === SINK) {
      const ba = grid.get(a);
      if (ba.id !== B.Robotic_Arm) continue;
      const d = [[0, -1], [-1, 0], [0, 1], [1, 0]][ba.o];
      ta = a; tb = pk(px(a) + d[0], py(a) + d[1]);
    } else [ta, tb] = graph.link_tiles.get(`${a},${b2}`) || [a, b2];
    let main = 0, best = -Infinity;
    for (const [i, v] of items) if (v > best) { best = v; main = i; }
    links.push([px(ta) + 0.5, py(ta) + 0.5, px(tb) + 0.5, py(tb) + 0.5,
      grid.get(a).id === B.Underground_Belt_Input ? 1 : 0, ci(dim(itemColor(main))), [...items].map(([i, v]) => [i, r6(v)])]);
  }
  const areas = [];
  for (const [p, pw] of res.power) {
    const area = plantArea(grid.get(p));
    if (area && pw > 1e-9) areas.push([area[0], area[1], area[2] + 1, area[3] + 1, ci(grid.get(p).id === B.Nuclear_Power_Plant ? NUCLEAR_COLOR : COAL_COLOR)]);
  }
  const present = new Set();
  for (const [, , v] of allLinks) for (const i of v.keys()) present.add(i);
  for (const b of grid.values()) if (b.is_input) present.add(b.filter);
  const items = {};
  for (const i of [...present].sort((a, b) => a - b)) items[i] = [itemName(i), itemColor(i)];
  const guesses = S.guessOn ? S.guesses.map((g) => [g.arm.x, g.arm.y, px(g.belt), py(g.belt), g.is_input ? 1 : 0, active(g) ? 1 : 0]) : [];
  return { pal, tiles, links, max_flow: maxFlow || 1.0, areas, items, guesses, side: side(), name: S.name };
}

function addUp(groups) {
  const tot = new Map();
  for (const g of groups) for (const [i, v] of g) tot.set(i, (tot.get(i) || 0) + v);
  return new Map([...tot].filter(([, v]) => v > 1e-9));
}

function side() {
  const { graph, res } = S;
  const grid = graph.grid;
  const out = {};
  out.inputs = S.wanted.map((pos) => {
    const b = grid.get(pos);
    return [px(pos), py(pos), itemName(b.filter), itemColor(b.filter), !!b.auto_item, S.flows.get(pos) || 0, msum(res.inputs.get(pos) || new Map())];
  });
  const kinds = new Map();
  for (const pos of res.sources.keys()) {
    if (loose(pos)) continue;           // not connected: makes nothing, not listed
    const b = grid.get(pos), k = `${b.id},${b.filter}`;
    if (!kinds.has(k)) kinds.set(k, [b.id, b.filter, []]);
    kinds.get(k)[2].push(pos);
  }
  out.producers = [...kinds.values()]
    .sort((a, b) => itemOrderCmp(a[1], b[1]) || ((SHORT_NAMES[a[0]] ?? "") < (SHORT_NAMES[b[0]] ?? "") ? -1 : (SHORT_NAMES[a[0]] ?? "") > (SHORT_NAMES[b[0]] ?? "") ? 1 : 0))
    .map(([bid, item, poss]) => {
      const b = grid.get(poss[0]);
      const where = poss.length === 1 ? `${P(poss[0])} ` : `${poss.length} x `;
      const can = poss.reduce((t, p) => t + maxOutput(p), 0);
      const got = poss.reduce((t, p) => t + msum(res.sources.get(p)), 0);
      return [`${where}${SHORT_NAMES[bid] ?? idLabel(b)}`, itemColor(item), can, got];
    });
  const sumAll = (m) => [...m.values()].reduce((t, v) => t + msum(v), 0);
  const totIn = sumAll(res.inputs) + sumAll(res.sources);
  const totOut = sumAll(res.outputs);
  const arms = [...grid.values()].filter((b) => b.id === B.Robotic_Arm);
  const nIn = arms.filter((b) => b.is_input).length, nOut = arms.filter((b) => b.is_output).length;
  const nEnd = [...res.outputs.keys()].filter((p) => grid.get(p).id !== B.Robotic_Arm).length;
  let count = `${nIn} input${nIn !== 1 ? "s" : ""} → ${nOut} output${nOut !== 1 ? "s" : ""}`;
  if (nEnd) count += ` + ${nEnd} end point${nEnd !== 1 ? "s" : ""}`;
  out.total = [`in ${fmtNum(totIn)} → out ${fmtNum(totOut)}`, count];
  const outputs = addUp(res.outputs.values());
  const inputs = addUp([...res.inputs.values(), ...res.sources.values()]);
  const made = addUp([...res.made].filter(([p]) => !res.sources.has(p)).map(([, v]) => v));
  const others = new Map([...made].filter(([i]) => !outputs.has(i) && !inputs.has(i)));
  out.per_item = [["out", outputs], ["in", inputs], ["made", others]].filter(([, g]) => g.size)
    .map(([title, g]) => [title, [...g.keys()].sort(itemOrderCmp).map((i) => [itemName(i), itemColor(i), g.get(i)])]);
  out.per_output = [...res.outputs].sort(byPos).map(([pos, its]) => {
    const b = grid.get(pos);
    const name = b.id === B.Robotic_Arm ? "" : " " + (SHORT_NAMES[b.id] ?? idLabel(b));
    return `${P(pos)}${name}: ` + (its.size ? fmtItems(its) : "nothing");
  });
  // alt recipes
  const usage = altUsage(grid, res.made), counts = altBuildings(grid, graph.recipe);
  out.alts = [...usage].map(([i, [alt, std]]) => {
    const total = alt + std;
    const [nAlt, nStd] = counts.get(i) || [0, 0];
    let txt, col, exact = false;
    if (nAlt && !nStd) [txt, col, exact] = ["1", "#8fd08f", true];
    else if (nStd && !nAlt) [txt, col, exact] = ["0", "#ddd", true];
    else if (total > 1e-9) { const f = alt / total; txt = pyFixed(f, 2); col = f > 0.995 ? "#8fd08f" : f > 0.005 ? "#e0c060" : "#ddd"; }
    else [txt, col] = ["-", "#666"];
    return [itemName(i).replaceAll("_", " "), itemColor(i), txt, col, exact];
  });
  // problems (same texts as flow_gui)
  let probs = [...res.mixed].sort(byPos).map(([p, its]) => `MIXED belt into ${P(p)} ${short(p)}: ` + [...its].map(itemName).join(" + ")
    + ", so it stops (a belt into a factory can carry only one item)");
  probs.push(...[...res.jams].sort(byPos).filter(([p]) => !res.mixed.has(p)).map(([p, i]) => `JAM ${P(p)}: ${itemName(i)}`));
  const beltLimits = new Map([...res.bottlenecks].filter(([p]) => LOGISTICS.has(grid.get(p).id)));
  const costly = [...beltLimits].filter(([p]) => res.limiting.has(p)).sort(byPos);
  probs.push(...costly.map(([p, v]) => `at max speed ${P(p)} ${short(p)}: ${fmtNum(v)}/min, factories after it get too little`));
  probs.push(...[...res.backed_up].sort(byPos).map(([p, v]) => `backed up ${P(p)}: ${fmtItems(v)}`));
  probs.push(...res.warnings);
  if (!res.converged)
    probs.push("the flow keeps changing (loops / splitters never settle): numbers are long-run averages"
      + (res.balanced ? ", balanced so they add up exactly" : " (may be slightly off)"));
  const waiting = new Map();
  for (const p of res.held_back.keys()) {
    const lim = res.held_by.get(p);
    if (lim !== undefined && lim !== null) waiting.set(lim, (waiting.get(lim) || 0) + 1);
  }
  for (const p of res.bottlenecks.keys()) if (!beltLimits.has(p) && !waiting.has(p)) waiting.set(p, 0);
  const info = [];
  for (const [lim, n] of [...waiting].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    if (beltLimits.has(lim)) continue;
    const why = res.why.get(lim) ?? `${P(lim)} ${short(lim)}`;
    info.push(why + (n ? `  (${s(n, "full tile")} before it)` : ""));
  }
  const summary = [];
  if (res.jams.size) summary.push(`${res.jams.size} jam(s)`);
  if (res.limiting.size) summary.push(`${res.limiting.size} limit the output`);
  if (res.warnings.length) summary.push(`${res.warnings.length} warning(s)`);
  if (!summary.length && !probs.length) summary.push("no problems");
  out.prob_summary = [summary.join(", "), probs.length || res.limiting.size ? JAM_COLOR : "#8c8"];
  if (res.limits.length) probs = ["Why the output isn't higher:", ...res.limits, ...(probs.length ? [""] : []), ...probs];
  if (info.length) probs.push(...(probs.length ? [""] : []),
    `Where items wait (${info.length}; more arrives than gets used, the belts before it fill up):`, ...info);
  // producers that nothing takes from (a note: not counted as a problem)
  const looseOnes = [...grid.keys()].filter((p) => PRODUCERS.has(grid.get(p).id) && loose(p)).sort((a, b) => a - b);
  if (looseOnes.length) probs.push(...(probs.length ? [""] : []),
    `Not connected (${looseOnes.length}; no belt in front and no arm taking from it, so it makes nothing):`,
    ...looseOnes.map((p) => `${P(p)} ${short(p)}`));
  if (probs.length > MAX_PROBLEM_LINES)
    probs = [...probs.slice(0, MAX_PROBLEM_LINES), `... and ${probs.length - MAX_PROBLEM_LINES} more (tap tiles for details)`];
  out.problems = [probs, res.jams.size || beltLimits.size || res.warnings.length || res.backed_up.size ? JAM_COLOR : "#d8c08a"];
  out.n_problems = res.jams.size + res.limiting.size + res.warnings.length + res.backed_up.size;
  return out;
}

/** details of a tapped tile, plus what a guessed marker there is */
export function tileInfo(x, y) {
  const { graph, res } = S;
  const result = { text: "", guess: null };
  const at = pk(x, y);
  let guess = null;
  if (S.guessOn) {
    guess = S.guesses.find((g) => g.arm.pos === at) || null;
    if (!guess) {
      const mine = S.guesses.filter((g) => g.belt === at), on = mine.filter(active);
      guess = mine.length === 1 ? mine[0] : on.length === 1 ? on[0] : null;
    }
  }
  if (guess) result.guess = [guess.arm.x, guess.arm.y, guess.is_input ? 1 : 0, active(guess) ? 1 : 0];
  if (!graph || !res) { result.text = P(at); return result; }
  const anchor = graph.occ.get(at);
  if (anchor === undefined) {
    result.text = guess && guess.arm.pos === at && !active(guess)
      ? `${P(at)}  possible ${guess.is_input ? "input" : "output"} (guessed, switched off)` : `${P(at)}  empty`;
    return result;
  }
  const b = graph.grid.get(anchor);
  const p = anchor;
  const lines = [`${P(p)}  ${idLabel(b)}`, `facing ${oLabel(b)}` + (b.tier ? `, tier ${b.tier}` : "")];
  if (b.id === B.Writable_Sign) {
    const sg = S.signs.get(p);
    lines.push(sg ? "text: " + sg.text : "no text");
    if (sg && sg.color) lines.push("text colour: " + sg.color);
  }
  const rec = graph.recipe.get(p);
  if (FACTORIES.has(b.id)) lines.push("recipe: " + (b.recipe ? recipeLabel(b) : "none (takes nothing)"));
  if (rec && (FACTORIES.has(b.id) || b.id === B.Earth_Teleporter)) {
    const crafts = res.max_speed.get(p) || 0;
    const made = msum(res.made.get(p) || new Map());
    const done = rec.out_amount ? made / rec.out_amount : 0;
    lines.push("uses per craft: " + [...rec.mats].map(([i, a]) => `${a} ${itemName(i)}`).join(", "));
    lines.push(`makes ${itemName(rec.out_item)}: ${fmtNum(made, 3)} / min (max ${fmtNum(crafts * rec.out_amount, 3)})`);
    lines.push("uses / min: " + [...rec.mats].map(([i, a]) => `${itemName(i)} ${fmtNum(done * a, 3)}`).join(", "));
  }
  if (PRODUCERS.has(b.id) && loose(p)) lines.push("not connected: nothing takes from it, so it makes nothing");
  else if (PRODUCERS.has(b.id)) {
    const made = msum(res.made.get(p) || new Map());
    lines.push(`makes ${itemName(b.filter)}: ${fmtNum(made, 3)} / min (max ${fmtNum(maxOutput(p), 3)})` + (NO_BELT_OUTPUT.has(b.id) ? " (arms only)" : ""));
  }
  if (END_POINTS.has(b.id) && b.id !== B.Earth_Teleporter) lines.push("end point, takes " + (b.filter ? itemName(b.filter) : "everything"));
  if (res.power.has(p)) {
    const need = b.id === B.Coal_Power_Plant ? COAL_FUEL_PER_MIN : NUCLEAR_FUEL_PER_MIN;
    lines.push(`power ${fmtNum(res.power.get(p) * 100, 1)}% (needs ${fmtNum(need)} / min)`);
  }
  const sh = res.boosts.get(p);
  if (sh) {
    const parts = [];
    if (sh[0]) parts.push(`nuclear ${fmtNum(sh[0] * 100, 1)}%`);
    if (sh[1]) parts.push(`coal ${fmtNum(sh[1] * 100, 1)}%`);
    lines.push("boosted: " + parts.join(", ") + " of the time");
  }
  if (b.id === B.Robotic_Arm) {
    const cap = res.arm_speed.has(p) ? res.arm_speed.get(p) : INF;
    if (b.is_input || b.is_output) lines.push(`filter: ${itemName(b.filter)} (marker, no speed limit)`);
    else lines.push(`filter: ${itemName(b.filter)}, max ` + (cap === INF ? "unlimited" : `${fmtNum(cap, 3)}/min`));
    if (b.is_input) lines.push("INPUT" + (b.auto_item ? " (no filter: brings what is needed)" : ""));
    if (b.is_output) lines.push("OUTPUT");
  }
  if (b.items && b.items.size) {
    lines.push("through: " + fmtItems(b.items));
    lines.push(`total: ${fmtNum(b.flow || 0)}`);
  }
  if (res.mixed.has(p)) lines.push("STOPPED: one belt brings " + [...res.mixed.get(p)].map(itemName).join(" + "));
  else if (res.jams.has(p)) lines.push(`JAMMED by ${itemName(res.jams.get(p))}`);
  const after = (t, sep) => { const k = t.indexOf(sep); return k < 0 ? t : t.slice(k + sep.length); };
  if (res.limiting.has(p)) lines.push("LIMITS THE OUTPUT: " + after(res.limiting.get(p), ") "));
  if (res.bottlenecks.has(p)) {
    if (LOGISTICS.has(b.id)) lines.push(`AT MAX SPEED (${fmtNum(res.bottlenecks.get(p))}/min)`);
    else if (res.why.has(p)) lines.push(res.why.get(p).split(" ").slice(2).join(" ") || res.why.get(p));
  } else if (res.why.has(p) && after(res.why.get(p), ") ") !== short(p)) lines.push(after(res.why.get(p), ") "));
  if (res.held_back.has(p)) {
    const lim = res.held_by.get(p);
    const cap = BELT_LIKE.has(b.id) ? settings.BELT_SPEED : null;
    lines.push(`items wait here: ${fmtNum(res.held_back.get(p), 3)}/min moves on` + (cap ? ` (could be ${fmtNum(cap)})` : "") + ", because further on");
    if (lim !== undefined && lim !== null) lines.push("  " + (res.why.get(lim) ?? `${P(lim)} ${short(lim)}`));
  }
  if (res.backed_up.has(p)) lines.push("backed up: " + fmtItems(res.backed_up.get(p)));
  if (guess && guess.arm.pos === anchor && active(guess)) lines.push("guessed marker");
  result.text = lines.join("\n");
  return result;
}

/** balancer / splitter / ratio test on the blueprint (with the switched-on guessed markers) */
export function runTest(kind, st, progress) {
  apply(st);
  const test = { balancer: testBalancer, splitter: testSplitter, ratio: testRatio }[kind];
  return test(buildings(), { progress }).map((c) => ({
    name: c.name, passed: c.passed, optional: c.optional, lines: c.lines,
    amounts: [...c.amounts].map(([p, v]) => [px(p), py(p), v]),
  }));
}
