// Background worker: runs the calculations so the page stays smooth.
import { setHighs } from "./engine/lp.js";
import { loadSave, solve, tileInfo, runTest } from "./engine/view.js";

const send = (m) => postMessage(m);

// HiGHS (linear programs: exact balancing of loops and "why the output isn't higher").
// Loaded in the background; without it everything still works, only those two extras are skipped.
const highsReady = (async () => {
  try {
    const { default: Module } = await import("../vendor/highs.mjs");
    const wasm = new URL("../vendor/highs.wasm", import.meta.url).href;
    setHighs(await Module({ locateFile: () => wasm }));
    return true;
  } catch (err) {
    send({ type: "status", text: "could not load the LP solver (" + (err.message || err) + "), continuing without it" });
    return false;
  }
})();

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    let result;
    if (cmd === "init") result = await highsReady;
    else if (cmd === "load") result = loadSave(args.save, args.name);
    else {
      await highsReady;
      if (cmd === "solve") result = solve(args.settings);
      else if (cmd === "info") result = tileInfo(args.x, args.y);
      else if (cmd === "test") result = runTest(args.kind, args.settings, (d, t) => send({ type: "progress", d, t }));
      else throw new Error("unknown command " + cmd);
    }
    send({ id, ok: true, result });
  } catch (err) {
    console.error(err);
    send({ id, ok: false, error: String((err && err.message) || err) });
  }
};
