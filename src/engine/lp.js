// Linear programs with HiGHS (WebAssembly). The page / worker loads HiGHS once and hands it over.
let highs = null;

/** give the loaded HiGHS module to the engine */
export function setHighs(h) { highs = h; }
export function hasHighs() { return highs !== null; }

/**
 * Solve min c'x, rowLower <= A x <= rowUpper, colLower <= x <= colUpper.
 * A as CSC: {starts, indices, values}. Returns {ok, x, dual} (dual = reduced cost per column).
 */
export function solveLP({ numCols, numRows, colCost, colLower, colUpper, rowLower, rowUpper, starts, indices, values }) {
  if (!highs) throw new Error("HiGHS is not loaded");
  const inf = highs.infinity ?? Infinity;
  const fix = (a) => Float64Array.from(a, (v) => (v === Infinity ? inf : v === -Infinity ? -inf : v));
  const model = highs.createModel({
    numCols, numRows, colCost: Float64Array.from(colCost), colLower: fix(colLower), colUpper: fix(colUpper),
    rowLower: fix(rowLower), rowUpper: fix(rowUpper),
    matrix: { format: "csc", numRows, numCols, starts: Int32Array.from(starts), indices: Int32Array.from(indices), values: Float64Array.from(values) },
  });
  try {
    model.options.set({ output_flag: false });
    model.run();
    const status = model.getModelStatus();
    const ok = status === (highs.constants?.modelStatus?.optimal ?? 7);
    if (!ok) return { ok: false };
    const sol = model.getSolution();
    return { ok: true, x: sol.colValue, dual: sol.colDual };
  } finally {
    model.dispose();
  }
}

/** build CSC arrays from (row, col, value) triplets (duplicates are added up) */
export function toCSC(rows, cols, vals, numCols) {
  const count = new Int32Array(numCols + 1);
  for (const c of cols) count[c + 1]++;
  for (let c = 0; c < numCols; c++) count[c + 1] += count[c];
  const starts = Int32Array.from(count), pos = Int32Array.from(count.subarray(0, numCols));
  const indices = new Int32Array(rows.length), values = new Float64Array(rows.length);
  for (let t = 0; t < rows.length; t++) { const p = pos[cols[t]]++; indices[p] = rows[t]; values[p] = vals[t]; }
  // merge duplicates within each column
  const outS = [0], outI = [], outV = [];
  for (let c = 0; c < numCols; c++) {
    const seg = [];
    for (let p = starts[c]; p < starts[c + 1]; p++) seg.push([indices[p], values[p]]);
    seg.sort((a, b) => a[0] - b[0]);
    for (const [r, v] of seg) {
      if (outI.length > outS[outS.length - 1] && outI[outI.length - 1] === r) outV[outV.length - 1] += v;
      else { outI.push(r); outV.push(v); }
    }
    outS.push(outI.length);
  }
  return { starts: outS, indices: outI, values: outV };
}
