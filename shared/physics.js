/**
 * Ship movement and firing. This is the single implementation used by the
 * authoritative server and by client-side prediction, so it must stay
 * deterministic: the same state, input and stats must always produce the same
 * result. Keep it free of randomness, wall-clock time and side effects.
 */
import { Button, MAX_SPEED, SHIP_NOSE, SHIP_RADIUS, TICK_DT, WORLD_SIZE } from './constants.js';
import { applyGravity, collidePlanets } from './gravity.js';
import { angleDiff, normalizeAngle, wrap } from './math.js';
import { WEAPONS } from './stats.js';

export const StepResult = Object.freeze({ FIRED: 1, THRUST: 2, BOOST: 4, BRAKE: 8, IMPACT: 16 });

const NO_PLANETS = Object.freeze([]);

/** The subset of ship state that prediction needs to simulate. `impact` is an output of the last step. */
export function createShipState() {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, energy: 0, cooldown: 0, boostLock: 0, impact: 0 };
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
  to.impact = from.impact;
  return to;
}

/**
 * Advances a ship by one tick of input, including planetary gravity and
 * planet surface contact (both deterministic, since planets never move).
 * Returns a StepResult bitmask; the caller spawns projectiles when FIRED is
 * set and applies crash damage from `s.impact` when IMPACT is set.
 */
export function stepShip(s, buttons, aim, st, planets = NO_PLANETS) {
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

  let accel = 0;
  if (buttons & Button.BOOST && !s.boostLock && s.energy > 0) {
    s.energy = Math.max(0, s.energy - st.boostDrain);
    if (s.energy === 0) s.boostLock = 1;
    accel = st.boostAccel;
    result |= StepResult.BOOST | StepResult.THRUST;
  } else {
    s.energy = Math.min(st.energyMax, s.energy + st.energyRegen);
    if (s.boostLock && s.energy >= st.boostUnlock) s.boostLock = 0;
    if (buttons & Button.THRUST) {
      accel = st.thrust;
      result |= StepResult.THRUST;
    }
  }
  if (accel !== 0) {
    s.vx += Math.cos(s.angle) * accel * TICK_DT;
    s.vy += Math.sin(s.angle) * accel * TICK_DT;
  }

  if (planets.length > 0) applyGravity(s, planets);

  let drag = st.dragFactor;
  if (buttons & Button.BRAKE) {
    drag = st.brakeFactor;
    result |= StepResult.BRAKE;
  }
  s.vx *= drag;
  s.vy *= drag;

  const speedSq = s.vx * s.vx + s.vy * s.vy;
  if (speedSq > MAX_SPEED * MAX_SPEED) {
    const k = MAX_SPEED / Math.sqrt(speedSq);
    s.vx *= k;
    s.vy *= k;
  }

  s.x = wrap(s.x + s.vx * TICK_DT, WORLD_SIZE);
  s.y = wrap(s.y + s.vy * TICK_DT, WORLD_SIZE);
  s.impact = planets.length > 0 ? collidePlanets(s, SHIP_RADIUS, planets) : 0;
  if (s.impact > 0) result |= StepResult.IMPACT;

  if (s.cooldown > 0) s.cooldown--;
  if (buttons & Button.FIRE && s.cooldown === 0) {
    s.cooldown = st.fireInterval;
    result |= StepResult.FIRED;
  }
  return result;
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
