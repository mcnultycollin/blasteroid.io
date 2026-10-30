/**
 * Planetary gravity, shared by the server and client-side prediction.
 *
 * A planet's mass comes from its size and density (mass ∝ density × radius³),
 * so a small, dense world can out-pull a large, light one near its surface.
 * The pull follows the inverse-square law out to `fadeStart` (80%) of the planet's
 * range, then fades smoothly to zero at the edge of the range; beyond that the
 * planet has no effect at all. The range itself grows with mass: it ends where
 * the inverse-square pull would drop to `edgeAccel`.
 *
 * Gravity math uses only + - * / and sqrt, which IEEE 754 makes bit-identical
 * in every JavaScript engine, so the client predicts gravity exactly.
 */
import { TICK_DT, WORLD_SIZE } from './constants.js';
import { wrap, wrapDelta } from './math.js';

export const GRAVITY = Object.freeze({
  G: 1.75, // surface pull = G × density × radius (units/s²)
  edgeAccel: 25, // the range ends where the inverse-square pull falls to this
  fadeStart: 0.8, // fraction of the range at which the pull starts fading out
  landingSpeed: 60, // slower contacts settle on the surface instead of bouncing
  bounce: 0.45, // restitution for harder impacts
  wellDecay: Math.exp(-0.12 * TICK_DT), // per-tick drag on free rocks inside a well (orbital decay)
});

/** Derives a planet's mass, range and surface pull from its size and density. */
export function createPlanet(id, x, y, radius, density, name) {
  const gm = GRAVITY.G * density * radius * radius * radius;
  const range = Math.sqrt(gm / GRAVITY.edgeAccel);
  return {
    id,
    x,
    y,
    radius,
    density,
    name,
    gm,
    range,
    rangeSq: range * range,
    fadeFrom: range * GRAVITY.fadeStart,
    surfacePull: gm / (radius * radius),
  };
}

/** Strength of a planet's pull at distance `d` from its centre (0 outside its range). */
export function pullAt(p, d) {
  if (d >= p.range) return 0;
  const r = d > p.radius ? d : p.radius;
  let a = p.gm / (r * r);
  if (d > p.fadeFrom) {
    const t = (d - p.fadeFrom) / (p.range - p.fadeFrom);
    a *= 1 - t * t * (3 - 2 * t); // smoothstep to zero: no kink at the edge
  }
  return a;
}

/**
 * Adds one tick of gravity from every planet in range to body `b`
 * ({x, y, vx, vy}). Returns true if any planet pulled on it.
 */
export function applyGravity(b, planets) {
  let pulled = false;
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const dx = wrapDelta(p.x - b.x, WORLD_SIZE);
    const dy = wrapDelta(p.y - b.y, WORLD_SIZE);
    const dSq = dx * dx + dy * dy;
    if (dSq >= p.rangeSq || dSq === 0) continue;
    const d = Math.sqrt(dSq);
    const k = (pullAt(p, d) * TICK_DT) / d;
    b.vx += dx * k;
    b.vy += dy * k;
    pulled = true;
  }
  return pulled;
}

/**
 * Total gravitational acceleration at (x, y), written to `out` as {x, y}.
 * Returns the planet pulling hardest there, or null outside every range.
 */
export function gravityAt(x, y, planets, out) {
  out.x = 0;
  out.y = 0;
  let strongest = null;
  let best = 0;
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const dx = wrapDelta(p.x - x, WORLD_SIZE);
    const dy = wrapDelta(p.y - y, WORLD_SIZE);
    const dSq = dx * dx + dy * dy;
    if (dSq >= p.rangeSq || dSq === 0) continue;
    const d = Math.sqrt(dSq);
    const a = pullAt(p, d);
    out.x += (dx / d) * a;
    out.y += (dy / d) * a;
    if (a > best) {
      best = a;
      strongest = p;
    }
  }
  return strongest;
}

/**
 * Keeps a round body of `radius` outside every planet. Slow contacts settle
 * on the surface (landing); faster ones bounce. Returns the impact speed into
 * the surface, or 0 without contact.
 */
export function collidePlanets(b, radius, planets) {
  let impact = 0;
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const dx = wrapDelta(b.x - p.x, WORLD_SIZE);
    const dy = wrapDelta(b.y - p.y, WORLD_SIZE);
    const minD = p.radius + radius;
    const dSq = dx * dx + dy * dy;
    if (dSq >= minD * minD) continue;
    const d = Math.sqrt(dSq);
    const nx = d > 0 ? dx / d : 1;
    const ny = d > 0 ? dy / d : 0;
    b.x = wrap(p.x + nx * minD, WORLD_SIZE);
    b.y = wrap(p.y + ny * minD, WORLD_SIZE);
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const restitution = -vn > GRAVITY.landingSpeed ? GRAVITY.bounce : 0;
      b.vx -= (1 + restitution) * vn * nx;
      b.vy -= (1 + restitution) * vn * ny;
      if (-vn > impact) impact = -vn;
    }
  }
  return impact;
}

/** True if a round body of `radius` at (x, y) overlaps any planet. */
export function insidePlanet(x, y, radius, planets) {
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const dx = wrapDelta(x - p.x, WORLD_SIZE);
    const dy = wrapDelta(y - p.y, WORLD_SIZE);
    const r = p.radius + radius;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/**
 * One tick of free (unpowered) motion: gravity, orbital decay inside wells,
 * then drift. Used for rocks knocked loose inside a gravity well, identically
 * on the server and when the client extrapolates them. Returns true if in a well.
 */
export function stepBallistic(b, planets) {
  const inWell = applyGravity(b, planets);
  if (inWell) {
    b.vx *= GRAVITY.wellDecay;
    b.vy *= GRAVITY.wellDecay;
  }
  b.x = wrap(b.x + b.vx * TICK_DT, WORLD_SIZE);
  b.y = wrap(b.y + b.vy * TICK_DT, WORLD_SIZE);
  return inWell;
}

/** Angular speed (rad/s) of a circular orbit of radius `r`; valid for the faded pull too. */
export function orbitAngularSpeed(p, r) {
  return Math.sqrt(pullAt(p, r) / r);
}

/**
 * Position and velocity on a circular orbit at `tick` (may be fractional),
 * written to `out`. `orbit` is {radius, phase, epoch, dir, omega}: the angle
 * was `phase` at tick `epoch` and advances by `dir × omega` rad/s. Orbits are
 * exact functions of time, so orbiting rocks never need position updates.
 */
export function orbitState(p, orbit, tick, out) {
  const a = orbit.phase + orbit.dir * orbit.omega * (tick - orbit.epoch) * TICK_DT;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = wrap(p.x + c * orbit.radius, WORLD_SIZE);
  out.y = wrap(p.y + s * orbit.radius, WORLD_SIZE);
  const v = orbit.dir * orbit.omega * orbit.radius;
  out.vx = -s * v;
  out.vy = c * v;
  return out;
}

/** Current angle of an orbit at `tick`. */
export function orbitAngle(orbit, tick) {
  return orbit.phase + orbit.dir * orbit.omega * (tick - orbit.epoch) * TICK_DT;
}
