/** Small math helpers shared by the server and the client. */

export const TAU = Math.PI * 2;

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Wraps a coordinate into [0, size). */
export function wrap(v, size) {
  if (v >= 0 && v < size) return v;
  v %= size;
  if (v < 0) v += size;
  return v >= size ? 0 : v; // tiny negatives can round up to exactly `size`
}

/** Shortest signed offset equivalent to `d` on a ring of `size`, in [-size/2, size/2). */
export function wrapDelta(d, size) {
  const half = size / 2;
  if (d >= -half && d < half) return d;
  d %= size;
  if (d < -half) d += size;
  else if (d >= half) d -= size;
  return d;
}

/** Interpolates between two wrapped coordinates along the shortest path. */
export function wrapLerp(a, b, t, size) {
  return wrap(a + wrapDelta(b - a, size) * t, size);
}

/** Normalises an angle into [0, TAU). */
export function normalizeAngle(a) {
  if (a >= 0 && a < TAU) return a;
  a %= TAU;
  if (a < 0) a += TAU;
  return a >= TAU ? 0 : a;
}

/** Signed shortest rotation from `from` to `to`, in [-PI, PI). */
export function angleDiff(to, from) {
  let d = (to - from) % TAU;
  if (d < -Math.PI) d += TAU;
  else if (d >= Math.PI) d -= TAU;
  return d;
}

export function lerpAngle(a, b, t) {
  return normalizeAngle(a + angleDiff(b, a) * t);
}

/**
 * Swept point-vs-circle test on a torus: the segment starts at (px, py) and
 * moves by (dx, dy). Returns the fraction of the segment in [0, 1] at first
 * contact with the circle at (cx, cy) of radius r, or -1 for no contact.
 */
export function segmentCircleHit(px, py, dx, dy, cx, cy, r, size) {
  const ox = wrapDelta(cx - px, size);
  const oy = wrapDelta(cy - py, size);
  const c = ox * ox + oy * oy - r * r;
  if (c <= 0) return 0; // starts inside
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = ox * dx + oy * dy;
  if (b <= 0) return -1; // moving away
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : -1;
}

/**
 * Time until a projectile fired at `speed` from the origin meets a target at
 * offset (dx, dy) moving with velocity (vx, vy). Returns -1 if it never can.
 */
export function interceptTime(dx, dy, vx, vy, speed) {
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : -1;
}

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit integer hash, used to derive per-entity cosmetic seeds. */
export function hash32(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
