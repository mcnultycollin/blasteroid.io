/**
 * Gravity and celestial motion, shared by the server and client-side prediction.
 *
 * A star and planets ("bodies") pull with a mass that comes from their size
 * and density (mass ∝ density × radius³), so a small, dense world can out-pull
 * a large, light one near its surface. Each body's pull follows the
 * inverse-square law out to `fadeStart` (80%) of its range, then fades
 * smoothly to zero at the edge of the range; beyond that it has no effect at
 * all. The range grows with mass: it ends where the inverse-square pull would
 * drop to `edgeAccel`.
 *
 * Bodies move "on rails": each follows a fixed circular orbit around the star
 * (the star itself is fixed), so its position is an exact function of time.
 * Clients compute body positions themselves and they never cost bandwidth.
 *
 * Determinism: gravity itself uses only + - * / and sqrt, which IEEE 754 makes
 * bit-identical in every engine. Body positions use cos/sin, whose last bit
 * can differ between browsers; that is far below anything visible.
 */
import { BodyKind, TICK_DT, WORLD_SIZE } from './constants.js';
import { wrap, wrapDelta } from './math.js';

export const GRAVITY = Object.freeze({
  G: 2.54, // surface pull = G × density × radius (units/s²)
  edgeAccel: 36.25, // a body's range ends where its inverse-square pull falls to this
  fadeStart: 0.8, // fraction of the range at which the pull starts fading out
  landingSpeed: 60, // slower contacts settle on the surface instead of bouncing
  crashSpeed: 120, // faster impacts damage the hull
  bounce: 0.45, // restitution for harder impacts
  surfaceGrip: 0.25, // share of sideways slide removed per tick while resting on a surface
  wellDecay: Math.exp(-0.12 * TICK_DT), // per-tick drag on loose rocks inside a well, relative to the body (orbital decay)
});

/* Bodies ----------------------------------------------------------------- */

/**
 * Creates a star or planet. `orbit` is {cx, cy, radius, phase, omega}: the
 * body circles (cx, cy) at `radius`, its angle `phase + omega × tick`
 * (omega in radians per tick). A radius of 0 keeps the body fixed at (cx, cy).
 */
export function createBody(id, kind, radius, density, name, orbit) {
  const gm = GRAVITY.G * density * radius * radius * radius;
  const range = Math.sqrt(gm / GRAVITY.edgeAccel);
  const body = {
    id,
    kind,
    radius,
    density,
    name,
    orbit,
    gm,
    range,
    rangeSq: range * range,
    fadeFrom: range * GRAVITY.fadeStart,
    surfacePull: gm / (radius * radius),
    x: orbit.cx,
    y: orbit.cy,
    vx: 0,
    vy: 0,
  };
  setPose(body, 0);
  return body;
}

/** Moves a body to where its orbit puts it at `tick` (may be fractional). */
export function setPose(body, tick) {
  const o = body.orbit;
  if (o.radius === 0) {
    body.x = o.cx;
    body.y = o.cy;
    body.vx = 0;
    body.vy = 0;
    return body;
  }
  const a = o.phase + o.omega * tick;
  const c = Math.cos(a);
  const s = Math.sin(a);
  body.x = wrap(o.cx + c * o.radius, WORLD_SIZE);
  body.y = wrap(o.cy + s * o.radius, WORLD_SIZE);
  const v = (o.omega * o.radius) / TICK_DT; // units per second
  body.vx = -s * v;
  body.vy = c * v;
  return body;
}

/**
 * Poses every body for `tick` into `out`, a reusable array of copies, leaving
 * the originals untouched. Used to step a ship at its own command time.
 */
export function poseBodies(bodies, tick, out) {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    let o = out[i];
    if (!o || o.source !== b) o = out[i] = { ...b, source: b };
    setPose(o, tick);
  }
  out.length = bodies.length;
  return out;
}

/* Gravity ----------------------------------------------------------------- */

/** Strength of a body's pull at distance `d` from its centre (0 outside its range). */
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
 * Adds one tick of gravity from every body in range to `b` ({x, y, vx, vy}).
 * Returns the body pulling hardest, or null outside every range.
 */
export function applyGravity(b, bodies) {
  let strongest = null;
  let best = 0;
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i];
    const dx = wrapDelta(p.x - b.x, WORLD_SIZE);
    const dy = wrapDelta(p.y - b.y, WORLD_SIZE);
    const dSq = dx * dx + dy * dy;
    if (dSq >= p.rangeSq || dSq === 0) continue;
    const d = Math.sqrt(dSq);
    const a = pullAt(p, d);
    const k = (a * TICK_DT) / d;
    b.vx += dx * k;
    b.vy += dy * k;
    if (a > best) {
      best = a;
      strongest = p;
    }
  }
  return strongest;
}

/**
 * Total gravitational acceleration at (x, y), written to `out` as {x, y}.
 * Returns the body pulling hardest there, or null outside every range.
 */
export function gravityAt(x, y, bodies, out) {
  out.x = 0;
  out.y = 0;
  let strongest = null;
  let best = 0;
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i];
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

/* Surfaces ---------------------------------------------------------------- */

/**
 * Keeps a round object of `radius` outside every body. Works in each body's
 * moving frame: slow contacts settle and grip the surface, so a landed ship
 * rides along with its planet; faster contacts bounce. Writes the hardest
 * impact speed and the body hit to `hit` ({impact, body}) and returns the speed.
 */
export function collideBodies(b, radius, bodies, hit) {
  hit.impact = 0;
  hit.body = null;
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i];
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
    let rvx = b.vx - p.vx;
    let rvy = b.vy - p.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const landing = -vn <= GRAVITY.landingSpeed;
      const restitution = landing ? 0 : GRAVITY.bounce;
      rvx -= (1 + restitution) * vn * nx;
      rvy -= (1 + restitution) * vn * ny;
      if (landing) {
        const slide = rvx * -ny + rvy * nx; // tangential speed over the surface
        rvx -= -ny * slide * GRAVITY.surfaceGrip;
        rvy -= nx * slide * GRAVITY.surfaceGrip;
      }
      b.vx = p.vx + rvx;
      b.vy = p.vy + rvy;
      if (-vn > hit.impact) {
        hit.impact = -vn;
        hit.body = p;
      }
    }
  }
  return hit.impact;
}

/** True if a round object of `radius` at (x, y) overlaps any body. */
export function insideBody(x, y, radius, bodies) {
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i];
    const dx = wrapDelta(x - p.x, WORLD_SIZE);
    const dy = wrapDelta(y - p.y, WORLD_SIZE);
    const r = p.radius + radius;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/* Free motion and orbits ------------------------------------------------------ */

/**
 * One tick of unpowered motion for a loose rock: gravity, orbital decay
 * inside a well (relative to the body it orbits, as if through a thin
 * atmosphere that moves with the planet), then drift. Identical on the server
 * and when the client extrapolates. Returns true while inside a well.
 */
export function stepBallistic(b, bodies) {
  const host = applyGravity(b, bodies);
  if (host) {
    b.vx = host.vx + (b.vx - host.vx) * GRAVITY.wellDecay;
    b.vy = host.vy + (b.vy - host.vy) * GRAVITY.wellDecay;
  }
  b.x = wrap(b.x + b.vx * TICK_DT, WORLD_SIZE);
  b.y = wrap(b.y + b.vy * TICK_DT, WORLD_SIZE);
  return host !== null;
}

/** Angular speed (rad/s) of a circular orbit of radius `r`; valid for the faded pull too. */
export function orbitAngularSpeed(p, r) {
  return Math.sqrt(pullAt(p, r) / r);
}

/** Angle of a circular orbit ({radius, phase, epoch, dir, omega}, omega in rad/s) at `tick`. */
export function orbitAngle(orbit, tick) {
  return orbit.phase + orbit.dir * orbit.omega * (tick - orbit.epoch) * TICK_DT;
}

/**
 * Position and velocity on a circular orbit around body `p` at `tick`
 * (may be fractional), written to `out`. `p` must be posed for the same tick;
 * the orbit's velocity includes the body's own motion around the star.
 */
export function orbitState(p, orbit, tick, out) {
  const a = orbitAngle(orbit, tick);
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = wrap(p.x + c * orbit.radius, WORLD_SIZE);
  out.y = wrap(p.y + s * orbit.radius, WORLD_SIZE);
  const v = orbit.dir * orbit.omega * orbit.radius;
  out.vx = p.vx - s * v;
  out.vy = p.vy + c * v;
  return out;
}

/** The body whose pull is strongest at (x, y), or null outside every range. */
export function dominantBody(x, y, bodies) {
  let strongest = null;
  let best = 0;
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i];
    const dx = wrapDelta(p.x - x, WORLD_SIZE);
    const dy = wrapDelta(p.y - y, WORLD_SIZE);
    const dSq = dx * dx + dy * dy;
    if (dSq >= p.rangeSq) continue;
    const a = pullAt(p, Math.sqrt(dSq));
    if (a > best) {
      best = a;
      strongest = p;
    }
  }
  return strongest;
}

export const OrbitState = Object.freeze({ STABLE: 'stable', IMPACT: 'impact', ESCAPE: 'escape' });

/**
 * Classifies free flight around `body` from position and velocity, using the
 * two-body (Kepler) solution: a stable orbit stays clear of the surface and
 * inside the range; otherwise it ends in an impact or an escape. Writes
 * {state, periapsis, apoapsis} (distances from the centre) to `out`.
 */
export function describeOrbit(x, y, vx, vy, body, clearance, out) {
  const rx = wrapDelta(x - body.x, WORLD_SIZE);
  const ry = wrapDelta(y - body.y, WORLD_SIZE);
  const r = Math.sqrt(rx * rx + ry * ry) || 1;
  const rvx = vx - body.vx;
  const rvy = vy - body.vy;
  const mu = body.gm;
  const energy = (rvx * rvx + rvy * rvy) / 2 - mu / r;
  const h = rx * rvy - ry * rvx;
  if (energy >= 0) {
    out.state = OrbitState.ESCAPE;
    out.periapsis = r;
    out.apoapsis = Infinity;
    return out;
  }
  const a = -mu / (2 * energy);
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  out.periapsis = a * (1 - e);
  out.apoapsis = a * (1 + e);
  out.state =
    out.periapsis < body.radius + clearance
      ? OrbitState.IMPACT
      : out.apoapsis > body.range
        ? OrbitState.ESCAPE
        : OrbitState.STABLE;
  return out;
}

export const isStar = (body) => body.kind === BodyKind.STAR;
