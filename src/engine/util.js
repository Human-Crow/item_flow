// Small helpers shared by the flow engine.

// ---------------------------------------------------------------- positions
// A tile position is kept as one number, so it can be a Map key and sorts like (x, y):
// key = (x + OFF) * M + (y + OFF). Works for |x|, |y| < 2^20.
const OFF = 2 ** 20;
const M = 2 ** 21;

/** (x, y) -> key */
export function pk(x, y) { return (x + OFF) * M + (y + OFF); }
/** key -> x */
export function px(k) { return Math.floor(k / M) - OFF; }
/** key -> y */
export function py(k) { return (k % M) - OFF; }
/** key moved by (dx, dy) */
export function padd(k, dx, dy) { return k + dx * M + dy; }
/** where items end (output arms, end points): sorts after every tile */
export const SINK = 2 ** 52;
/** "(x, y)" like Python prints a tuple */
export function P(k) { return k === SINK ? "(1000000000, 1000000000)" : `(${px(k)}, ${py(k)})`; }

// North points to -y. Orientation: 0 North, 1 West, 2 South, 3 East (the worker's convention)
export const DIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];
/** the two sides of direction d */
export function sides(d) { return [[d[1], -d[0]], [-d[1], d[0]]]; }

// ---------------------------------------------------------------- numbers
export const EPS = 1e-9;
export const INF = Infinity;

/** Plain number, never scientific notation: 480, 6.6667, 0.0001, 1500000. */
/** like Python's f"{v:.{d}f}": exact ties (14.0625 -> 3 decimals) round to even, toFixed rounds them up */
export function pyFixed(v, d) {
  let t = v.toFixed(d);
  if (!Number.isFinite(v) || Math.abs(v) >= 1e21) return t;
  const long = Math.abs(v).toFixed(Math.min(100, d + 25));
  const k = long.indexOf(".") + d + 1;          // the first dropped digit
  if (long[k] === "5" && /^0*$/.test(long.slice(k + 1))) {
    const last = d ? long[k - 1] : long[long.indexOf(".") - 1];
    if (Number(last) % 2 === 0) t = (v < 0 ? "-" : "") + long.slice(0, d ? k : k - 1);   // keep the even digit
  }
  return t;
}
export function fmtNum(v, decimals = 4) {
  let t = pyFixed(Number(v), decimals);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" || t === "" ? "0" : t;
}

/** sum of a Map's values */
export function msum(m) { let s = 0; for (const v of m.values()) s += v; return s; }

/** Map of item -> amount, without the tiny ones */
export function clean(m, eps = EPS) {
  const out = new Map();
  for (const [i, v] of m) if (v > eps) out.set(i, v);
  return out;
}

// ---------------------------------------------------------------- binary heap of [rank, key]
export class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  static less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------- seeded random (tests)
/** Mulberry32: small, fast, repeatable random numbers in [0, 1) */
export function seededRandom(seed) {
  let s = (seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- exact fractions (BigInt)
function bgcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; }

export class Fraction {
  constructor(n, d = 1n) {
    n = BigInt(n); d = BigInt(d);
    if (d === 0n) throw new Error("division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = bgcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  static of(x) { return x instanceof Fraction ? x : Fraction.fromNumber(x); }
  /** exact value of a float (like Python's Fraction(float)) */
  static fromNumber(x) {
    if (Number.isInteger(x)) return new Fraction(BigInt(x));
    let d = 1n;
    while (!Number.isInteger(x)) { x *= 2; d *= 2n; }
    return new Fraction(BigInt(x), d);
  }
  /** from a decimal string like "120" or "333.3" (like Python's Fraction(str)) */
  static fromString(s) {
    const [a, b = ""] = String(s).split(".");
    return new Fraction(BigInt(a + b), 10n ** BigInt(b.length));
  }
  add(o) { o = Fraction.of(o); return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = Fraction.of(o); return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = Fraction.of(o); return new Fraction(this.n * o.n, this.d * o.d); }
  div(o) { o = Fraction.of(o); return new Fraction(this.n * o.d, this.d * o.n); }
  isZero() { return this.n === 0n; }
  eq(o) { o = Fraction.of(o); return this.n === o.n && this.d === o.d; }
  valueOf() { return Number(this.n) / Number(this.d); }
  toNumber() {
    // precise for big numerators / denominators
    const n = this.n, d = this.d;
    const q = Number(n / d), r = n % d;
    return q + Number(r * 10n ** 17n / d) / 1e17;
  }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
  /** closest fraction with a denominator up to maxDen (like Python's limit_denominator) */
  limitDenominator(maxDen) {
    maxDen = BigInt(maxDen);
    if (this.d <= maxDen) return this;
    let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
    let n = this.n, d = this.d;
    for (;;) {
      const a = n / d;
      const q2 = q0 + a * q1;
      if (q2 > maxDen) break;
      [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
      [n, d] = [d, n - a * d];
      if (d === 0n) break;
    }
    const k = (maxDen - q0) / q1;
    const b1 = new Fraction(p0 + k * p1, q0 + k * q1);
    const b2 = new Fraction(p1, q1);
    const e1 = b2.sub(this), e2 = b1.sub(this);
    const abs = (f) => (f.n < 0n ? new Fraction(-f.n, f.d) : f);
    const a1 = abs(e1), a2 = abs(e2);
    return a1.n * a2.d <= a2.n * a1.d ? b2 : b1;
  }
}
export function lcmBig(a, b) { return a / bgcd(a, b) * b; }
