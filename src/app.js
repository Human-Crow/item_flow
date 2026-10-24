// The page: loading blueprints (through the blueprint server), drawing, panels, touch.
// ================================================================ setup
const WORKER_URL = "https://builderment.hcrow.workers.dev";
const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("itemflow." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("itemflow." + k, JSON.stringify(v)); } catch {} },
};
const BG = "#141519", GRIDC = "#22242a", NUMBER_BOX = "#0e0f12", TUNNEL = "#05080b", DOT_OUTLINE = "#0b0c0f";
const IN_COLOR = "#4cd07d", OUT_COLOR = "#4ca8f0";
const LINE_MAX_WIDTH = 0.16, DOT_SIZE = 0.13, DOT_SPEED = 1.2, MAX_DOTS = 3000;
const MIN_DETAIL = 22, MIN_NUMBER = 28, MIN_DOT = 10, MIN_FONT = 7;
const LEGEND_TILES = [["#2c2f37", "#7c808b", "Belt"], ["#3b2a52", "#b59be3", "Splitter"], ["#15384d", "#6db8e0", "UG in"],
  ["#14452f", "#6fdba6", "UG out"], ["#4a3618", "#ffcf7a", "Arm"], ["#3a3b40", "#d0d2d8", "Storage"],
  ["#4a2a2a", "#e68a8a", "Factory"], ["#25304d", "#8fa2f0", "End point"], ["#2e3d1c", "#b7d968", "Producer"],
  ["#c6ff4d", "#c6ff4d", "Nuclear"], ["#ff9f43", "#ff9f43", "Coal"]];

// ================================================================ worker
let worker = null, nextId = 1, pending = new Map(), ready = null, lastSave = null, lastName = "";
function startWorker() {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "status") { setStatus(m.text, "busy"); return; }
    if (m.type === "progress") { testProgress(m.d, m.t); return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  };
  worker.onerror = (e) => setStatus("worker error: " + (e.message || e), "error");
  ready = call("init");
  return ready;
}
function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args });
  });
}
async function stopWorker() {     // a long calculation: throw the worker away and start a fresh one
  worker.terminate();
  for (const p of pending.values()) p.reject(new Error("stopped"));
  pending.clear();
  busy = false; updateButtons();
  setStatus("stopped, restarting the calculator ...", "busy");
  await startWorker();
  if (lastSave) await call("load", { save: lastSave, name: lastName });
  setStatus("stopped (change something and calculate again)");
}

// ================================================================ status
let busy = false, busyTimer = null;
const doneText = { calculating: "calculated", loading: "loaded", opening: "opened", balancer: "balancer test", splitter: "splitter test", ratio: "ratio test" };
function setStatus(text, kind = "") {
  $("msg").textContent = text;
  $("status").className = kind;
}
function updateButtons() {
  for (const b of [$("calcBtn"), $("calc2"), ...document.querySelectorAll("[data-test]")]) b.disabled = busy;
}
async function job(label, fn) {
  if (busy) return;
  busy = true; updateButtons();
  const t0 = performance.now();
  setStatus(label + " ...", "busy");
  clearInterval(busyTimer);
  busyTimer = setInterval(() => {
    if (busy && !$("status").classList.contains("error"))
      setStatus(`${label} ... ${Math.round((performance.now() - t0) / 1000)} s`, "busy");
  }, 500);
  try {
    await ready;
    const r = await fn();
    setStatus(`${lastName || "blueprint"} — ${doneText[label.split(" ")[0]] || label + " done"} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return r;
  } catch (err) {
    if (String(err.message) !== "stopped") setStatus(String(err.message || err), "error");
  } finally {
    clearInterval(busyTimer);
    busy = false; updateButtons();
  }
}

// ================================================================ settings & inputs
const S = {
  belt: store.get("belt", "480"), ug: store.get("ug", "6"), gen: store.get("gen", "1"), arm: store.get("arm", true),
  guess: store.get("guess", false), anim: store.get("anim", true), nums: store.get("nums", true),
};
let flows = {};             // "x,y" -> amount
let guessSet = {};          // "x,y" -> true/false (switched by the user)
function settingsObj() {
  return ({
    belt: S.belt.trim() === "" ? null : Number(S.belt), ug: Number(S.ug), gen: Number(S.gen), arm: S.arm, guess: S.guess,
    guess_set: Object.entries(guessSet).map(([k, on]) => [...k.split(",").map(Number), on]),
    flows: Object.entries(flows).map(([k, v]) => [...k.split(",").map(Number), v]), default_input: 0,
  });
}
function bindSettings() {
  $("sBelt").value = S.belt; $("sUg").value = S.ug; $("sGen").value = S.gen;
  $("sArm").checked = S.arm; $("sGuess").checked = S.guess; $("sAnim").checked = S.anim; $("sNum").checked = S.nums;
  $("sBelt").addEventListener("change", () => { S.belt = $("sBelt").value; store.set("belt", S.belt); recalc(); });
  $("sUg").addEventListener("change", () => { S.ug = $("sUg").value; store.set("ug", S.ug); recalc(); });
  $("sGen").addEventListener("change", () => { S.gen = $("sGen").value; store.set("gen", S.gen); recalc(); });
  $("sArm").addEventListener("change", () => { S.arm = $("sArm").checked; store.set("arm", S.arm); recalc(); });
  $("sGuess").addEventListener("change", () => { S.guess = $("sGuess").checked; store.set("guess", S.guess); recalc(); });
  $("sAnim").addEventListener("change", () => { S.anim = $("sAnim").checked; store.set("anim", S.anim); buildDots(); dirty(); });
  $("sNum").addEventListener("change", () => { S.nums = $("sNum").checked; store.set("nums", S.nums); dirty(true); });
}
function readInputs() {
  for (const el of document.querySelectorAll("#inputs input[data-pos]")) {
    const v = parseFloat(el.value.replace(",", "."));
    if (!Number.isNaN(v)) flows[el.dataset.pos] = v;
  }
}

// ================================================================ loading
function blueprintId(text) {
  text = text.trim().replace(/^"|"$/g, "");
  const m = text.match(/[?&]id=([A-Za-z0-9]+)/);
  return m ? m[1] : text;
}
// the worker (api.js) downloads and reads blueprints; the page only gets the buildings
let apiModule = null;
async function api() {
  if (apiModule) return apiModule;
  try { apiModule = await import(WORKER_URL + "/api.js"); }
  catch (e) { throw new Error("could not reach the blueprint server (" + (e.message || e) + ")"); }
  return apiModule;
}
async function loadFromServer() {
  const id = blueprintId($("bp").value);
  if (!id) return;
  $("bp").blur();
  await job(`loading ${id}`, async () => {
    setStatus(`downloading ${id} ...`, "busy");
    const save = await (await api()).downloadAndRead(WORKER_URL, id);
    await openSave(save, id);
    store.set("last", id);
    const u = new URL(location.href); u.searchParams.set("id", id); history.replaceState(null, "", u);
  });
  if (lastSave && !view) await recalc(true);
}
async function loadFromFile(file) {
  const name = file.name.replace(/\.(blp|blueprint)$/i, "");
  await job(`opening ${name}`, async () => {
    const save = await (await api()).readBlp(WORKER_URL, new Uint8Array(await file.arrayBuffer()));
    await openSave(save, name);
  });
  if (lastSave && !view) await recalc(true);
}
async function openSave(save, name) {
  await ready;
  const b = save && save.buildings;
  // only what the calculation needs (typed arrays are copied to the background worker as they are)
  const slim = { name: save && save.name || "", buildings: b ? { count: b.count, id: b.id, x: b.x, y: b.y, o: b.o, tier: b.tier, rec_fil: b.rec_fil } : null };
  const info = await call("load", { save: slim, name });
  lastSave = slim; lastName = info.name || name;
  T = null; dots = []; dirty(true);
  flows = {}; guessSet = {}; selected = null; hideCard();
  $("bp").value = name;
  document.title = `${lastName} — Item Flow`;
  view = null;
  if (!info.count) throw new Error("this blueprint is empty");
  return info;
}
async function recalc(fit = false) {
  if (!lastSave) return;
  readInputs();
  const r = await job("calculating", async () => await call("solve", { settings: settingsObj() }));
  if (!r) return;
  if (r.empty) { setStatus("this blueprint is empty", "error"); return; }
  showResult(r, fit);
}

// ================================================================ the result
let view = null;      // last result from the worker
let T = null;         // derived drawing data
function showResult(r, fit) {
  view = r;
  $("loading").style.display = "none";
  // flows: keep what was typed, add the inputs
  for (const [x, y, , , , wanted] of r.side.inputs) { const k = x + "," + y; if (!(k in flows)) flows[k] = wanted; }
  prepare();
  fillSide();
  if (fit || !camera.set) fitView(); else { clampCamera(); dirty(true); }
  if (selected) showInfo(selected[0], selected[1], true);
}

// derived tables: rotated geometry, lookup squares, atlas for zooming out
const CH = 32;
function prepare() {
  const v = view;
  const tiles = v.tiles, occ = new Map();
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let k = 0; k < tiles.length; k++) {
    const t = tiles[k];
    for (let x = t[2]; x < t[4]; x++) for (let y = t[3]; y < t[5]; y++) occ.set(x + "," + y, k);
    bx0 = Math.min(bx0, t[2]); by0 = Math.min(by0, t[3]); bx1 = Math.max(bx1, t[4]); by1 = Math.max(by1, t[5]);
  }
  for (const g of v.guesses) { bx0 = Math.min(bx0, g[0]); by0 = Math.min(by0, g[1]); bx1 = Math.max(bx1, g[0] + 1); by1 = Math.max(by1, g[1] + 1); }
  T = { occ, bounds: [bx0, by0, bx1, by1] };
  rebuildRot();
}
// continuous rotation of the view: (u, v) -> (1 - v, u) per quarter turn (clockwise)
let rot = 0;
function R(u, v) { for (let i = 0; i < rot; i++) [u, v] = [1 - v, u]; return [u, v]; }
function Rinv(u, v) { for (let i = 0; i < rot; i++) [u, v] = [v, 1 - u]; return [u, v]; }
function Rd(dx, dy) { for (let i = 0; i < rot; i++) [dx, dy] = [-dy, dx]; return [dx, dy]; }
function rrect(x0, y0, x1, y1) {
  const [a, b] = R(x0, y0), [c, d] = R(x1, y1);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}
function rebuildRot() {
  const v = view, tiles = v.tiles;
  // per tile in turned coordinates: rect, direction
  T.rt = tiles.map(t => rrect(t[2], t[3], t[4], t[5]));
  T.rd = tiles.map(t => Rd(t[7], t[8]));
  T.links = v.links.map(l => { const [ax, ay] = R(l[0], l[1]), [bx, by] = R(l[2], l[3]);
    return [ax, ay, bx, by, Math.max(1, Math.abs(bx - ax) + Math.abs(by - ay)), l[4], l[5], l[6], l[6].reduce((s, iv) => s + iv[1], 0)]; });
  T.areas = v.areas.map(a => [...rrect(a[0], a[1], a[2], a[3]), a[4]]);
  T.rb = rrect(...T.bounds);
  // lookup squares (turned coordinates)
  const chunks = new Map(), lchunks = new Map();
  const add = (map, x0, y0, x1, y1, k) => {
    for (let cx = Math.floor(x0 / CH); cx <= Math.floor((x1 - 1e-9) / CH); cx++)
      for (let cy = Math.floor(y0 / CH); cy <= Math.floor((y1 - 1e-9) / CH); cy++) {
        const key = cx + "," + cy; let a = map.get(key); if (!a) map.set(key, a = []); a.push(k);
      }
  };
  T.rt.forEach((r, k) => add(chunks, r[0], r[1], r[2], r[3], k));
  T.links.forEach((l, k) => add(lchunks, Math.min(l[0], l[2]), Math.min(l[1], l[3]), Math.max(l[0], l[2]) + 1e-6, Math.max(l[1], l[3]) + 1e-6, k));
  T.chunks = chunks; T.lchunks = lchunks;
  T.atlas = null;
  buildDots();
}
function inView(map, x0, y0, x1, y1) {
  const out = new Set();
  for (let cx = Math.floor(x0 / CH); cx <= Math.floor(x1 / CH); cx++)
    for (let cy = Math.floor(y0 / CH); cy <= Math.floor(y1 / CH); cy++) {
      const a = map.get(cx + "," + cy); if (a) for (const k of a) out.add(k);
    }
  return out;
}

// ================================================================ side panel
function fmt(v, d = 4) {
  let s = Number(v).toFixed(d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sw = (c) => `<span class="sw" style="background:${c}"></span>`;
let totalsMode = "item";
function fillSide() {
  const s = view.side;
  // inputs
  let h = "";
  for (const [x, y, item, col, auto, wanted, got] of s.inputs) {
    const k = x + "," + y, want = flows[k] ?? wanted;
    const short = got + 1e-9 < want ? `<span class="got">→${fmt(got, 2)}</span>` : "<span></span>";
    h += `<div class="irow">${sw(col)}<span class="name">(${x}, ${y}) ${esc(item)}${auto ? " (auto)" : ""}</span>${short}`
       + `<input type="text" inputmode="decimal" data-pos="${k}" value="${fmt(want)}" enterkeyhint="done"></div>`;
  }
  for (const [label, col, can, got] of s.producers) {
    const short = got + 1e-9 < can ? `<span class="got">→${fmt(got, 2)}</span>` : "<span></span>";
    h += `<div class="irow">${sw(col)}<span class="name">${esc(label)}</span>${short}<span class="fixed">${fmt(can, 2)}</span></div>`;
  }
  $("inputs").innerHTML = h || `<div class="help" style="padding:10px 0">No inputs (arms on the edge) or producers. Try “guess in/out belts” under More.</div>`;
  for (const el of document.querySelectorAll("#inputs input")) {
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { el.blur(); recalc(); } });
  }
  $("summary").textContent = s.total.join("\n");
  $("totalTxt").innerHTML = esc(s.total[0]) + "<br>" + esc(s.total[1]);
  fillTotals();
  // alt recipes
  $("alts").innerHTML = s.alts.map(([n, col, txt, tc, exact]) =>
    `<div class="altrow">${sw(col)}<span class="n">${esc(n)}</span><span class="${exact ? "exact" : ""}" style="color:${tc}">${txt}</span></div>`).join("");
  // problems
  const [sum, sc] = s.prob_summary, [lines, lc] = s.problems;
  $("probSum").textContent = sum || (lines.length ? "no jams — notes below" : "");
  $("probSum").style.color = sc;
  $("probs").innerHTML = lines.map(l => `<div style="color:${/^(Why|Where items wait)/.test(l) ? "#ddd" : lc}">${esc(l) || "&nbsp;"}</div>`).join("");
  $("probBadge").textContent = s.n_problems ? (s.n_problems > 99 ? "99+" : s.n_problems) : "";
  // legend
  $("legend").innerHTML = LEGEND_TILES.map(([f, a, n]) => `<span><i class="lg" style="background:${f};border-color:${a}"></i>${n}</span>`).join("");
  $("legendItems").innerHTML = Object.values(view.items).map(([n, c]) => `<span>${sw(c)}${esc(n)}</span>`).join("");
}
function fillTotals() {
  const s = view.side;
  if (totalsMode === "output") {
    $("totals").innerHTML = s.per_output.map(t => `<div class="trow">${esc(t)}</div>`).join("") || "none";
    return;
  }
  let h = "";
  for (const [title, rows] of s.per_item) {
    rows.forEach(([n, c, v], k) => {
      h += `<div class="trow">${sw(c)}<span class="name">${esc(n)}</span><span class="tag">${k ? "" : title}</span><span class="val">${fmt(v, 2)}</span></div>`;
    });
    h += `<div style="height:6px"></div>`;
  }
  $("totals").innerHTML = h || "nothing moves";
}

// ================================================================ tests
let testKind = "";
function testProgress(d, t) { setStatus(`${testKind} test ... run ${d} / ${t}`, "busy"); }
async function runTest(kind) {
  if (!lastSave) return;
  readInputs();
  testKind = kind;
  const r = await job(`${kind} test`, async () => await call("test", { kind, settings: settingsObj() }));
  if (!r) return;
  const must = r.filter(c => !c.optional), passed = must.filter(c => c.passed).length, notes = r.length - must.length;
  const good = passed === must.length;
  let h = `<div class="big ${good ? "pass" : "fail"}">${good ? "PASSED" : "FAILED"} (${passed} / ${must.length} tests)${notes ? ` + ${notes} note` : ""} — ${kind}</div>`;
  r.forEach((c, k) => {
    const soft = c.optional && !c.passed;
    h += `<div class="check"><div class="head ${c.passed ? "pass" : soft ? "note-c" : "fail"}">${c.passed ? "PASS" : soft ? "NOTE" : "FAIL"}  ${esc(c.name)}</div>`;
    for (const l of c.lines) {
      const cls = l.trim().startsWith("!") ? (soft ? "note-c" : "bad") : l.startsWith("note") ? "dimc" : "";
      h += `<div class="ln ${cls}">${esc(l)}</div>`;
    }
    if (c.amounts.length && (!c.passed || c.name.startsWith("Full")))
      h += `<div style="margin:6px 0 0 10px"><button data-show="${k}">Show: ${esc(c.name.toLowerCase())}</button></div>`;
    h += `</div>`;
  });
  $("testOut").innerHTML = h;
  for (const b of document.querySelectorAll("[data-show]")) {
    b.addEventListener("click", () => {
      for (const [x, y, v] of r[Number(b.dataset.show)].amounts) flows[x + "," + y] = v;
      fillSide(); recalc(); selectTab("inputs");
    });
  }
}

// ================================================================ drawing
const canvas = $("map"), ctx = canvas.getContext("2d");
let DPR = Math.min(2, window.devicePixelRatio || 1), CW = 1, CHH = 1;
const camera = { cell: 30, ox: 0, oy: 0, set: false };
let staticLayer = document.createElement("canvas"), staticOk = false, needFrame = true;
function resize() {
  const r = canvas.getBoundingClientRect();
  CW = Math.max(1, r.width); CHH = Math.max(1, r.height);
  DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(CW * DPR); canvas.height = Math.round(CHH * DPR);
  staticLayer.width = canvas.width; staticLayer.height = canvas.height;
  dirty(true);
}
function dirty(full = false) { if (full) staticOk = false; needFrame = true; }
function viewRect() {          // visible area in turned tile coordinates
  const s = camera.cell;
  return [-camera.ox / s - 1, -camera.oy / s - 1, (CW - camera.ox) / s + 1, (CHH - camera.oy) / s + 1];
}
function fitView() {
  if (!T) return;
  const [x0, y0, x1, y1] = T.rb;
  // leave room for the summary (top left) and the buttons (right)
  const padL = 10, padR = 62, padT = 52, padB = 10;
  const aw = Math.max(40, CW - padL - padR), ah = Math.max(40, CHH - padT - padB);
  const w = x1 - x0 + 0.5, h = y1 - y0 + 0.5;
  camera.cell = Math.max(0.25, Math.min(80, Math.min(aw / w, ah / h)));
  camera.ox = padL + aw / 2 - ((x0 + x1) / 2) * camera.cell;
  camera.oy = padT + ah / 2 - ((y0 + y1) / 2) * camera.cell;
  camera.set = true;
  dirty(true); buildDots();
}
function clampCamera() { /* free panning; nothing to clamp */ }

// number formats (as flow_gui)
function shortNumber(v) {
  if (v >= 9999.5) return fmt(v / 1000, 1) + "k";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return fmt(v, 1);
  return fmt(v, 2);
}
function numberVariants(v) {
  const out = [shortNumber(v)];
  if (v < 999.5) {
    out.push(fmt(v, 2), fmt(v, 1));
    if (v < 0.95) for (const d of [2, 1]) { const t = fmt(v, d); if (t !== "0") out.push(t.slice(1)); }
    out.push(fmt(v, 0));
  } else if (v < 999500) out.push(fmt(v / 1e3, 1) + "k", fmt(v / 1e3, 0) + "k");
  else out.push(fmt(v / 1e6, 1) + "M", fmt(v / 1e6, 0) + "M");
  const res = [out[0]];
  for (const t of out.slice(1)) if (t.length < res[res.length - 1].length && !(t === "0" && v >= 0.05)) res.push(t);
  return res;
}

// one picture of the whole blueprint at a few pixels per tile: used when zoomed far out
function buildAtlas() {
  const [x0, y0, x1, y1] = T.rb;
  const W = x1 - x0, H = y1 - y0;
  const A = Math.max(1, Math.min(8, Math.floor(Math.sqrt(4e6 / Math.max(1, W * H)))));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(W * A)); c.height = Math.max(1, Math.ceil(H * A));
  const g = c.getContext("2d");
  g.fillStyle = BG; g.fillRect(0, 0, c.width, c.height);
  drawStatic(g, A, -x0 * A, -y0 * A, [x0, y0, x1, y1], true);
  T.atlas = { c, A, x0, y0 };
}
// tiles, outlines, flow lines (+ details/numbers when big enough), into context g
function drawStatic(g, s, ox, oy, vr, atlasMode = false) {
  const v = view, pal = v.pal, tiles = v.tiles;
  const ids = inView(T.chunks, vr[0], vr[1], vr[2], vr[3]);
  const m = s >= 8 ? s * 0.06 : 0;
  // grid
  if (!atlasMode && s >= MIN_DETAIL / 2) {
    g.strokeStyle = GRIDC; g.lineWidth = 1; g.beginPath();
    const gx0 = Math.floor(vr[0]), gx1 = Math.ceil(vr[2]), gy0 = Math.floor(vr[1]), gy1 = Math.ceil(vr[3]);
    for (let x = gx0; x <= gx1; x++) { const px = Math.round(x * s + ox) + 0.5; g.moveTo(px, gy0 * s + oy); g.lineTo(px, gy1 * s + oy); }
    for (let y = gy0; y <= gy1; y++) { const py = Math.round(y * s + oy) + 0.5; g.moveTo(gx0 * s + ox, py); g.lineTo(gx1 * s + ox, py); }
    g.stroke();
  }
  // tiles
  for (const k of ids) {
    const t = tiles[k], r = T.rt[k];
    const x = r[0] * s + ox + m, y = r[1] * s + oy + m, w = (r[2] - r[0]) * s - 2 * m, h = (r[3] - r[1]) * s - 2 * m;
    g.fillStyle = pal[t[9]];
    g.fillRect(x, y, w, h);
    const oc = pal[t[11]], black = oc === "#000";
    if (s >= 2 && !(black && s < 8)) {
      const bw = Math.max(1, Math.min(t[12], s * 0.18));
      g.strokeStyle = oc; g.lineWidth = bw;
      g.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw);
    }
  }
  // flow lines (centre to centre)
  const mf = v.max_flow;
  const lids = inView(T.lchunks, vr[0] - 1, vr[1] - 1, vr[2] + 1, vr[3] + 1);
  g.lineCap = "butt";
  for (const k of lids) {
    const l = T.links[k];
    const w = Math.max(atlasMode ? 1 : 2, LINE_MAX_WIDTH * l[8] / mf * s);
    g.strokeStyle = pal[l[6]]; g.lineWidth = w;
    g.setLineDash(l[5] ? [Math.max(2, s / 6), Math.max(2, s / 6)] : []);
    g.beginPath(); g.moveTo(l[0] * s + ox, l[1] * s + oy); g.lineTo(l[2] * s + ox, l[3] * s + oy); g.stroke();
  }
  g.setLineDash([]);
  // boosted plant areas
  for (const a of T.areas) {
    g.strokeStyle = pal[a[4]]; g.lineWidth = Math.max(1, s / 25);
    g.strokeRect(a[0] * s + ox, a[1] * s + oy, (a[2] - a[0]) * s, (a[3] - a[1]) * s);
  }
  if (atlasMode) return;
  if (s >= MIN_DETAIL) for (const k of ids) drawDetails(g, k, s, ox, oy);
  if (S.nums && s >= MIN_NUMBER) drawNumbers(g, ids, s, ox, oy);
}

function chevron(g, cx, cy, dx, dy, along, size, s, col, lw) {
  const px = -dy, py = dx;
  const ox = cx + dx * along * s, oy = cy + dy * along * s;
  g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
  g.moveTo(ox - dx * size * 0.2 + px * size * 0.8, oy - dy * size * 0.2 + py * size * 0.8);
  g.lineTo(ox + dx * size, oy + dy * size);
  g.lineTo(ox - dx * size * 0.2 - px * size * 0.8, oy - dy * size * 0.2 - py * size * 0.8);
  g.stroke();
}
function arrow(g, x0, y0, x1, y1, col, lw, head) {
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8); g.stroke();
  g.beginPath(); g.moveTo(x1, y1);
  g.lineTo(x1 - ux * head - uy * head * 0.55, y1 - uy * head + ux * head * 0.55);
  g.lineTo(x1 - ux * head + uy * head * 0.55, y1 - uy * head - ux * head * 0.55);
  g.closePath(); g.fill();
}
function drawDetails(g, k, s, ox, oy) {
  const t = view.tiles[k], pal = view.pal, r = T.rt[k], [dx, dy] = T.rd[k];
  const kind = t[6], acc = pal[t[10]];
  const x = r[0] * s + ox, y = r[1] * s + oy, cx = x + s / 2, cy = y + s / 2;
  const lw = Math.max(1, s / 16);
  if (kind === 0) chevron(g, cx, cy, dx, dy, 0, s * 0.25, s, acc, lw);
  else if (kind === 1) {
    const rr = s * 0.1, px = -dy, py = dx;
    g.strokeStyle = acc; g.lineWidth = lw; g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke();
    for (const [vx, vy] of [[dx, dy], [px, py], [-px, -py]])
      arrow(g, cx + vx * rr, cy + vy * rr, cx + vx * s * 0.4, cy + vy * s * 0.4, acc, lw, s / 8);
  } else if (kind === 2 || kind === 3) {
    const sgn = kind === 2 ? 1 : -1, px = -dy, py = dx, a0 = 0.16 * sgn, a1 = 0.42 * sgn, w = 0.34;
    g.beginPath();
    [[a0, -w], [a1, -w], [a1, w], [a0, w]].forEach(([al, ac], i) => {
      const X = cx + dx * al * s + px * ac * s, Y = cy + dy * al * s + py * ac * s;
      i ? g.lineTo(X, Y) : g.moveTo(X, Y);
    });
    g.closePath(); g.fillStyle = TUNNEL; g.fill(); g.strokeStyle = acc; g.lineWidth = lw; g.stroke();
    chevron(g, cx, cy, dx, dy, kind === 2 ? -0.12 : 0.12, s * 0.2, s, acc, lw);
  } else if (kind === 5) {
    const rr = s * 0.3; g.strokeStyle = acc; g.lineWidth = lw; g.strokeRect(cx - rr, cy - rr, 2 * rr, 2 * rr);
    chevron(g, cx, cy, dx, dy, 0, s * 0.16, s, acc, lw);
  } else if (kind === 4) {
    arrow(g, cx - dx * s * 0.35, cy - dy * s * 0.35, cx + dx * s * 0.35, cy + dy * s * 0.35, acc, Math.max(2, s / 12), s / 5);
    const ex = t[14] || {};
    if (ex.f) { const rr = s * 0.12; g.fillStyle = ex.f; g.strokeStyle = "#000"; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.fill(); g.stroke(); }
    if (ex.boost) corner(g, x + s, y, s * 0.2, s * 0.06 + 2, ex.boost);
  } else if (kind === 9) drawBlock(g, k, s, ox, oy);
}
function corner(g, xr, yt, size, m, col) {
  g.fillStyle = col; g.beginPath(); g.moveTo(xr - m, yt + m); g.lineTo(xr - m - size, yt + m); g.lineTo(xr - m, yt + m + size); g.closePath(); g.fill();
}
let FONT = "Menlo, Consolas, monospace";
function fitText(g, text, px, maxW, bold) {
  let size = px;
  while (size > MIN_FONT) { g.font = `${bold ? "700 " : ""}${size}px ${FONT}`; if (g.measureText(text).width <= maxW) break; size--; }
  g.font = `${bold ? "700 " : ""}${size}px ${FONT}`;
  return g.measureText(text).width <= maxW;
}
function drawBlock(g, k, s, ox, oy) {
  const t = view.tiles[k], d = t[14], r = T.rt[k];
  const m = s * 0.06, acc = d.acc, lw = Math.max(2, s / 10);
  const P = (u, v) => { const [a, b] = R(u, v); return [a * s + ox, b * s + oy]; };
  g.strokeStyle = acc; g.lineWidth = lw; g.lineCap = "butt";
  if (d.side) {
    const cx = t[0] + 0.5, cy = t[1] + 0.5, e = 1.5 - (m + lw / 2) / s, h = 0.32;
    for (const [ex, ey] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const mx = cx + ex * e, my = cy + ey * e;
      const [a, b] = P(mx - ey * h, my - ex * h), [c, dd] = P(mx + ey * h, my + ex * h);
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, dd); g.stroke();
    }
  } else if (d.back) {
    const [bx0, by0, bx1, by1, dx, dy] = d.back, ins = (m + lw / 2) / s;
    let seg = null;
    if (dy === 1) seg = [bx0 + .15, by0 + ins, bx1 - .15, by0 + ins];
    if (dy === -1) seg = [bx0 + .15, by1 - ins, bx1 - .15, by1 - ins];
    if (dx === 1) seg = [bx0 + ins, by0 + .15, bx0 + ins, by1 - .15];
    if (dx === -1) seg = [bx1 - ins, by0 + .15, bx1 - ins, by1 - .15];
    if (seg) { const [a, b] = P(seg[0], seg[1]), [c, dd] = P(seg[2], seg[3]); g.beginPath(); g.moveTo(a, b); g.lineTo(c, dd); g.stroke(); }
  }
  if (d.out) {
    const [ox_, oy_, dx, dy] = d.out;
    const [a, b] = P(ox_ + 0.5, oy_ + 0.5), [c, dd] = P(ox_ + 0.5 + dx * 0.42, oy_ + 0.5 + dy * 0.42);
    arrow(g, a, b, c, dd, acc, lw, s / 4);
  }
  const x0 = r[0] * s + ox, y0 = r[1] * s + oy, x1 = r[2] * s + ox, y1 = r[3] * s + oy;
  const widthPx = (x1 - x0) - 2 * m - 6, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  g.textAlign = "center"; g.textBaseline = "middle";
  if (d.name && fitText(g, d.name, Math.max(MIN_FONT, Math.floor(s * 0.22)), widthPx, true)) {
    g.fillStyle = acc; g.fillText(d.name, mx, my + (d.sub ? -0.16 : 0) * s);
  }
  if (d.sub && fitText(g, d.sub, Math.max(MIN_FONT, Math.floor(s * 0.18)), widthPx, false)) {
    g.fillStyle = "#c9c9c9"; g.fillText(d.sub, mx, my + 0.14 * s);
  }
  if (d.boost) corner(g, x1, y0, s * 0.16, m + 3, d.boost);
  if (d.prod) { const rr = s * 0.1; g.fillStyle = d.prod; g.strokeStyle = "#000"; g.lineWidth = 1;
    g.beginPath(); g.arc(x0 + m + rr + 3, y0 + m + rr + 3, rr, 0, 7); g.fill(); g.stroke(); }
}
function drawNumbers(g, ids, s, ox, oy) {
  const tiles = view.tiles, m = s * 0.06 + 2, maxW = s - 2 * m - 4, maxH = s * 0.4;
  const list = [];
  for (const k of ids) { const v = tiles[k][13]; if (v > 1e-9) list.push([k, numberVariants(v)]); }
  if (!list.length) return;
  let longest = ""; for (const [, vs] of list) if (vs[vs.length - 1].length > longest.length) longest = vs[vs.length - 1];
  const sample = "8".repeat(longest.length);
  let size = Math.max(MIN_FONT, Math.floor(s * 0.3));
  const setF = (px) => { g.font = `${px}px ${FONT}`; };
  setF(size);
  while (size > MIN_FONT && (g.measureText(sample).width > maxW || size * 1.2 > maxH)) { size--; setF(size); }
  if (g.measureText(sample).width > maxW || size * 1.2 > maxH) return;
  const th = Math.ceil(size * 1.25);
  const pick = (vs, w) => { for (const t of vs) { const tw = g.measureText(t).width; if (tw <= w) return [t, tw]; } const t = vs[vs.length - 1]; return [t, g.measureText(t).width]; };
  g.textAlign = "center"; g.textBaseline = "middle";
  for (const [k, vs] of list) {
    const t = tiles[k], r = T.rt[k];
    setF(size);
    if (t[6] === 9 && (t[4] - t[2]) * (t[5] - t[3]) > 1) {
      const bx0 = r[0] * s + ox + m + 2, bx1 = r[2] * s + ox - m - 2, byMid = (r[1] + r[3]) / 2 * s + oy;
      const [txt, tw] = pick(vs, bx1 - bx0), mid = (bx0 + bx1) / 2, ytop = byMid + s * 0.3;
      g.fillStyle = NUMBER_BOX; g.fillRect(mid - tw / 2 - 2, ytop, tw + 4, th);
      g.fillStyle = "#fff"; g.fillText(txt, mid, ytop + th / 2);
      continue;
    }
    const [dx, dy] = T.rd[k];
    const [ax, ay] = t[6] === 3 ? [-dx, -dy] : [dx, dy];
    const left = r[0] * s + ox + m + 2, right = (r[0] + 1) * s + ox - m - 2, cx = (r[0] + 0.5) * s + ox;
    const bottom = (r[1] + 1) * s + oy - m, top = r[1] * s + oy + m + th;
    let yEdge = bottom, x0 = left, x1 = right;
    if (ax === 0 && ay === 1) { yEdge = top; }
    else if (ax === 1) x1 = cx + s * 0.14 - 2;
    else if (ax === -1) x0 = cx - s * 0.14 + 2;
    const avail = x1 - x0;
    let px = size, [txt, tw] = pick(vs, avail);
    while (tw > avail && px > MIN_FONT) { px--; setF(px); [txt, tw] = pick(vs, avail); }
    const fh = Math.ceil(px * 1.25);
    let mid = (x0 + x1) / 2;
    if (tw > avail) mid = ax === 1 ? x1 - tw / 2 - 2 : ax === -1 ? x0 + tw / 2 + 2 : mid;
    g.fillStyle = NUMBER_BOX; g.fillRect(mid - tw / 2 - 2, yEdge - fh, tw + 4, fh);
    g.fillStyle = "#fff"; g.fillText(txt, mid, yEdge - fh / 2);
  }
}
function drawGuesses(g, s, ox, oy) {
  if (!view || !view.guesses.length) return;
  for (const [ax, ay, , , isIn, on] of view.guesses) {
    if (on) continue;
    const r = rrect(ax, ay, ax + 1, ay + 1);
    const x = r[0] * s + ox, y = r[1] * s + oy, mm = s * 0.18;
    const col = isIn ? "#3a8a5c" : "#3a76a6";
    g.strokeStyle = col; g.lineWidth = Math.max(1, s / 30); g.setLineDash([3, 3]);
    g.strokeRect(x + mm, y + mm, s - 2 * mm, s - 2 * mm); g.setLineDash([]);
    if (s >= MIN_DETAIL) { g.fillStyle = col; g.font = `${Math.max(9, Math.floor(s / 3))}px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("+", x + s / 2, y + s / 2); }
  }
}
function renderStatic() {
  const g = staticLayer.getContext("2d");
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.fillStyle = BG; g.fillRect(0, 0, CW, CHH);
  if (!view || !T) { staticOk = true; return; }
  const s = camera.cell, vr = viewRect();
  if (!T.atlas && s < 6) buildAtlas();
  if (T.atlas && s < T.atlas.A * 1.25 && s < 6) {
    const A = T.atlas;
    g.imageSmoothingEnabled = s < A.A;
    g.drawImage(A.c, A.x0 * s + camera.ox, A.y0 * s + camera.oy, A.c.width / A.A * s, A.c.height / A.A * s);
  } else drawStatic(g, s, camera.ox, camera.oy, vr);
  drawGuesses(g, s, camera.ox, camera.oy);
  staticOk = true;
}

// moving dots: every visible belt gets at least one (busiest first), busy belts get extra ones
let dots = [];
function buildDots() {
  dots = [];
  if (!view || !T || !S.anim || camera.cell < MIN_DOT) return;
  const vr = viewRect();
  const cand = [];
  for (const k of inView(T.lchunks, vr[0], vr[1], vr[2], vr[3])) {
    const l = T.links[k];
    for (const [i, v] of l[7]) if (v > 1e-9) cand.push([l, i, v]);
  }
  if (!cand.length) return;
  cand.sort((a, b) => b[2] - a[2]);
  const per = Math.max(1, Math.min(4, Math.floor(MAX_DOTS / cand.length)));
  const count = new Array(cand.length).fill(0);
  let left = MAX_DOTS;
  for (let j = 0; j < cand.length && left > 0; j++) { count[j] = 1; left--; }       // one each first
  for (let j = 0; j < cand.length && left > 0; j++) {                               // then the extras
    const want = Math.max(1, Math.min(per, Math.round(per * cand[j][2] / view.max_flow)));
    const extra = Math.min(want - count[j], left);
    count[j] += extra; left -= extra;
  }
  cand.forEach(([l, i], j) => {
    const n = count[j];
    const col = (view.items[i] || ["", "#ccc"])[1];
    const ph = ((l[0] * 7.13 + l[1] * 3.71 + l[2] * 1.97 + l[3] * 5.3 + i * 0.618) % 1 + 1) % 1;
    for (let k = 0; k < n; k++) dots.push([l, col, ph + k / n]);
  });
  dots.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));    // grouped by colour: one path per colour
}
const t0 = performance.now();
function frame() {
  requestAnimationFrame(frame);
  if (!needFrame && !(dots.length && S.anim)) return;
  needFrame = false;
  if (!staticOk) renderStatic();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(staticLayer, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const s = camera.cell;
  if (dots.length && S.anim) {
    const t = (performance.now() - t0) / 1000 * DOT_SPEED, rr = Math.min(7, Math.max(2.5, s * DOT_SIZE));
    ctx.lineWidth = rr < 5 ? 1 : 1.5; ctx.strokeStyle = DOT_OUTLINE;
    let cur = null;
    const flush = () => { if (cur !== null) { ctx.fill(); ctx.stroke(); } };
    for (const [l, col, ph] of dots) {
      if (col !== cur) { flush(); cur = col; ctx.fillStyle = col; ctx.beginPath(); }
      const f = ((ph + t / l[4]) % 1 + 1) % 1;
      const x = (l[0] + (l[2] - l[0]) * f) * s + camera.ox, y = (l[1] + (l[3] - l[1]) * f) * s + camera.oy;
      if (x < -10 || y < -10 || x > CW + 10 || y > CHH + 10) continue;
      ctx.moveTo(x + rr, y); ctx.arc(x, y, rr, 0, 7);
    }
    flush();
  }
  if (selected && view) {
    const r = rrect(selected[2], selected[3], selected[4], selected[5]);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.strokeRect(r[0] * s + camera.ox - 2, r[1] * s + camera.oy - 2, (r[2] - r[0]) * s + 4, (r[3] - r[1]) * s + 4);
    ctx.setLineDash([]);
  }
}

// ================================================================ touch / mouse
const pointers = new Map();
let gesture = null, lastTap = 0, dotsTimer = null;
function screenToTile(px, py) {
  const u = (px - camera.ox) / camera.cell, v = (py - camera.oy) / camera.cell;
  const [a, b] = Rinv(u, v);
  return [Math.floor(a), Math.floor(b)];
}
function moved() { dirty(true); clearTimeout(dotsTimer); dots = []; dotsTimer = setTimeout(() => { buildDots(); dirty(); }, 150); }
function zoomAt(k, px, py) {
  const c = Math.max(0.25, Math.min(160, camera.cell * k));
  const f = c / camera.cell;
  camera.ox = px - (px - camera.ox) * f; camera.oy = py - (py - camera.oy) * f; camera.cell = c;
  moved();
}
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pointers.size === 1) gesture = { x: e.offsetX, y: e.offsetY, t: performance.now(), moved: false, pinch: false };
  else if (pointers.size === 2 && gesture) gesture.pinch = true;
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  if (pointers.size === 1) {
    const dx = e.offsetX - prev[0], dy = e.offsetY - prev[1];
    camera.ox += dx; camera.oy += dy;
    if (gesture && Math.hypot(e.offsetX - gesture.x, e.offsetY - gesture.y) > 8) gesture.moved = true;
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    moved();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const other = a === prev ? b : a;
    const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
    const d1 = Math.hypot(e.offsetX - other[0], e.offsetY - other[1]);
    const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2], m1 = [(e.offsetX + other[0]) / 2, (e.offsetY + other[1]) / 2];
    camera.ox += m1[0] - m0[0]; camera.oy += m1[1] - m0[1];
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (d0 > 0) zoomAt(d1 / d0, m1[0], m1[1]); else moved();
    if (gesture) gesture.moved = true;
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0 && gesture && !gesture.moved && !gesture.pinch && performance.now() - gesture.t < 500) {
    const now = performance.now();
    if (now - lastTap < 300) { zoomAt(2, e.offsetX, e.offsetY); lastTap = 0; }
    else { lastTap = now; const [x, y] = screenToTile(e.offsetX, e.offsetY); setTimeout(() => { if (lastTap === now) tap(x, y); }, 260); }
  }
  if (pointers.size === 0) gesture = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY); }, { passive: false });

// ================================================================ tile card
let selected = null;       // [x, y, x0, y0, x1, y1]
async function tap(x, y) {
  if (!view || !T) return;
  const k = T.occ.get(x + "," + y);
  if (k !== undefined) { const t = view.tiles[k]; selected = [t[0], t[1], t[2], t[3], t[4], t[5]]; }
  else selected = [x, y, x, y, x + 1, y + 1];
  dirty();
  showInfo(selected[0], selected[1]);
}
async function showInfo(x, y, quiet = false) {
  if (busy && quiet) return;
  try {
    await ready;
    const r = await call("info", { x, y });
    if (!selected || selected[0] !== x || selected[1] !== y) return;
    const empty = /  empty$/.test(r.text) && !r.guess;
    if (empty && !quiet) { hideCard(); return; }
    $("cardText").textContent = r.text;
    const row = $("cardRow"); row.innerHTML = "";
    if (r.guess) {
      const [gx, gy, isIn, on] = r.guess;
      const b = document.createElement("button");
      b.className = on ? "" : "primary";
      b.textContent = on ? `Remove this guessed ${isIn ? "input" : "output"}` : `Use as ${isIn ? "input" : "output"}`;
      b.onclick = () => { guessSet[gx + "," + gy] = !on; selected = null; hideCard(); recalc(); };
      row.appendChild(b);
    }
    $("card").classList.add("show");
    // keep the tapped tile visible above the card
    const box = rrect(selected[2], selected[3], selected[4], selected[5]);
    const bottom = box[3] * camera.cell + camera.oy, top = box[1] * camera.cell + camera.oy;
    const cardTop = $("card").offsetTop - 12;
    if (bottom > cardTop) { camera.oy -= Math.min(bottom - cardTop, Math.max(0, top - 60)); moved(); }
  } catch (e) { /* busy: ignore */ }
}
function hideCard() { $("card").classList.remove("show"); selected = null; dirty(); }

// ================================================================ panel, tabs, buttons
function selectTab(name) {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".page")) p.classList.toggle("on", p.id === "p-" + name);
  store.set("tab", name);
}
for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => selectTab(b.dataset.tab));
for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => {
  totalsMode = b.dataset.mode;
  for (const o of document.querySelectorAll(".seg button")) o.classList.toggle("on", o === b);
  if (view && view.side) fillTotals();
});
for (const b of document.querySelectorAll("[data-test]")) b.addEventListener("click", () => runTest(b.dataset.test));
$("loadBtn").onclick = loadFromServer;
$("bp").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFromServer(); });
$("fileBtn").onclick = () => $("fileIn").click();
$("fileIn").onchange = () => { const f = $("fileIn").files[0]; if (f) loadFromFile(f); $("fileIn").value = ""; };
$("calcBtn").onclick = () => recalc();
$("calc2").onclick = () => recalc();
$("fitBtn").onclick = () => fitView();
$("turnBtn").onclick = () => {
  if (!T) return;
  // keep the middle of the screen in place
  const [u, v] = Rinv((CW / 2 - camera.ox) / camera.cell, (CHH / 2 - camera.oy) / camera.cell);
  rot = (rot + 1) % 4; rebuildRot();
  const [a, b] = R(u, v);
  camera.ox = CW / 2 - a * camera.cell; camera.oy = CHH / 2 - b * camera.cell;
  dirty(true);
};
$("cardX").onclick = hideCard;
$("stopBtn").onclick = stopWorker;
$("allBtn").onclick = () => {
  const v = parseFloat($("allIn").value.replace(",", "."));
  if (Number.isNaN(v)) return;
  for (const el of document.querySelectorAll("#inputs input[data-pos]")) el.value = fmt(v);
  recalc();
};
$("allIn").addEventListener("keydown", (e) => { if (e.key === "Enter") { $("allIn").blur(); $("allBtn").click(); } });
// panel height: drag the grip
(() => {
  let startY = 0, startH = 0;
  const grip = $("grip");
  grip.addEventListener("pointerdown", (e) => { grip.setPointerCapture(e.pointerId); startY = e.clientY; startH = $("panel").getBoundingClientRect().height; });
  grip.addEventListener("pointermove", (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    const h = Math.max(120, Math.min(window.innerHeight * 0.8, startH - (e.clientY - startY)));
    document.documentElement.style.setProperty("--panel-h", h + "px");
    resize();
  });
  grip.addEventListener("pointerup", () => store.set("panelH", getComputedStyle(document.documentElement).getPropertyValue("--panel-h")));
  const saved = store.get("panelH", null);
  if (saved) document.documentElement.style.setProperty("--panel-h", saved);
})();
new ResizeObserver(() => { const keep = camera.set; resize(); if (view && T && !keep) fitView(); }).observe($("mapwrap"));

// ================================================================ start
bindSettings();
selectTab(store.get("tab", "inputs"));
resize();
requestAnimationFrame(frame);
startWorker().then(async () => {
  setStatus("ready — type a blueprint id or link");
  $("loading").textContent = "Type a blueprint id or link above and press Load.";
  const id = qs.get("id") || "";
  $("bp").value = id || store.get("last", "");
  if (id) await loadFromServer();
}).catch((e) => setStatus("could not start the calculator: " + (e.message || e), "error"));
window.__flow = { get dots() { return dots.length; }, openSave, recalc, runTest, tap, zoomAt, get view() { return view; }, camera, fitView, call };
