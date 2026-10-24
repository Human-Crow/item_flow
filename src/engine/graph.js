// The flow graph: which tile passes items to which, and how much flows (port of item_flow.FlowGraph).
import { Building as B, Item } from "../data.js";
import { pk, px, py, padd, P, SINK, DIRS, sides, EPS, INF, Heap, msum, clean, fmtNum } from "./util.js";
import {
  settings, FACTORIES, END_POINTS, SIDE_INPUTS, PRODUCERS, LOGISTICS, BELT_LIKE, CHAIN_LIKE, EXTRACTOR_ITEMS,
  EXTRACTOR_ITEM, DEFAULT_ITEM, SPLITTER_ACCEPTS_SIDES, COAL_FUEL_PER_MIN, NUCLEAR_FUEL_PER_MIN,
  POWER_MAX_ROUNDS, POWER_ROUNDS_UNSETTLED, footprint, backRow, outputTile, recipeOf, craftsPerMin, armSpeed,
  plantArea, takes, frontOf, backOf, itemName, idLabel,
} from "./model.js";
import { simulate } from "./simulate.js";
import { explainLimits } from "./limits.js";

const GUESS_REPAIR = true;
const GUESS_REPAIR_TRIES = 40;
const DIRECT_VOTE = 1000;
const PROPAGATE_EPS = 1e-10;
const PROPAGATE_BUDGET = 2000;

/** split `total` as evenly as possible, nobody above its cap */
export function waterfill(total, caps) {
  const n = caps.length, out = new Array(n).fill(0);
  let left = total, open = [...Array(n).keys()];
  while (open.length && left > EPS) {
    const share = left / open.length;
    const tight = open.filter((i) => caps[i] - out[i] <= share + EPS);
    if (!tight.length) { for (const i of open) out[i] += share; break; }
    for (const i of tight) { left -= caps[i] - out[i]; out[i] = caps[i]; }
    const t = new Set(tight);
    open = open.filter((i) => !t.has(i));
  }
  return out;
}

const getOr = (m, k, d) => { const v = m.get(k); return v === undefined ? d : v; };
const listOf = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = []); return v; };
const setOf = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = new Set()); return v; };
function setsUnion(a, b) { const s = new Set(a); for (const x of b) s.add(x); return s; }
function isSubset(a, b) { for (const x of a) if (!b.has(x)) return false; return true; }
const byName = (a, b) => { const x = itemName(a), y = itemName(b); return x < y ? -1 : x > y ? 1 : 0; };

export class FlowGraph {
  /** buildings: [{id, x, y, o, tier, recipe, filter, pos, is_input, ...}] (after setInOut) */
  constructor(buildings) {
    this.warnings_early = [];
    this.grid = new Map();
    for (const b of buildings) this.grid.set(b.pos, b);
    this.occ = new Map();
    for (const b of buildings) for (const t of footprint(b)) {
      if (this.occ.has(t) && this.occ.get(t) !== b.pos) this.warnings_early.push(`${idLabel(b)} at ${P(b.pos)} overlaps another building at ${P(t)}`);
      this.occ.set(t, b.pos);
    }
    this.link_tiles = new Map();     // "from,to" -> [from tile, to tile]
    this.push = new Map();           // tile -> tiles it pushes into
    this.pulls = new Map();          // tile -> arms taking from it
    this.dead = new Set();
    this.limit = new Map();
    this.in_limit = new Map();
    this.warnings = [...this.warnings_early];
    this.flow = new Map();
    this.live = new Set();
    this._rank = new Map(); this._rank_for = null;
    this._sim_links = null;
    this._balanced = null;
    this._sim_state = null;
    this._jam_state = null;
    this._repaired = false;
    this._pre_flow = null;
    this._sim_quick = false;
    this._chains_for = [null, new Map()];
    this.want = new Map();
    for (const b of buildings) if (b.is_input) this.want.set(b.pos, b.flow ?? 0.0);
    this.recipe = new Map();
    for (const b of buildings) { const r = recipeOf(b); if (r) this.recipe.set(b.pos, r); }
    this.shares = new Map();
    this.rate = new Map();
    this.arm_rate = new Map();
    this.tele_factory = new Set();
    this.connected = new Set();
    for (const b of buildings) if (b.id === B.Earth_Teleporter && this.recipe.has(b.pos)) { this.tele_factory.add(b.pos); b.is_output = false; }
    this._updateSpeeds();
    this._build();
    this.mixed = new Map();
    this._inferInputs();
  }

  // ---------------------------------------------------------------- graph
  _accepts(target, source, byArm) {
    const anchor = this.occ.get(target);
    if (anchor === undefined) return false;
    const t = this.grid.get(anchor);
    if (t.id === B.Robotic_Arm) return false;
    if (FACTORIES.has(t.id) || END_POINTS.has(t.id)) {
      if (FACTORIES.has(t.id) && !t.recipe) { this.warnings.push(`${idLabel(t)} at ${P(anchor)} has no recipe, takes nothing`); return false; }
      if (byArm) return true;
      if (SIDE_INPUTS.has(t.id)) {
        const ox = px(target) - t.x, oy = py(target) - t.y;
        return Math.abs(ox) + Math.abs(oy) === 1 && source === padd(target, ox, oy);
      }
      const d = DIRS[t.o];
      if (t.id === B.Earth_Teleporter) {
        const mid = padd(t.pos, -d[0], -d[1]);
        return target === mid && source === padd(mid, -d[0], -d[1]);
      }
      return backRow(t).includes(target) && source === padd(target, -d[0], -d[1]);
    }
    if (!LOGISTICS.has(t.id)) return false;
    if (byArm) {
      if (t.id === B.Storage || this.connected.has(anchor)) return true;
      this.warnings.push(`arm at ${P(source)} can't drop onto ${idLabel(t)} ${P(anchor)}: it isn't connected to anything else`);
      return false;
    }
    if (t.id === B.Underground_Belt_Output) return false;
    if (t.id === B.Underground_Belt_Input || t.id === B.Storage) return source === backOf(t);
    if (t.id === B.Belt_Splitter && !SPLITTER_ACCEPTS_SIDES) return source === backOf(t);
    return source !== frontOf(t);
  }
  _ugPair(b) {
    const d = DIRS[b.o];
    let p = b.pos;
    for (let i = 0; i <= settings.UG_MAX_DIST; i++) {
      p = padd(p, d[0], d[1]);
      const t = this.grid.get(p);
      if (t && t.id === B.Underground_Belt_Output && t.o === b.o) return p;
    }
    return null;
  }
  _target(n, fromTile, toTile, byArm) {
    if (!this._accepts(toTile, fromTile, byArm)) return null;
    const t = this.occ.get(toTile);
    this.link_tiles.set(`${n},${t}`, [fromTile, toTile]);
    return t;
  }
  _build() {
    this.connected = new Set();
    const loneUg = [];
    // arms last (stable): whether a belt takes from an arm depends on its belt connections
    const order = [...this.grid.values()];
    const arms = order.filter((b) => b.id === B.Robotic_Arm), rest = order.filter((b) => b.id !== B.Robotic_Arm);
    let firstArm = true;
    for (const b of [...rest, ...arms]) {
      const p = b.pos;
      if (b.id === B.Robotic_Arm && firstArm) { firstArm = false; this._findConnected(); }
      let outs = [];
      if (b.id === B.Belt || b.id === B.Underground_Belt_Output || b.id === B.Storage || b.id === B.Extractor || b.id === B.Uranium_Extractor) {
        const t = this._target(p, p, frontOf(b), false);
        outs = t !== null ? [t] : [];
      } else if (b.id === B.Underground_Belt_Input) {
        const pair = this._ugPair(b);
        if (pair !== null) { outs = [pair]; this.link_tiles.set(`${p},${pair}`, [p, pair]); } else loneUg.push(p);
      } else if (b.id === B.Belt_Splitter) {
        const d = DIRS[b.o];
        for (const c of [frontOf(b), ...sides(d).map((s) => padd(p, s[0], s[1]))]) {
          const t = this._target(p, p, c, false);
          if (t !== null && !outs.includes(t)) outs.push(t);
        }
      } else if (b.id === B.Robotic_Arm) {
        if (b.is_output) outs = [SINK];
        else { const t = this._target(p, p, frontOf(b), true); outs = t !== null ? [t] : []; }
        if (!b.is_input) {
          const srcPos = this.occ.get(backOf(b));
          const src = srcPos !== undefined ? this.grid.get(srcPos) : undefined;
          if (srcPos !== undefined && src && src.id !== B.Robotic_Arm && (LOGISTICS.has(src.id) || PRODUCERS.has(src.id) || this._isFactory(srcPos))) {
            listOf(this.pulls, srcPos).push(p);
            this.link_tiles.set(`${srcPos},${p}`, [backOf(b), p]);
          }
        }
      } else if (b.is_output) outs = [SINK];
      else if (this._isFactory(p)) {
        const o = outputTile(b), d = DIRS[b.o];
        const t = this._target(p, o, padd(o, d[0], d[1]), false);
        outs = t !== null ? [t] : [];
      } else if (PRODUCERS.has(b.id)) outs = [];
      else continue;
      this.push.set(p, outs);
    }
    if (firstArm) this._findConnected();
    for (const p of loneUg) if (!(this.pulls.get(p) || []).length)
      this.warnings.push(`underground input ${P(p)} has no output within reach (${settings.UG_MAX_DIST} tiles in between) and no arm takes from it`);
  }
  _findConnected() {
    for (const [n, outs] of this.push) {
      if (this.grid.get(n).id === B.Robotic_Arm) continue;
      for (const t of outs) if (t !== SINK) { this.connected.add(t); this.connected.add(n); }
    }
  }

  // ---------------------------------------------------------------- input arms without a filter
  _next(n) {
    const out = [];
    for (const t of this.push.get(n) || []) if (t !== SINK) out.push(t);
    for (const a of this.pulls.get(n) || []) out.push(a);
    return out;
  }
  _isEnd(n) { const b = this.grid.get(n); return this._isFactory(n) || END_POINTS.has(b.id) || b.is_output; }
  /** items a building at the end of a belt can use (null: anything) */
  _needs(n) {
    const b = this.grid.get(n);
    if (this._isFactory(n)) return new Set(this.recipe.get(n).mats.keys());
    if (END_POINTS.has(b.id) && END_POINTS.get(b.id)) return new Set([END_POINTS.get(b.id)]);
    if (b.id === B.Earth_Teleporter) return new Set([Item.Matter_Duplicator]);
    return null;
  }
  _skipLine(start, nxt, cache, lines) {
    const walked = [], seen = new Set();
    let n = start, group;
    for (;;) {
      if (cache.has(n)) { group = cache.get(n); break; }
      const b = this.grid.get(n);
      if (this._isEnd(n) || b.id === B.Robotic_Arm || seen.has(n)) { group = [n, walked.length ? walked[walked.length - 1] : null]; break; }
      seen.add(n);
      const outs = nxt(n);
      if (outs.length !== 1) { group = [n, walked.length ? walked[walked.length - 1] : null]; break; }
      walked.push(n);
      n = outs[0];
    }
    const gk = `${group[0]},${group[1]}`;
    let line = lines.get(gk);
    if (!line) lines.set(gk, line = new Set());
    for (const t of walked) { cache.set(t, group); line.add(t); }
    return [line, group[0]];
  }
  _downstream(start) {
    const outs = this._next(start);
    if (outs.length === 1) {
      const [line, key] = this._skipLine(outs[0], (n) => this._next(n), this._skip_down, this._lines_down);
      if (key !== null) {
        let hit = this._down_cache.get(key);
        if (!hit) { hit = this._downstreamFrom([[key, null]]); this._down_cache.set(key, hit); }
        return [hit[0], setsUnion(hit[1], line)];
      }
    }
    return this._downstreamFrom(outs.map((t) => [t, null]));
  }
  _downstreamFrom(start) {
    const ends = new Map(), tiles = new Set(), best = new Map(), stack = [...start];
    while (stack.length) {
      let [n, allowed] = stack.pop();
      const b = this.grid.get(n);
      if (b.id === B.Robotic_Arm && b.filter && !b.is_output)
        allowed = allowed === null ? new Set([b.filter]) : new Set([...allowed].filter((i) => i === b.filter));
      const has = best.has(n), seen = has ? best.get(n) : new Set();
      if (has && (seen === null || (allowed !== null && isSubset(allowed, seen)))) continue;
      best.set(n, allowed === null || seen === null ? null : setsUnion(allowed, seen));
      if (this._isEnd(n)) {
        const old = ends.has(n) ? ends.get(n) : new Set();
        ends.set(n, allowed === null || old === null ? null : setsUnion(allowed, old));
        continue;
      }
      tiles.add(n);
      for (const t of this._next(n)) stack.push([t, allowed]);
    }
    return [ends, tiles];
  }
  _beltsFrom(pos) {
    const pushNext = (n) => (this.push.get(n) || []).filter((t) => t !== SINK);
    const firsts = pushNext(pos);
    let line = new Set(), key = null;
    if (firsts.length === 1) {
      [line, key] = this._skipLine(firsts[0], pushNext, this._skip_net, this._lines_net);
      if (key !== null && this._net_cache.has(key)) return setsUnion(this._net_cache.get(key), line);
    }
    const net = new Set(), stack = key !== null ? [key] : [...firsts];
    while (stack.length) {
      const n = stack.pop();
      if (net.has(n) || this._isEnd(n) || this.grid.get(n).id === B.Robotic_Arm) continue;
      net.add(n);
      for (const t of pushNext(n)) stack.push(t);
    }
    if (key !== null) this._net_cache.set(key, net);
    return setsUnion(net, line);
  }
  _inferInputs() {
    const autos = [...this.grid.values()].filter((b) => (b.is_input || b.is_source) && b.auto_item).map((b) => b.pos).sort((a, b) => a - b);
    this._down_cache = new Map(); this._net_cache = new Map();
    this._skip_down = new Map(); this._lines_down = new Map();
    this._skip_net = new Map(); this._lines_net = new Map();
    if (!autos.length) return;
    const onTile = new Map();
    const sources = [...this.grid.values()].filter((b) => (b.is_input || b.is_source) && !b.auto_item).map((b) => [b.pos, b.filter]);
    for (const [n, rec] of this.recipe) if (this._isFactory(n)) sources.push([n, rec.out_item]);
    for (const [src, item] of sources) {
      const stack = this._next(src);
      while (stack.length) {
        const n = stack.pop(), b = this.grid.get(n), on = setOf(onTile, n);
        if (on.has(item)) continue;
        if (b.id === B.Robotic_Arm && b.filter && b.filter !== item && !b.is_output) continue;
        on.add(item);
        if (!this._isEnd(n)) stack.push(...this._next(n));
      }
    }
    const reach = new Map();
    for (const pos of autos) {
      const [ends] = this._downstream(pos);
      let votes = new Map();
      for (const [e, allowed] of ends) {
        const need = this._needs(e);
        if (need !== null) for (const i of need) if (allowed === null || allowed.has(i)) votes.set(i, getOr(votes, i, 0) + (allowed === null ? DIRECT_VOTE : 1));
      }
      const net = this._beltsFrom(pos);
      if (this.grid.get(pos).id === B.Extractor) votes = new Map([...votes].filter(([i]) => EXTRACTOR_ITEMS.has(i)));
      reach.set(pos, [ends, net, votes]);
    }
    const assign = (pos, choice) => {
      const b = this.grid.get(pos);
      b.filter = choice;
      if (b.is_source) {
        this.recipe.set(pos, { ...this.recipe.get(pos), out_item: choice });
        b.items = new Map([[choice, b.flow ?? 0.0]]);
      } else b.items = new Map([[choice, getOr(this.want, pos, 0.0)]]);
      const [ends, net] = reach.get(pos);
      for (const t of net) setOf(onTile, t).add(choice);
      for (const [e, allowed] of ends) if (allowed === null || allowed.has(choice)) setOf(onTile, e).add(choice);
    };
    const judge = (pos) => {
      const [ends, net, votes] = reach.get(pos);
      const already = new Set();
      for (const t of net) for (const i of onTile.get(t) || []) already.add(i);
      const isExt = this.grid.get(pos).id === B.Extractor;
      if (already.size === 1) {
        const only = [...already][0];
        if ((!votes.size || votes.has(only)) && (!isExt || EXTRACTOR_ITEMS.has(only))) return [only, true];
      }
      if (!votes.size) return [isExt ? EXTRACTOR_ITEM : DEFAULT_ITEM, true];
      const missing = new Map();
      for (const [e, allowed] of ends) {
        const need = this._needs(e);
        if (need !== null) for (const i of need) if ((allowed === null || allowed.has(i)) && !(onTile.get(e) || new Set()).has(i)) missing.set(i, getOr(missing, i, 0) + 1);
      }
      const ranked = [...votes.keys()].sort((a, b) => (votes.get(b) - votes.get(a)) || (getOr(missing, b, 0) - getOr(missing, a, 0)) || byName(a, b));
      const sure = ranked.length === 1 || votes.get(ranked[0]) > votes.get(ranked[1]);
      return [ranked[0], sure];
    };
    let todo = [...autos];
    while (todo.length) {
      const decided = [];
      for (const pos of todo) { const [c, sure] = judge(pos); if (sure && c !== null) decided.push([pos, c]); }
      if (decided.length) {
        for (const [pos, c] of decided) assign(pos, c);
        const done = new Set(decided.map((d) => d[0]));
        todo = todo.filter((p) => !done.has(p));
        continue;
      }
      const pos = todo.shift();
      const [c] = judge(pos);
      assign(pos, c !== null ? c : (this.grid.get(pos).id === B.Extractor ? EXTRACTOR_ITEM : DEFAULT_ITEM));
    }
    this._autos = [...autos];
  }
  _flowProblems(flow) {
    const problems = [], stopped = new Set();
    for (const [t, outs] of this.push) {
      if (!BELT_LIKE.has(this.grid.get(t).id)) continue;
      const kinds = new Set();
      for (const [i, v] of flow.get(t) || []) if (v > EPS) kinds.add(i);
      if (!kinds.size) continue;
      for (const f of outs) {
        if (f === SINK) continue;
        const need = this._needs(f);
        if (need !== null && (kinds.size > 1 || [...kinds].some((i) => !need.has(i)))) { problems.push([t, f]); stopped.add(f); }
      }
    }
    let fed = 0;
    for (const [n, items] of flow) {
      if (n === SINK || stopped.has(n) || !this._isEnd(n)) continue;
      const need = this._needs(n);
      if (need && need.size) for (const [i, v] of items) if (v > EPS && need.has(i)) fed++;
    }
    return [problems, fed];
  }
  _repairGuesses() {
    const autos = new Set(this._autos || []);
    if (!autos.size) return;
    const rev = new Map();
    for (const n of this.grid.keys()) for (const t of this._next(n)) listOf(rev, t).push(n);
    const upCache = new Map();
    const autosInto = (t) => {
      const got = upCache.get(t);
      if (got) return got;
      const seen = new Set([t]), stack = [t], out = [];
      while (stack.length) {
        const x = stack.pop();
        for (const n of rev.get(x) || []) {
          if (seen.has(n)) continue;
          seen.add(n);
          if (autos.has(n)) out.push(n);
          else if (!(this._isFactory(n) || this.grid.get(n).is_input || this.grid.get(n).is_source)) stack.push(n);
        }
      }
      upCache.set(t, out);
      return out;
    };
    const setItem = (pos, item) => {
      const b = this.grid.get(pos);
      b.filter = item;
      if (b.is_source) { this.recipe.set(pos, { ...this.recipe.get(pos), out_item: item }); b.items = new Map([[item, b.flow ?? 0.0]]); }
      else b.items = new Map([[item, getOr(this.want, pos, 0.0)]]);
    };
    const live = this._live();
    let [flow] = this._propagate(live);
    let [problems, fed] = this._flowProblems(flow);
    const tried = new Set();
    let tries = 0;
    while (problems.length && tries < GUESS_REPAIR_TRIES) {
      let improved = false;
      for (const [t, f] of problems) {
        const kinds = new Set();
        for (const [i, v] of flow.get(t) || []) if (v > EPS) kinds.add(i);
        const need = this._needs(f) || new Set();
        for (const c of [...need].sort(byName)) {
          const movers = autosInto(t).filter((s) => { const g = this.grid.get(s); return kinds.has(g.filter) && g.filter !== c && (g.id !== B.Extractor || EXTRACTOR_ITEMS.has(c)); });
          const key = `${[...movers].sort((a, b) => a - b).join(",")}|${c}`;
          if (!movers.length || tried.has(key) || tries >= GUESS_REPAIR_TRIES) continue;
          tried.add(key);
          tries++;
          const old = new Map(movers.map((s) => [s, this.grid.get(s).filter]));
          for (const s of movers) setItem(s, c);
          const [flow2] = this._propagate(live);
          const [problems2, fed2] = this._flowProblems(flow2);
          if (problems2.length < problems.length && fed2 >= fed) { flow = flow2; problems = problems2; fed = fed2; improved = true; break; }
          for (const [s, it] of old) setItem(s, it);
        }
        if (improved) break;
      }
      if (!improved) break;
    }
    this._pre_flow = [live, flow];
  }
  /** tiles (not jammed) that can still reach an output */
  _live() {
    const rev = new Map();
    for (const [n, outs] of this.push) for (const t of outs) listOf(rev, t).push(n);
    for (const [n, arms] of this.pulls) for (const a of arms) listOf(rev, a).push(n);
    const live = new Set([SINK]), stack = [SINK];
    while (stack.length) for (const prev of rev.get(stack.pop()) || []) if (!live.has(prev) && !this.dead.has(prev)) { live.add(prev); stack.push(prev); }
    return live;
  }

  // ---------------------------------------------------------------- capacities
  _updateSpeeds() {
    for (const [pos, rec] of this.recipe) this.rate.set(pos, craftsPerMin(this.grid.get(pos), rec, getOr(this.shares, pos, [0, 0])));
    this.arm_rate = new Map();
    for (const [pos, b] of this.grid) if (b.id === B.Robotic_Arm)
      this.arm_rate.set(pos, b.is_input || b.is_output ? INF : armSpeed(b, getOr(this.shares, pos, [0, 0])));
  }
  _isFactory(n) { return this.recipe.has(n) && (FACTORIES.has(this.grid.get(n).id) || this.tele_factory.has(n)); }
  _sinkCap(n) {
    const b = this.grid.get(n);
    if (b.id === B.Coal_Power_Plant) return COAL_FUEL_PER_MIN;
    if (b.id === B.Nuclear_Power_Plant) return NUCLEAR_FUEL_PER_MIN;
    if (b.id === B.Earth_Teleporter) return getOr(this.rate, n, 0.0) * getOr(this.recipe.get(n).mats, Item.Matter_Duplicator, 1);
    return INF;
  }
  _armCap(arm) {
    const r = this.arm_rate.get(arm);
    if (r !== undefined) return r;
    const b = this.grid.get(arm);
    return b.is_input || b.is_output ? INF : armSpeed(b);
  }
  _tileCap(n) {
    const b = this.grid.get(n);
    if (b.id === B.Robotic_Arm) return this._armCap(n);
    if (BELT_LIKE.has(b.id)) return settings.BELT_SPEED === null ? INF : settings.BELT_SPEED;
    if (b.is_source) return this._supply(b);
    if (this._isFactory(n)) return this.rate.get(n) * this.recipe.get(n).out_amount;
    if (b.is_output) return this._sinkCap(n);
    return INF;
  }
  _linkCap(n, t, ignore) {
    let cap = t !== SINK && this.grid.get(t).id === B.Robotic_Arm ? this._armCap(t) : INF;
    if (!(ignore && ignore[0] === n && ignore[1] === t)) cap = Math.min(cap, getOr(this.limit, `${n},${t}`, INF));
    return cap;
  }
  _supply(b) {
    if (b.is_source) { const rec = this.recipe.get(b.pos); return rec ? getOr(this.rate, b.pos, 0.0) * rec.out_amount : 0.0; }
    return Math.min(getOr(this.want, b.pos, 0.0), this._armCap(b.pos), getOr(this.in_limit, b.pos, INF));
  }
  /** split the items leaving tile n: [sends [[target, Map]], rest Map, jam item or null] */
  _distribute(n, items, live, ignore = null) {
    const sends = [];
    let rest = new Map();
    for (const [i, v] of items) if (v > EPS) rest.set(i, v);
    if (n !== SINK && this.grid.get(n).is_output) {
      const b = this.grid.get(n);
      let taken = new Map(), left = new Map();
      for (const [i, v] of rest) (takes(b, i) ? taken : left).set(i, v);
      const jam = left.size ? left.keys().next().value : null;
      const tot = msum(taken), cap = this._sinkCap(n);
      if (tot > cap + EPS) {
        const k = cap / tot;
        for (const [i, v] of taken) left.set(i, getOr(left, i, 0.0) + v * (1 - k));
        const t2 = new Map(); for (const [i, v] of taken) t2.set(i, v * k); taken = t2;
      }
      return [taken.size ? [[SINK, taken]] : [], left, jam];
    }
    let surplus = new Map();
    if (this._isFactory(n)) {
      const rec = this.recipe.get(n);
      const wrong = [...rest.keys()].filter((i) => !rec.mats.has(i));
      if (wrong.length) return [sends, rest, wrong[0]];
      let crafts = this.rate.get(n);
      for (const [k, a] of rec.mats) crafts = Math.min(crafts, getOr(rest, k, 0.0) / a);
      for (const [k, a] of rec.mats) { const s = getOr(rest, k, 0.0) - crafts * a; if (s > EPS) surplus.set(k, s); }
      rest = crafts > EPS ? new Map([[rec.out_item, crafts * rec.out_amount]]) : new Map();
    }
    const arms = (this.pulls.get(n) || []).filter((a) => live.has(a));
    for (const a of arms) {
      const arm = this.grid.get(a);
      const avail = new Map();
      for (const [i, v] of rest) if (v > EPS && takes(arm, i)) avail.set(i, v);
      const tot = msum(avail);
      if (tot <= EPS) continue;
      const ratio = Math.min(tot, this._linkCap(n, a, ignore)) / tot;
      if (ratio <= 0) continue;
      const s = new Map(); for (const [i, v] of avail) s.set(i, v * ratio);
      sends.push([a, s]);
      for (const [i, v] of avail) rest.set(i, rest.get(i) - v * ratio);
    }
    const outs = (this.push.get(n) || []).filter((t) => live.has(t));
    let tot = 0; for (const v of rest.values()) if (v > EPS) tot += v;
    if (outs.length && tot > EPS) {
      const shares = waterfill(tot, outs.map((t) => this._linkCap(n, t, ignore)));
      outs.forEach((t, j) => {
        const sh = shares[j];
        if (sh > EPS) { const s = new Map(); for (const [i, v] of rest) if (v > EPS) s.set(i, v * sh / tot); sends.push([t, s]); }
      });
      let ssum = 0; for (const s of shares) ssum += s;
      const keep = 1.0 - ssum / tot;
      const r2 = new Map(); for (const [i, v] of rest) r2.set(i, v * keep); rest = r2;
    }
    rest = clean(rest);
    let jam = null;
    if (!outs.length) for (const i of rest.keys()) if (!arms.some((a) => takes(this.grid.get(a), i))) { jam = i; break; }
    for (const [i, v] of surplus) rest.set(i, getOr(rest, i, 0.0) + v);
    return [sends, rest, jam];
  }
  /** rank tiles in flow order (upstream first); loops get consecutive ranks (Tarjan, iterative) */
  _order(live) {
    const succ = new Map();
    for (const n of live) {
      if (n === SINK) continue;
      const s = (this.push.get(n) || []).filter((t) => live.has(t) && t !== SINK);
      for (const a of this.pulls.get(n) || []) if (live.has(a)) s.push(a);
      succ.set(n, s);
    }
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
    let counter = 0;
    for (const root of succ.keys()) {
      if (index.has(root)) continue;
      const work = [[root, 0]];
      while (work.length) {
        const [v, i] = work.pop();
        if (i === 0) { index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v); }
        const nxt = succ.get(v);
        if (i < nxt.length) {
          work.push([v, i + 1]);
          const w = nxt[i];
          if (!index.has(w)) work.push([w, 0]);
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
          continue;
        }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break; }
          sccs.push(comp);
        }
        if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(v))); }
      }
    }
    const rank = new Map();
    for (let r = 0; r < sccs.length; r++) for (const v of sccs[sccs.length - 1 - r]) rank.set(v, r);
    return rank;
  }
  /** push the input amounts through the graph: [flow Map pos -> Map, finished] */
  _propagate(live) {
    if (this._rank_for !== live) { this._rank = this._order(live); this._rank_for = live; }
    const rank = this._rank;
    const flow = new Map(), contrib = new Map(), targets = new Map(), heap = new Heap(), queued = new Set();
    const fl = (k) => { let m = flow.get(k); if (!m) flow.set(k, m = new Map()); return m; };
    for (const b of this.grid.values()) if ((b.is_input || b.is_source) && live.has(b.pos)) {
      flow.set(b.pos, new Map([[b.filter, this._supply(b)]]));
      heap.push([getOr(rank, b.pos, 0), b.pos]); queued.add(b.pos);
    }
    let budget = PROPAGATE_BUDGET * Math.max(1, rank.size);
    let ok = true;
    while (heap.size) {
      if (--budget < 0) { ok = false; break; }
      const [, n] = heap.pop();
      queued.delete(n);
      const sends = this._distribute(n, fl(n), live)[0];
      const newMap = new Map(sends);
      const oldTargets = targets.get(n) || [];
      const all = new Set(oldTargets); for (const t of newMap.keys()) all.add(t);
      for (const t of all) {
        const ck = `${n},${t}`;
        const old = contrib.get(ck) || new Map(), nw = newMap.get(t) || new Map();
        let changed = false;
        const ft = fl(t);
        const keys = new Set(old.keys()); for (const i of nw.keys()) keys.add(i);
        for (const i of keys) {
          const d = getOr(nw, i, 0.0) - getOr(old, i, 0.0);
          if (d > PROPAGATE_EPS || d < -PROPAGATE_EPS) { ft.set(i, getOr(ft, i, 0.0) + d); changed = true; }
        }
        if (changed) {
          contrib.set(ck, nw);
          if (t !== SINK && !queued.has(t)) { heap.push([getOr(rank, t, 0), t]); queued.add(t); }
        }
      }
      targets.set(n, [...newMap.keys()]);
    }
    const out = new Map();
    for (const [k, it] of flow) {
      const c = clean(it);
      if (c.size || (this.grid.has(k) && (this.grid.get(k).is_input || this.grid.get(k).is_source))) out.set(k, c);
    }
    return [out, ok];
  }
  /** plain belt lines: {first tile: all tiles of the line in order} */
  _chains(live) {
    const chainable = (n) => { const b = this.grid.get(n); return CHAIN_LIKE.has(b.id) && !(b.is_input || b.is_output || b.is_source); };
    const indeg = new Map();
    for (const n of live) {
      if (n === SINK) continue;
      for (const t of this.push.get(n) || []) if (live.has(t)) indeg.set(t, getOr(indeg, t, 0) + 1);
      for (const a of this.pulls.get(n) || []) if (live.has(a)) indeg.set(a, getOr(indeg, a, 0) + 1);
    }
    const nxt = new Map();
    for (const n of live) {
      if (n === SINK || !chainable(n) || (this.pulls.get(n) || []).some((a) => live.has(a))) continue;
      const outs = (this.push.get(n) || []).filter((t) => live.has(t));
      if (outs.length === 1) {
        const t = outs[0];
        if (t !== SINK && t !== n && chainable(t) && getOr(indeg, t, 0) === 1 && this._tileCap(t) === this._tileCap(n)) nxt.set(n, t);
      }
    }
    const hasPrev = new Set(nxt.values()), chains = new Map(), seen = new Set();
    const walk = (h) => {
      const line = [h]; seen.add(h);
      while (nxt.has(line[line.length - 1]) && !seen.has(nxt.get(line[line.length - 1]))) { line.push(nxt.get(line[line.length - 1])); seen.add(line[line.length - 1]); }
      if (line.length > 1) chains.set(h, line);
    };
    for (const n of [...live].filter((n) => n !== SINK).sort((a, b) => a - b)) if (!hasPrev.has(n) && !seen.has(n)) walk(n);
    for (const n of [...nxt.keys()].sort((a, b) => a - b)) if (!seen.has(n)) walk(n);
    return chains;
  }
  /** upper limit of what can flow through each tile (Float64Array over nodes) */
  _flowBounds(nodes, idx, wants, cap, tail) {
    const N = nodes.length, src = [], dst = [];
    for (const n of nodes) {
      const e = tail.get(n) ?? n;
      for (const t of [...(this.push.get(e) || []), ...(this.pulls.get(e) || [])]) { const j = idx.get(t); if (j !== undefined) { src.push(idx.get(n)); dst.push(j); } }
    }
    const fixed = new Float64Array(N).fill(-1);
    for (const [i, , w] of wants) fixed[i] = w;
    for (const n of nodes) if (this._isFactory(n)) fixed[idx.get(n)] = this.rate.get(n) * this.recipe.get(n).out_amount;
    let ub = new Float64Array(N);
    for (let i = 0; i < N; i++) ub[i] = fixed[i] >= 0 ? fixed[i] : 0;
    const reach = new Float64Array(N);
    for (let it = 0; it < 4 * N + 10; it++) {
      reach.fill(0);
      for (let e = 0; e < src.length; e++) reach[dst[e]] += ub[src[e]];
      let grew = false;
      const nw = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        nw[i] = fixed[i] >= 0 ? ub[i] : Math.max(ub[i], Math.min(cap[i], reach[i]));
        if (nw[i] > ub[i] + 1e-12) grew = true;
      }
      if (!grew) break;
      ub = nw;
    }
    const isEnd = new Uint8Array(N);
    let dn = new Float64Array(N);
    for (const n of nodes) {
      const i = idx.get(n), b = this.grid.get(n);
      if (this._isFactory(n)) { isEnd[i] = 1; let s = 0; for (const a of this.recipe.get(n).mats.values()) s += a; dn[i] = this.rate.get(n) * s; }
      else if (b.is_output) { isEnd[i] = 1; dn[i] = Math.min(cap[i], END_POINTS.has(b.id) ? this._sinkCap(n) : INF); }
    }
    const take = new Float64Array(N);
    for (let it = 0; it < 4 * N + 10; it++) {
      take.fill(0);
      for (let e = 0; e < src.length; e++) take[src[e]] += dn[dst[e]];
      let grew = false;
      const nw = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        nw[i] = isEnd[i] ? dn[i] : Math.max(dn[i], Math.min(cap[i], take[i]));
        if (nw[i] > dn[i] + 1e-12) grew = true;
      }
      if (!grew) break;
      dn = nw;
    }
    const out = new Float64Array(N);
    nodes.forEach((n, i) => { out[i] = Math.max(this._isFactory(n) ? ub[i] : Math.min(ub[i], dn[i]), 1e-9); });
    return out;
  }
  _needsSimulation(flow, live) {
    for (const [n, items] of flow) {
      if (n === SINK) continue;
      if (msum(items) > this._tileCap(n) + 1e-9) return true;
      if (this._distribute(n, items, live)[1].size) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- solving
  _solveOnce() {
    let jams = new Map();
    this.limit = new Map(); this.in_limit = new Map();
    if (this._jam_state !== null) {
      const [j, dead, mixed, live, flow0, sim] = this._jam_state;
      this.dead = new Set(dead); this.mixed = new Map(mixed); jams = new Map(j);
      if (sim) return this._speedLimits(flow0, live, jams, true);
      const [flow] = this._propagate(live);
      return this._speedLimits(flow, live, jams, this._needsSimulation(flow, live));
    }
    this.dead = new Set();
    this.mixed = new Map();
    if (GUESS_REPAIR && !this._repaired) { this._repaired = true; this._repairGuesses(); }
    let live, flow;
    for (;;) {
      if (this._pre_flow !== null) { [live, flow] = this._pre_flow; this._pre_flow = null; }
      else { live = this._live(); [flow] = this._propagate(live); }
      const newJams = new Map();
      for (const [n, items] of flow) {
        if (n === SINK) continue;
        const jam = this._distribute(n, items, live)[2];
        if (jam !== null) newJams.set(n, jam);
      }
      for (const [n, outs] of this.push) {
        if (this.dead.has(n) || !BELT_LIKE.has(this.grid.get(n).id)) continue;
        const kinds = [];
        for (const [i, v] of flow.get(n) || []) if (v > EPS) kinds.push(i);
        kinds.sort((a, b) => a - b);
        if (kinds.length < 2) continue;
        for (const t of outs) {
          if (t === SINK || this.dead.has(t) || newJams.has(t) || this._needs(t) === null) continue;
          this.mixed.set(t, kinds);
          newJams.set(t, kinds[kinds.length - 1]);
        }
      }
      if (!newJams.size) break;
      for (const [k, v] of newJams) { jams.set(k, v); this.dead.add(k); }
    }
    return this._speedLimits(flow, live, jams, null);
  }
  _speedLimits(flow, live, jams, sim) {
    let converged = true, bottlenecks = new Map(), held_back = new Map();
    this._sim_links = null;
    if (sim === null) {
      sim = this._needsSimulation(flow, live);
      this._jam_state = [new Map(jams), new Set(this.dead), new Map(this.mixed), live, flow, sim];
    }
    if (sim) {
      const r = simulate(this, live, flow);
      flow = r.flow; this._sim_links = r.links; bottlenecks = r.bottlenecks; held_back = r.held_back; converged = r.converged;
    }
    for (const b of this.grid.values()) if (b.is_input && live.has(b.pos)) {
      const cap = this._armCap(b.pos), moved = msum(flow.get(b.pos) || new Map());
      if (cap < INF && getOr(this.want, b.pos, 0.0) > cap + EPS && moved >= cap * (1 - 1e-6)) bottlenecks.set(b.pos, cap);
    }
    return [flow, live, jams, bottlenecks, held_back, converged];
  }
  _plantPower(flow) {
    const power = new Map();
    for (const b of this.grid.values()) if (b.id === B.Coal_Power_Plant || b.id === B.Nuclear_Power_Plant) {
      let got = 0; for (const [i, v] of flow.get(b.pos) || []) if (takes(b, i)) got += v;
      power.set(b.pos, Math.min(1.0, got / this._sinkCap(b.pos)));
    }
    return power;
  }
  _boostShares(power) {
    const areas = [];
    for (const [p, pw] of power) if (pw > EPS) areas.push([plantArea(this.grid.get(p)), this.grid.get(p).id === B.Nuclear_Power_Plant, pw]);
    const shares = new Map();
    if (!areas.length) return shares;
    const boostable = [...this.recipe.keys()];
    for (const [p, b] of this.grid) if (b.id === B.Robotic_Arm && !(b.is_input || b.is_output)) boostable.push(p);
    for (const pos of boostable) {
      const t = footprint(this.grid.get(pos));
      let bx0 = INF, bx1 = -INF, by0 = INF, by1 = -INF;
      for (const k of t) { const x = px(k), y = py(k); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
      let fullN = false, fullC = false, maxN = 0, maxC = 0;
      for (const [area, nuclear, pw] of areas) {
        if (area === null || bx1 < area[0] || bx0 > area[2] || by1 < area[1] || by0 > area[3]) continue;
        if (nuclear) { fullN = fullN || pw >= 1 - 1e-9; maxN = Math.max(maxN, pw); }
        else { fullC = fullC || pw >= 1 - 1e-9; maxC = Math.max(maxC, pw); }
      }
      const n = fullN ? 1.0 : maxN;
      const c = fullC ? 1.0 - n : Math.max(0.0, maxC - n);
      if (n > 0 || c > 0) shares.set(pos, [n, c]);
    }
    return shares;
  }
  /** solve everything: returns the result (like Python's FlowResult, with Maps keyed by position) */
  solve() {
    this.shares = new Map();
    this._jam_state = null;
    this._sim_quick = [...this.grid.values()].some((b) => b.id === B.Coal_Power_Plant || b.id === B.Nuclear_Power_Plant);
    this._updateSpeeds();
    let [flow, live, jams, bottlenecks, held_back, converged] = this._solveOnce();
    let power = this._plantPower(flow);
    let stable = false;
    for (let rnd = 0; rnd < POWER_MAX_ROUNDS; rnd++) {
      if (rnd) {
        this._updateSpeeds();
        [flow, live, jams, bottlenecks, held_back, converged] = this._solveOnce();
        power = this._plantPower(flow);
      }
      const ns = this._boostShares(power);
      const keys = new Set([...ns.keys(), ...this.shares.keys()]);
      let change = 0;
      for (const k of keys) for (const j of [0, 1]) change = Math.max(change, Math.abs(getOr(ns, k, [0, 0])[j] - getOr(this.shares, k, [0, 0])[j]));
      if (change < 1e-6 || (!converged && (change < 1e-2 || rnd + 1 >= POWER_ROUNDS_UNSETTLED))) { stable = true; break; }
      this.shares = ns;
    }
    if (this._sim_quick) {
      this._sim_quick = false;
      if (!converged) {
        [flow, live, jams, bottlenecks, held_back, converged] = this._solveOnce();
        power = this._plantPower(flow);
      }
    }
    if (!stable) this.warnings.push("power plant boosts did not settle");
    this.flow = flow; this.live = live;
    const made = new Map();
    for (const [a, , items] of this.links()) {
      if (this.recipe.has(a) && (this._isFactory(a) || !END_POINTS.has(this.grid.get(a).id))) {
        let m = made.get(a); if (!m) made.set(a, m = new Map());
        for (const [i, v] of items) m.set(i, getOr(m, i, 0.0) + v);
      }
    }
    for (const b of this.grid.values()) {
      if (LOGISTICS.has(b.id) || b.is_source || b.is_output || this._isFactory(b.pos)) {
        b.items = clean(flow.get(b.pos) || new Map());
        b.flow = msum(b.items);
      }
      if (b.is_source) { b.items = made.get(b.pos) || new Map(); b.flow = msum(b.items); }
    }
    const [held_by, why] = this._explainHeld(held_back, bottlenecks, made);
    const pick = (f) => { const m = new Map(); for (const b of this.grid.values()) if (f(b)) m.set(b.pos, b.items); return m; };
    const res = {
      outputs: pick((b) => b.is_output), inputs: pick((b) => b.is_input), jams, bottlenecks, held_back,
      sources: pick((b) => b.is_source), backed_up: new Map(), warnings: [...new Set(this.warnings)].sort(),
      converged, made, max_speed: new Map(this.rate), power, boosts: new Map(this.shares), held_by, why,
      arm_speed: new Map(this.arm_rate), mixed: new Map(this.mixed), balanced: !!this._balanced && !converged,
      limits: [], limiting: new Map(),
    };
    if (settings.EXPLAIN_LIMITS) [res.limits, res.limiting] = explainLimits(this, res);
    return res;
  }
  _name(n) { return idLabel(this.grid.get(n)).replaceAll("_", " "); }
  _explainHeld(held_back, bottlenecks, made) {
    const down = new Map(), feeds = new Map();
    for (const [a, t, items] of this.links()) if (t !== SINK) { listOf(down, a).push([msum(items), t]); listOf(feeds, t).push([a, items]); }
    let full = new Set([...held_back.keys(), ...bottlenecks.keys()]);
    const why = new Map();
    const stopHere = (n) => {
      if (why.has(n)) return true;
      const b = this.grid.get(n);
      if (this._isFactory(n)) {
        const rec = this.recipe.get(n);
        const crafts = rec.out_amount ? msum(made.get(n) || new Map()) / rec.out_amount : 0.0;
        const rate = getOr(this.rate, n, 0.0);
        if (crafts >= rate * (1 - 1e-6)) {
          why.set(n, `${P(n)} ${this._name(n)} runs at its max speed (${fmtNum(rate * rec.out_amount, 3)} ${itemName(rec.out_item)}/min)`);
          return true;
        }
        const short = [];
        for (const [m, amount] of [...rec.mats].sort((x, y) => byName(x[0], y[0]))) {
          const srcs = (feeds.get(n) || []).filter(([, items]) => getOr(items, m, 0.0) > EPS).map(([a]) => a);
          if (!srcs.some((a) => full.has(a))) {
            let got = 0; for (const [, items] of feeds.get(n) || []) got += getOr(items, m, 0.0);
            short.push(`${itemName(m)} (gets ${fmtNum(got, 3)}/min, needs ${fmtNum(rate * amount, 3)} for full speed)`);
          }
        }
        if (short.length) { why.set(n, `${P(n)} ${this._name(n)} is short on ` + short.join(", ")); return true; }
        return false;
      }
      if (b.is_output) {
        const cap = END_POINTS.has(b.id) ? this._sinkCap(n) : INF;
        why.set(n, cap < INF ? `${P(n)} ${this._name(n)} only takes ${fmtNum(cap, 3)}/min` : `${P(n)} ${this._name(n)}`);
        return true;
      }
      if (bottlenecks.has(n)) { why.set(n, `${P(n)} ${this._name(n)} is at its max speed (${fmtNum(bottlenecks.get(n), 3)}/min)`); return true; }
      if (!held_back.has(n)) { why.set(n, `${P(n)} ${this._name(n)}`); return true; }
      return false;
    };
    for (const n of [...held_back.keys()]) {
      const b = this.grid.get(n);
      if ((this._isFactory(n) || b.is_source) && !(down.get(n) || []).some(([, t]) => full.has(t))) held_back.delete(n);
    }
    full = new Set([...held_back.keys(), ...bottlenecks.keys()]);
    const held_by = new Map();
    const nxt = (cur) => {
      const d = down.get(cur);
      if (!d || !d.length) return null;
      let best = d[0], bk = [full.has(d[0][1]) || this._isFactory(d[0][1]), d[0][0]];
      for (const ft of d.slice(1)) {
        const k = [full.has(ft[1]) || this._isFactory(ft[1]), ft[0]];
        if (k[0] > bk[0] || (k[0] === bk[0] && k[1] > bk[1])) { best = ft; bk = k; }
      }
      return best[1];
    };
    const ends = new Map();
    const endFrom = (start) => {
      const path = [], onPath = new Set();
      let cur = start, res = null;
      while (cur !== null) {
        if (ends.has(cur)) { res = ends.get(cur); break; }
        if (onPath.has(cur)) break;
        if (stopHere(cur)) { res = cur; break; }
        path.push(cur); onPath.add(cur);
        cur = nxt(cur);
      }
      for (const p of path) ends.set(p, res);
      return res;
    };
    for (const n of held_back.keys()) {
      const first = nxt(n);
      const end = first !== null ? endFrom(first) : null;
      if (end !== null && end !== n) held_by.set(n, end);
      else if (this._isFactory(n) && stopHere(n)) held_by.set(n, n);
    }
    for (const n of bottlenecks.keys()) stopHere(n);
    return [held_by, why];
  }
  /** after solve(): every [from, to, Map items] that actually moves (to = SINK for output arms) */
  links() {
    if (this._sim_links !== null) return [...this._sim_links];
    const out = [];
    for (const [n, items] of this.flow) {
      if (n === SINK) continue;
      for (const [t, sent] of this._distribute(n, items, this.live)[0]) {
        const s = clean(sent);
        if (s.size) out.push([n, t, s]);
      }
    }
    return out;
  }
}

/** set up inputs / outputs and solve: [graph, result] (inFlows: Map pos -> amount) */
export function buildAndSolve(builds, inFlows) {
  const { blueprintEdges, setInOut } = MODEL;
  const e = blueprintEdges(builds);
  setInOut(builds, e, inFlows);
  const graph = new FlowGraph(builds);
  const res = graph.solve();
  return [graph, res];
}
import * as MODEL from "./model.js";
export { getOr, listOf };
