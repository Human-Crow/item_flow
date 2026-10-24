// Buildings, recipes, speeds and the rules for input / output arms.
import { Building as B, Item, Recipe, RECIPE_NAME, ITEM_NAME, BUILDING_NAME, ORIENTATION_NAME,
  TIER_CORRECTION, RECIPE_DATA } from "../data.js";
import { pk, px, py, padd, DIRS, sides, INF } from "./util.js";

// ---------------------------------------------------------------- settings (changed by the page)
export const settings = {
  UG_MAX_DIST: 6,              // underground belt reach (4 base, 5/6 with tech)
  ARM_LIMIT: true,             // false = arms move any amount (ignore their speed)
  BELT_SPEED: 480,             // max a belt tile can carry, null = unlimited
  WORLD_GEN: 1,                // 1 or 2 (iOS Gen 2.0): extractors are faster on Gen 2
  EXPLAIN_LIMITS: true,        // work out why the output isn't higher (a few linear programs)
};

export const ARM_SECONDS = 4.0;
export const ARM_TIER_FACTORS = { 1: 1, 2: 2, 3: 4, 4: 6 };      // -> 15, 30, 60, 90 per minute
export const ARM_SPEED = { 1: null, 2: null, 3: null, 4: null }; // fixed speed per tier (overrides)
export const SPLITTER_ACCEPTS_SIDES = false;
export const DEFAULT_ITEM = Item.Iron_Ore;
export const EXTRACTOR_ITEM = Item.Iron_Ore;
export const EXTRACTOR_ITEMS = new Set([Item.Iron_Ore, Item.Copper_Ore, Item.Stone, Item.Coal, Item.Wood_Log, Item.Wolframite]);
export const TIER_FACTORS = { 1: [1, 1], 2: [1.5, 2], 3: [2, 4], 4: [3, 8], 5: [4, 10] };   // [normal, Gen 2 extractor]
export const TIERED = new Set([B.Forge, B.Furnace, B.Industrial_Factory, B.Machine_Shop, B.Manufacturer, B.Workshop, B.Extractor]);
export const EXTRACTOR_SECONDS = { 1: 8.0, 2: 4.0 };
export const URANIUM_SECONDS = { 1: 6.0, 2: 1.2 };
export const COAL_FUEL_PER_MIN = 10.0;
export const NUCLEAR_FUEL_PER_MIN = 0.5;
export const COAL_BOOST = 1.2;
export const NUCLEAR_BOOST = { 1: 1.4, 2: 1.6 };
export const PLANT_AREAS = { "2,2": [12, 12], "3,4": [21, 22], "4,3": [22, 21] };
export const POWER_ROUNDS_UNSETTLED = 3;
export const POWER_MAX_ROUNDS = 30;

/** building size [width across, depth front-to-back]; not listed = 1 tile */
export const SIZES = {
  [B.Workshop]: [1, 1], [B.Furnace]: [1, 1], [B.Machine_Shop]: [2, 2], [B.Forge]: [2, 2],
  [B.Coal_Power_Plant]: [2, 2], [B.Industrial_Factory]: [3, 3], [B.Earth_Teleporter]: [3, 3],
  [B.Manufacturer]: [4, 4], [B.Nuclear_Power_Plant]: [3, 4], [B.Gold_Vault]: [3, 3], [B.Research_Lab]: [3, 3],
};
/** buildings that make items from a recipe (belt in at the back, belt out front-middle) */
export const FACTORIES = new Set([B.Workshop, B.Furnace, B.Machine_Shop, B.Industrial_Factory, B.Forge, B.Manufacturer]);
/** buildings where items end: which item they take (0 = any) */
export const END_POINTS = new Map([
  [B.Earth_Teleporter, Item.Matter_Duplicator], [B.Coal_Power_Plant, Item.Coal],
  [B.Nuclear_Power_Plant, Item.Nuclear_Fuel_Cell], [B.Gold_Vault, 0], [B.Research_Lab, 0],
]);
/** end points with a belt input in the middle of every side */
export const SIDE_INPUTS = new Set([B.Gold_Vault, B.Research_Lab]);
/** buildings that make items on their own */
export const PRODUCERS = new Map([[B.Extractor, EXTRACTOR_ITEM], [B.Uranium_Extractor, Item.Uranium_Ore], [B.Gem_Tree, Item.Gem_Apple]]);
export const NO_BELT_OUTPUT = new Set([B.Gem_Tree]);
export const LOGISTICS = new Set([B.Belt, B.Belt_Splitter, B.Underground_Belt_Input, B.Underground_Belt_Output, B.Robotic_Arm, B.Storage]);
export const BELT_LIKE = new Set([B.Belt, B.Belt_Splitter, B.Underground_Belt_Input, B.Underground_Belt_Output, B.Storage]);
export const CHAIN_LIKE = new Set([B.Belt, B.Belt_Splitter, B.Underground_Belt_Input, B.Underground_Belt_Output]);
export const TEST_ITEM = 1_000_000;      // balancer test: imaginary items I1, I2, ...

// ---------------------------------------------------------------- names
export function itemName(i) {
  if (i === 0) return "any";
  if (i > TEST_ITEM) return `I${i - TEST_ITEM}`;
  return ITEM_NAME[i] ?? String(i);
}
export const buildingName = (id) => BUILDING_NAME[id] ?? String(id);
export const recipeName = (r) => (r ? RECIPE_NAME[r] ?? String(r) : "");
export const orientationName = (o) => ORIENTATION_NAME[o] ?? String(o);

// ---------------------------------------------------------------- buildings
/**
 * One building, with what the flow engine adds to it.
 * pos: position key; items: Map item -> amount through it.
 */
export function makeBuilding(id, x, y, o = 0, tier = 0, recipe = 0, filter = 0) {
  return {
    id, x, y, o, tier, recipe, filter, pos: pk(x, y),
    is_input: false, is_output: false, is_source: false, auto_item: false,
    flow: null, items: new Map(),
  };
}
export function copyBuilding(b) {
  return makeBuilding(b.id, b.x, b.y, b.o, b.tier, b.recipe, b.filter);
}
export const dirOf = (b) => DIRS[b.o];
export const frontOf = (b) => { const d = DIRS[b.o]; return padd(b.pos, d[0], d[1]); };
export const backOf = (b) => { const d = DIRS[b.o]; return padd(b.pos, -d[0], -d[1]); };
export const idLabel = (b) => buildingName(b.id);
export const oLabel = (b) => orientationName(b.o);
export const recipeLabel = (b) => recipeName(b.recipe);

/** arm filter check: filter 0 takes everything; an output arm on the edge takes everything */
export function takes(b, item) {
  return b.filter === 0 || b.filter === item || (b.is_output && b.id === B.Robotic_Arm);
}

/**
 * The worker's SaveFile (downloadAndRead / readBlp) -> buildings.
 * Orientation is already converted by the worker; tier is stored 0-based (+1 for buildings that
 * have tiers); rec_fil is the filter for robotic arms and the recipe for everything else.
 */
export function buildingsFromSave(save) {
  const b = save && save.buildings;
  const out = [];
  if (!b) return out;
  const known = new Set(Object.values(B));
  for (let i = 0; i < b.count; i++) {
    const id = b.id[i];
    if (!known.has(id)) continue;                  // a building this version doesn't know
    const rf = Math.max(0, b.rec_fil[i]);
    if (id === B.Writable_Sign) { out.push(makeBuilding(id, b.x[i], b.y[i], b.o[i])); continue; }
    const isArm = id === B.Robotic_Arm;
    const recipe = isArm ? 0 : rf, filter = isArm ? rf : 0;
    const corr = TIER_CORRECTION[recipe || id] ?? TIER_CORRECTION[id] ?? 0;
    out.push(makeBuilding(id, b.x[i], b.y[i], b.o[i], b.tier[i] + corr, recipe, filter));
  }
  return out;
}

function rightOf(d) { return [-d[1], d[0]]; }

/** all tiles a building covers (x, y is the middle; even size: the one closer to the back-right) */
export function footprint(b) {
  const [w, dep] = SIZES[b.id] ?? [1, 1];
  if (w === 1 && dep === 1) return [b.pos];
  const d = DIRS[b.o], r = rightOf(d), left = [-r[0], -r[1]];
  const a0 = -Math.floor((dep - 1) / 2), c0 = -Math.floor((w - 1) / 2);
  const out = [];
  for (let a = a0; a < a0 + dep; a++)
    for (let c = c0; c < c0 + w; c++) out.push(pk(b.x + a * d[0] + c * left[0], b.y + a * d[1] + c * left[1]));
  return out;
}
/** tiles along the back edge (where belts can feed a factory) */
export function backRow(b) {
  const [w, dep] = SIZES[b.id] ?? [1, 1];
  const d = DIRS[b.o], r = rightOf(d), left = [-r[0], -r[1]];
  const a = -Math.floor((dep - 1) / 2), c0 = -Math.floor((w - 1) / 2);
  const out = [];
  for (let c = c0; c < c0 + w; c++) out.push(pk(b.x + a * d[0] + c * left[0], b.y + a * d[1] + c * left[1]));
  return out;
}
/** front row, middle: where a factory puts items on a belt */
export function outputTile(b) {
  const [, dep] = SIZES[b.id] ?? [1, 1];
  const d = DIRS[b.o];
  const a = dep - 1 - Math.floor((dep - 1) / 2);
  return pk(b.x + a * d[0], b.y + a * d[1]);
}

// ---------------------------------------------------------------- recipes and speeds
/** {out_item, out_amount, seconds, mats: Map item -> amount} */
export function recipeInfo(item, variant) {
  const [out, seconds, , mats] = RECIPE_DATA[`${item}|${variant}`];
  return { out_item: Item[item], out_amount: out, seconds, mats: new Map(Object.entries(mats).map(([m, a]) => [Item[m], a])) };
}
export function recipeOf(b) {
  if (FACTORIES.has(b.id)) {
    if (!b.recipe) return null;
    const name = RECIPE_NAME[b.recipe];
    if (!name) return null;
    const variant = name.endsWith("_ALT") ? "ALT" : "STD";
    const item = name.endsWith("_ALT") || name.endsWith("_STD") ? name.slice(0, -4) : name;
    return RECIPE_DATA[`${item}|${variant}`] ? recipeInfo(item, variant) : null;
  }
  if (b.id === B.Extractor) return { out_item: EXTRACTOR_ITEM, out_amount: 1, seconds: EXTRACTOR_SECONDS[settings.WORLD_GEN], mats: new Map() };
  if (b.id === B.Uranium_Extractor) return { out_item: Item.Uranium_Ore, out_amount: 1, seconds: URANIUM_SECONDS[settings.WORLD_GEN], mats: new Map() };
  if (b.id === B.Gem_Tree) return recipeInfo("Gem_Apple", "STD");
  if (b.id === B.Earth_Teleporter) return recipeInfo("Earth_Token", "STD");
  return null;
}
export const ALT_ITEMS = Object.keys(RECIPE_DATA).filter((k) => k.endsWith("|ALT")).map((k) => Item[k.split("|")[0]])
  .sort((a, b) => (itemName(a) < itemName(b) ? -1 : itemName(a) > itemName(b) ? 1 : 0));
export function usesAlt(b) {
  return FACTORIES.has(b.id) && !!b.recipe && (RECIPE_NAME[b.recipe] ?? "").endsWith("_ALT");
}
/** per item with an alt recipe: [made with alt, made with std] per minute */
export function altUsage(grid, made) {
  const usage = new Map(ALT_ITEMS.map((i) => [i, [0, 0]]));
  for (const [pos, items] of made) {
    const b = grid.get(pos);
    if (!FACTORIES.has(b.id)) continue;
    for (const [i, v] of items) if (usage.has(i)) usage.get(i)[usesAlt(b) ? 0 : 1] += v;
  }
  return usage;
}
/** per item with an alt recipe: [buildings set to alt, buildings set to std] */
export function altBuildings(grid, recipes) {
  const counts = new Map(ALT_ITEMS.map((i) => [i, [0, 0]]));
  for (const [pos, rec] of recipes) {
    const b = grid.get(pos);
    if (FACTORIES.has(b.id) && counts.has(rec.out_item)) counts.get(rec.out_item)[usesAlt(b) ? 0 : 1] += 1;
  }
  return counts;
}
export function tierFactor(b) {
  if (!TIERED.has(b.id) || b.tier <= 0) return 1.0;
  const [normal, gen2] = TIER_FACTORS[Math.min(b.tier, 5)];
  return b.id === B.Extractor && settings.WORLD_GEN === 2 ? gen2 : normal;
}
/** items per minute of one building, rounded to whole game ticks (60 per second) */
export function speed(seconds, factor = 1.0, boost = 1.0, output = 1.0) {
  const ticks = seconds / (factor * boost) * 60;
  const efficiency = ticks / Math.ceil(ticks);
  return 60 / seconds * factor * output * boost * efficiency;
}
export function boostedSpeed(seconds, factor, shares) {
  const [n, c] = shares;
  return n * speed(seconds, factor, NUCLEAR_BOOST[settings.WORLD_GEN]) + c * speed(seconds, factor, COAL_BOOST)
    + (1 - n - c) * speed(seconds, factor);
}
export function armSpeed(b, shares = [0, 0]) {
  const tier = Math.min(Math.max(b.tier, 1), 4);
  const fixed = ARM_SPEED[tier];
  if (fixed !== null && fixed !== undefined) return fixed;
  if (!settings.ARM_LIMIT) return INF;
  return boostedSpeed(ARM_SECONDS, ARM_TIER_FACTORS[tier], shares);
}
export function craftsPerMin(b, rec, shares = [0, 0]) {
  const f = tierFactor(b), [n, c] = shares;
  const base = speed(rec.seconds, f);
  return n * speed(rec.seconds, f, NUCLEAR_BOOST[settings.WORLD_GEN]) + c * speed(rec.seconds, f, COAL_BOOST) + (1 - n - c) * base;
}
export function productionRate(b) {
  const rec = recipeOf(b);
  return rec ? craftsPerMin(b, rec) * rec.out_amount : 0.0;
}
/** boosted square of a power plant [x0, y0, x1, y1] inclusive, or null */
export function plantArea(b) {
  if (b.id !== B.Coal_Power_Plant && b.id !== B.Nuclear_Power_Plant) return null;
  const t = footprint(b);
  const xs = t.map(px), ys = t.map(py);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
  const [aw, ah] = PLANT_AREAS[`${w},${h}`];
  const lx = Math.floor((aw - w) / 2), ty = Math.floor((ah - h) / 2);
  return [x0 - lx, y0 - ty, x0 - lx + aw - 1, y0 - ty + ah - 1];
}

// ---------------------------------------------------------------- input / output arms
export function blueprintEdges(builds) {
  let minX = INF, maxX = -INF, minY = INF, maxY = -INF;
  for (const b of builds) for (const t of footprint(b)) {
    const x = px(t), y = py(t);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}
// Orientation: 0 North, 1 West, 2 South, 3 East
export function isInput(arm, e) {
  if (arm.id !== B.Robotic_Arm) return false;
  switch (arm.o) {
    case 0: return arm.y === e.maxY;
    case 2: return arm.y === e.minY;
    case 3: return arm.x === e.minX;
    case 1: return arm.x === e.maxX;
  }
  return false;
}
export function isOutput(arm, e) {
  if (arm.id !== B.Robotic_Arm) return false;
  switch (arm.o) {
    case 0: return arm.y === e.minY;
    case 2: return arm.y === e.maxY;
    case 3: return arm.x === e.maxX;
    case 1: return arm.x === e.minX;
  }
  return false;
}
/** mark input / output arms, producers and end points; inFlows: Map pos -> amount */
export function setInOut(buildings, e, inFlows) {
  for (const b of buildings) {
    if (isInput(b, e)) {
      b.is_input = true;
      if (b.filter === 0 || b.auto_item) { b.filter = DEFAULT_ITEM; b.auto_item = true; }
      b.flow = inFlows.get(b.pos) ?? 0.0;
      b.items = new Map([[b.filter, b.flow]]);
    } else if (isOutput(b, e)) {
      b.is_output = true;
    }
    if (PRODUCERS.has(b.id)) {
      b.is_source = true;
      b.filter = PRODUCERS.get(b.id);
      if (b.id === B.Extractor) b.auto_item = true;
      b.flow = productionRate(b);
      b.items = new Map([[b.filter, b.flow]]);
    } else if (END_POINTS.has(b.id)) {
      b.is_output = true;
      b.filter = END_POINTS.get(b.id);
    }
  }
}

// ---------------------------------------------------------------- guessing in / out belts
/**
 * Belts on the outer edge where items could come in or go out, each with a pretend marker arm
 * just outside it. Returns [{arm, belt, is_input, likely}] (likely = false: switched off at first).
 */
export function guessInOut(buildings) {
  if (!buildings.length) return [];
  const e = blueprintEdges(buildings);
  const outside = (k) => { const x = px(k), y = py(k); return !(e.minX <= x && x <= e.maxX && e.minY <= y && y <= e.maxY); };
  const at = new Map();
  for (const b of buildings) for (const t of footprint(b)) at.set(t, b);
  const feeds = (b, p) => {
    if (b.id === B.Belt || b.id === B.Underground_Belt_Output || b.id === B.Robotic_Arm) return frontOf(b) === p;
    if (b.id === B.Belt_Splitter) {
      if (frontOf(b) === p) return true;
      return sides(DIRS[b.o]).some((s) => padd(b.pos, s[0], s[1]) === p);
    }
    return false;
  };
  const orient = (d) => DIRS.findIndex((x) => x[0] === d[0] && x[1] === d[1]);
  const arm = (k, facing) => makeBuilding(B.Robotic_Arm, px(k), py(k), orient(facing), 1);
  const found = [], used = new Set();
  const put = (g) => {
    const k = g.arm.pos;
    if (!used.has(k) && !at.has(k)) { used.add(k); found.push(g); }
  };
  for (const b of buildings) {
    if (![B.Belt, B.Belt_Splitter, B.Underground_Belt_Input, B.Underground_Belt_Output].includes(b.id)) continue;
    const d = DIRS[b.o], sd = sides(d);
    const takesFrom = [[-d[0], -d[1]], ...(b.id === B.Belt ? sd : [])];
    if (b.id !== B.Underground_Belt_Output) {
      const outer = takesFrom.filter((t) => outside(padd(b.pos, t[0], t[1])));
      if (outer.length) {
        const fed = takesFrom.some((t) => { const n = at.get(padd(b.pos, t[0], t[1])); return n && n !== b && feeds(n, b.pos); });
        const t = outer[0];
        put({ arm: arm(padd(b.pos, t[0], t[1]), [-t[0], -t[1]]), belt: b.pos, is_input: true, likely: !fed });
      }
    }
    const front = frontOf(b);
    if ((b.id === B.Belt || b.id === B.Underground_Belt_Output || b.id === B.Belt_Splitter) && outside(front)) {
      put({ arm: arm(front, d), belt: b.pos, is_input: false, likely: true });
    } else if (b.id === B.Belt && !at.has(front)) {
      const outer = [d, ...sd].filter((t) => outside(padd(b.pos, t[0], t[1])));
      if (outer.length) put({ arm: arm(padd(b.pos, outer[0][0], outer[0][1]), outer[0]), belt: b.pos, is_input: false, likely: true });
    }
    if (b.id === B.Belt_Splitter) {
      for (const s of sd) if (outside(padd(b.pos, s[0], s[1]))) put({ arm: arm(padd(b.pos, s[0], s[1]), s), belt: b.pos, is_input: false, likely: false });
    }
  }
  return found;
}
