/**
 * Ship movement and abilities. This is the single implementation used by the
 * authoritative server and by client-side prediction, so it must stay
 * deterministic: the same state, input, stats, bodies and tick must always
 * produce the same result. Keep it free of randomness, wall-clock time and
 * side effects beyond the state object.
 *
 * Space has no drag: ships drift until something changes their course.
 * Thrusters (main, reverse and lateral) cannot push a ship past its cruise
 * speed, or its boost speed while boosting, but gravity can, so dives and
 * slingshots keep their momentum.
 */
import { Button, MAX_SPEED, SHIP_NOSE, TICK_DT, WORLD_SIZE } from './constants.js';
import { applyGravity, collideBodies, orbitAngularSpeed, pullAt } from './gravity.js';
import { angleDiff, normalizeAngle, wrap, wrapDelta } from './math.js';
import { WEAPONS } from './stats.js';

export const StepResult = Object.freeze({
  FIRED: 1,
  THRUST: 2,
  BOOST: 4,
  BRAKE: 8,
  IMPACT: 16, // touched a body's surface; see state.impact
  BLAST: 32, // fired a kinetic blast this step
  LOCKED: 64, // entered an orbit lock
  UNLOCKED: 128, // left an orbit lock
  LOCK_FAILED: 256, // asked to lock with no body in range
});

/** Minimum altitude above a body's surface for an orbit lock. */
export const LOCK_CLEARANCE = 30;

const NO_BODIES = Object.freeze([]);
const hit = { impact: 0, body: null };

/**
 * The ship state that prediction simulates. `impact` and `contactBody` are
 * outputs of the last step. While `lockBody` >= 0 the ship rides a circular
 * orbit around that body: angle `lockPhase + lockDir × lockOmega × (tick -
 * lockEpoch)` at distance `lockRadius`.
 */
export function createShipState() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    energy: 0,
    cooldown: 0,
    boostLock: 0,
    blastCooldown: 0,
    lockBody: -1,
    lockRadius: 0,
    lockPhase: 0,
    lockEpoch: 0,
    lockDir: 1,
    lockOmega: 0,
    impact: 0,
    contactBody: -1,
  };
}

export function copyShipState(to, from) {
  to.x = from.x;
  to.y = from.y;
  to.vx = from.vx;
  to.vy = from.vy;
  to.angle = from.angle;
  to.energy = from.energy;
  to.cooldown = from.cooldown;
  to.boostLock = from.boostLock;
  to.blastCooldown = from.blastCooldown;
  to.lockBody = from.lockBody;
  to.lockRadius = from.lockRadius;
  to.lockPhase = from.lockPhase;
  to.lockEpoch = from.lockEpoch;
  to.lockDir = from.lockDir;
  to.lockOmega = from.lockOmega;
  to.impact = from.impact;
  to.contactBody = from.contactBody;
  return to;
}

/**
 * Advances a ship by one tick of input. `bodies` must be posed for `tick`,
 * the ship's command time. Returns a StepResult bitmask: the caller spawns
 * projectiles on FIRED, applies the blast's push on BLAST and crash damage
 * from `s.impact` on IMPACT.
 */
export function stepShip(s, buttons, aim, st, bodies = NO_BODIES, tick = 0) {
  let result = 0;

  const turn = st.turnRate * TICK_DT;
  if (buttons & Button.AIM) {
    const d = angleDiff(aim, s.angle);
    s.angle = normalizeAngle(s.angle + (d > turn ? turn : d < -turn ? -turn : d));
  } else if (buttons & (Button.LEFT | Button.RIGHT)) {
    if (buttons & Button.LEFT) s.angle -= turn;
    if (buttons & Button.RIGHT) s.angle += turn;
    s.angle = normalizeAngle(s.angle);
  }

  if (buttons & Button.LOCK) {
    if (s.lockBody >= 0) {
      s.lockBody = -1;
      result |= StepResult.UNLOCKED;
    } else {
      result |= lockOrbit(s, st, bodies, tick) ? StepResult.LOCKED : StepResult.LOCK_FAILED;
    }
  }

  // Energy: boost drains it, everything else lets it recharge (integers keep this exact).
  const boosting = (buttons & Button.BOOST) !== 0 && !s.boostLock && s.energy > 0;
  if (boosting) {
    s.energy = Math.max(0, s.energy - st.boostDrain);
    if (s.energy === 0) s.boostLock = 1;
    result |= StepResult.BOOST | StepResult.THRUST;
  } else {
    s.energy = Math.min(st.energyMax, s.energy + st.energyRegen);
    if (s.boostLock && s.energy >= st.boostUnlock) s.boostLock = 0;
  }

  // Thrust in the ship's frame: forward and lateral components.
  let forward = boosting ? st.boostAccel : 0;
  let lateral = 0;
  if (!boosting && buttons & Button.THRUST) forward = st.thrust;
  if (buttons & Button.BACK) forward -= st.thrust * st.backThrust;
  if (buttons & Button.STRAFE_RIGHT) lateral += st.thrust * st.strafeThrust;
  if (buttons & Button.STRAFE_LEFT) lateral -= st.thrust * st.strafeThrust;
  if (forward !== 0 || lateral !== 0) result |= StepResult.THRUST;
  const braking = (buttons & Button.BRAKE) !== 0;

  if (s.blastCooldown > 0) s.blastCooldown--;
  const blasting = (buttons & Button.BLAST) !== 0 && s.blastCooldown === 0 && s.energy >= st.blastCost;
  if (blasting) {
    s.blastCooldown = st.blastInterval;
    s.energy -= st.blastCost;
    result |= StepResult.BLAST;
  }

  // Firing a thruster, braking or the blast's recoil all break an orbit lock.
  if (s.lockBody >= 0 && (forward !== 0 || lateral !== 0 || braking || blasting)) {
    s.lockBody = -1;
    result |= StepResult.UNLOCKED;
  }

  if (s.lockBody >= 0) {
    followLock(s, bodies, tick);
    s.impact = 0;
    s.contactBody = -1;
  } else {
    const ca = Math.cos(s.angle);
    const sa = Math.sin(s.angle);
    if (forward !== 0 || lateral !== 0) {
      const before = s.vx * s.vx + s.vy * s.vy;
      s.vx += (ca * forward - sa * lateral) * TICK_DT;
      s.vy += (sa * forward + ca * lateral) * TICK_DT;
      const cap = boosting ? st.boostSpeed : st.maxSpeed;
      const after = s.vx * s.vx + s.vy * s.vy;
      if (after > cap * cap && after > before) {
        const k = Math.max(cap, Math.sqrt(before)) / Math.sqrt(after); // steer freely, but no faster
        s.vx *= k;
        s.vy *= k;
      }
    }
    if (blasting) {
      s.vx -= ca * st.blastRecoil;
      s.vy -= sa * st.blastRecoil;
    }
    if (braking) {
      result |= StepResult.BRAKE;
      const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
      if (speed > 0) {
        const dv = Math.min(speed, st.brakeAccel * TICK_DT);
        s.vx -= (s.vx / speed) * dv;
        s.vy -= (s.vy / speed) * dv;
      }
    }
    if (bodies.length > 0) applyGravity(s, bodies);

    const speedSq = s.vx * s.vx + s.vy * s.vy;
    if (speedSq > MAX_SPEED * MAX_SPEED) {
      const k = MAX_SPEED / Math.sqrt(speedSq);
      s.vx *= k;
      s.vy *= k;
    }
    s.x = wrap(s.x + s.vx * TICK_DT, WORLD_SIZE);
    s.y = wrap(s.y + s.vy * TICK_DT, WORLD_SIZE);

    if (bodies.length > 0) {
      collideBodies(s, st.radius, bodies, hit);
      s.impact = hit.impact;
      s.contactBody = hit.body ? hit.body.id : -1;
    } else {
      s.impact = 0;
      s.contactBody = -1;
    }
    if (s.impact > 0) result |= StepResult.IMPACT;
  }

  if (s.cooldown > 0) s.cooldown--;
  if (buttons & Button.FIRE && s.cooldown === 0) {
    s.cooldown = st.fireInterval;
    result |= StepResult.FIRED;
  }
  return result;
}

/**
 * Locks the ship into a circular orbit around the body pulling hardest on it,
 * at its current distance (raised to a safe altitude if lower) and keeping its
 * current direction around the body. Returns false outside every gravity well.
 */
export function lockOrbit(s, st, bodies, tick) {
  let best = null;
  let bestPull = 0;
  let bdx = 0;
  let bdy = 0;
  let bd = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dx = wrapDelta(s.x - b.x, WORLD_SIZE);
    const dy = wrapDelta(s.y - b.y, WORLD_SIZE);
    const dSq = dx * dx + dy * dy;
    if (dSq >= b.rangeSq) continue;
    const d = Math.sqrt(dSq);
    const pull = pullAt(b, d);
    if (pull > bestPull) {
      bestPull = pull;
      best = b;
      bdx = dx;
      bdy = dy;
      bd = d;
    }
  }
  if (!best) return false;
  const radius = Math.max(bd, best.radius + st.radius + LOCK_CLEARANCE);
  const spin = bdx * (s.vy - best.vy) - bdy * (s.vx - best.vx);
  s.lockBody = best.id;
  s.lockRadius = radius;
  s.lockPhase = bd > 0 ? Math.atan2(bdy, bdx) : 0;
  s.lockEpoch = tick;
  s.lockDir = spin >= 0 ? 1 : -1;
  s.lockOmega = orbitAngularSpeed(best, radius);
  followLock(s, bodies, tick);
  return true;
}

/** Places an orbit-locked ship on its orbit at `tick`, moving with its body. */
export function followLock(s, bodies, tick) {
  const b = bodies[s.lockBody];
  if (!b) {
    s.lockBody = -1;
    return;
  }
  const a = s.lockPhase + s.lockDir * s.lockOmega * (tick - s.lockEpoch) * TICK_DT;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  s.x = wrap(b.x + c * s.lockRadius, WORLD_SIZE);
  s.y = wrap(b.y + sn * s.lockRadius, WORLD_SIZE);
  const v = s.lockDir * s.lockOmega * s.lockRadius;
  s.vx = b.vx - sn * v;
  s.vy = b.vy + c * v;
}

/**
 * Computes the projectiles for one shot of `weapon` from ship state `s`.
 * Fills `out` with {x, y, vx, vy} objects (reused between calls) and returns
 * how many were written. Projectiles inherit the ship's velocity.
 */
export function computeShots(s, weapon, st, out) {
  const muzzles = (WEAPONS[weapon] ?? WEAPONS[0]).muzzles;
  const ca = Math.cos(s.angle);
  const sa = Math.sin(s.angle);
  for (let i = 0; i < muzzles.length; i++) {
    const spread = muzzles[i][0];
    const lateral = muzzles[i][1];
    const shot = out[i] ?? (out[i] = { x: 0, y: 0, vx: 0, vy: 0 });
    shot.x = wrap(s.x + ca * SHIP_NOSE - sa * lateral, WORLD_SIZE);
    shot.y = wrap(s.y + sa * SHIP_NOSE + ca * lateral, WORLD_SIZE);
    const a = s.angle + spread;
    shot.vx = s.vx + Math.cos(a) * st.bulletSpeed;
    shot.vy = s.vy + Math.sin(a) * st.bulletSpeed;
  }
  return muzzles.length;
}
