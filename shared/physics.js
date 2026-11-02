/**
 * Ship movement and abilities. This is the single implementation used by the
 * authoritative server and by client-side prediction, so it must stay
 * deterministic: the same state, input, stats, bodies and tick must always
 * produce the same result. Keep it free of randomness, wall-clock time and
 * side effects beyond the state object.
 *
 * Flight model:
 *  - Thrusters: the main engine and reverse/lateral thrusters push along the
 *    ship's own axes; the screen-direction thrusters (MOVE_*) push up, down,
 *    left or right whatever way the ship faces. None can push a ship past its
 *    cruise speed (or boost speed while boosting), but gravity can, so dives
 *    and slingshots keep their momentum.
 *  - Coasting: with no thruster firing, a ship in open space slows towards
 *    its coast speed and then holds it. Inside a gravity well there is no
 *    drag at all, so orbits and slingshots behave like real ones; the drag
 *    fades in across the outer edge of each well.
 *  - Fuel: thrusters burn it every tick they fire. Landing gently on a planet
 *    refuels; an empty tank leaves only weak reserve thrusters.
 */
import { BodyKind, Button, MAX_SPEED, MOVE_BUTTONS, TICK_DT, WORLD_SIZE } from './constants.js';
import { GRAVITY, applyGravity, collideBodies, dominantBody, orbitAngularSpeed, pullAt } from './gravity.js';
import { angleDiff, normalizeAngle, wrap, wrapDelta } from './math.js';
import { Ability, WEAPONS } from './stats.js';

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
  ABILITY: 512, // activated the class ability this step
  REFUEL: 1024, // took on fuel while landed
});

/** Minimum altitude above a body's surface for an orbit lock. */
export const LOCK_CLEARANCE = 30;

const NO_BODIES = Object.freeze([]);
const SHIP_FRAME_THRUSTERS = Button.BACK | Button.STRAFE_LEFT | Button.STRAFE_RIGHT;
const hit = { impact: 0, body: null };
/** This step's thrust, in the ship's frame (forward, lateral) and the world's (x, y). */
const thrust = { forward: 0, lateral: 0, x: 0, y: 0 };

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
    fuel: 0,
    cooldown: 0,
    boostLock: 0,
    blastCooldown: 0,
    abilityCooldown: 0,
    abilityTime: 0, // ticks left of an active ability (dash, ram drive)
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
  to.fuel = from.fuel;
  to.cooldown = from.cooldown;
  to.boostLock = from.boostLock;
  to.blastCooldown = from.blastCooldown;
  to.abilityCooldown = from.abilityCooldown;
  to.abilityTime = from.abilityTime;
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
 * the ship's command time; `fields` are the temporary gravity fields acting
 * on this ship at that tick (see fieldsAt). Returns a StepResult bitmask: the
 * caller spawns projectiles on FIRED, applies the blast's push on BLAST, the
 * class ability's effect on ABILITY and crash damage from `s.impact` on IMPACT.
 *
 * Abilities that move the ship are simulated here, so they are predicted:
 * the Fighter's afterburner kicks the ship towards its held thrusters; the
 * Breaker's ram drive charges forward and lifts the speed limit while it lasts.
 */
export function stepShip(s, buttons, aim, st, bodies = NO_BODIES, tick = 0, fields = NO_BODIES) {
  let result = 0;
  rotate(s, buttons, aim, st);
  if (buttons & Button.LOCK) result |= toggleLock(s, st, bodies, tick);

  const boosting = updateEnergy(s, buttons, st);
  if (boosting) result |= StepResult.BOOST;
  const power = s.fuel > 0 ? 1 : st.reservePower; // an empty tank leaves reserve thrusters
  planThrust(buttons, st, boosting, power);
  const braking = (buttons & Button.BRAKE) !== 0;
  const thrusting = thrust.forward !== 0 || thrust.lateral !== 0 || thrust.x !== 0 || thrust.y !== 0;
  if (thrusting) result |= StepResult.THRUST;
  burnFuel(s, st, buttons, boosting, braking);

  if (s.blastCooldown > 0) s.blastCooldown--;
  const blasting = (buttons & Button.BLAST) !== 0 && s.blastCooldown === 0 && s.energy >= st.blastCost;
  if (blasting) {
    s.blastCooldown = st.blastInterval;
    s.energy -= st.blastCost;
    result |= StepResult.BLAST;
  }

  if (s.abilityCooldown > 0) s.abilityCooldown--;
  if (s.abilityTime > 0) s.abilityTime--;
  const activated = (buttons & Button.ABILITY) !== 0 && s.abilityCooldown === 0 && s.energy >= st.abilityCost;
  if (activated) {
    s.abilityCooldown = st.abilityCooldown;
    s.abilityTime = st.abilityDuration;
    s.energy -= st.abilityCost;
    result |= StepResult.ABILITY;
  }
  const dash = activated && st.ability === Ability.DASH;
  const charge = activated && st.ability === Ability.RAM;
  const rushing = st.ability === Ability.RAM && s.abilityTime > 0;
  if (rushing && thrust.forward < st.thrust) thrust.forward = st.thrust; // the ram drive burns on its own, without fuel

  // Thrusters, the brake, the blast's recoil, a dash or a charge all break an
  // orbit lock, and so does an enemy singularity's pull.
  if (
    s.lockBody >= 0 &&
    (thrusting || rushing || braking || blasting || dash || (fields.length > 0 && dominantBody(s.x, s.y, fields)))
  ) {
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
    applyThrust(s, ca, sa, rushing ? st.rushSpeed : boosting ? st.boostSpeed : st.maxSpeed);
    if (blasting) {
      s.vx -= ca * st.blastRecoil;
      s.vy -= sa * st.blastRecoil;
    }
    if (dash) afterburner(s, buttons, ca, sa, st.abilityImpulse);
    if (charge) {
      s.vx += ca * st.abilityImpulse;
      s.vy += sa * st.abilityImpulse;
    }
    if (braking) {
      result |= StepResult.BRAKE;
      brake(s, st.brakeAccel * power * TICK_DT);
    }

    // Gravity, then (only where gravity is weak) coasting drag.
    const vx = s.vx;
    const vy = s.vy;
    if (bodies.length > 0) applyGravity(s, bodies);
    if (fields.length > 0) applyGravity(s, fields);
    if (!thrusting && !rushing) {
      const pull = Math.sqrt((s.vx - vx) * (s.vx - vx) + (s.vy - vy) * (s.vy - vy)) / TICK_DT;
      coast(s, st, 1 - pull / GRAVITY.edgeAccel);
    }

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
      // Resting on a planet (not the star) tops up the tank.
      if (hit.body && hit.impact <= GRAVITY.landingSpeed && hit.body.kind !== BodyKind.STAR && s.fuel < st.fuelMax) {
        s.fuel = Math.min(st.fuelMax, s.fuel + st.fuelRefuel);
        result |= StepResult.REFUEL;
      }
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

/* Stages of a step ------------------------------------------------------------ */

/** Turns towards the aim angle at the turn rate, or with the rotate buttons. */
function rotate(s, buttons, aim, st) {
  const turn = st.turnRate * TICK_DT;
  if (buttons & Button.AIM) {
    const d = angleDiff(aim, s.angle);
    s.angle = normalizeAngle(s.angle + (d > turn ? turn : d < -turn ? -turn : d));
  } else if (buttons & (Button.LEFT | Button.RIGHT)) {
    if (buttons & Button.LEFT) s.angle -= turn;
    if (buttons & Button.RIGHT) s.angle += turn;
    s.angle = normalizeAngle(s.angle);
  }
}

function toggleLock(s, st, bodies, tick) {
  if (s.lockBody >= 0) {
    s.lockBody = -1;
    return StepResult.UNLOCKED;
  }
  return lockOrbit(s, st, bodies, tick) ? StepResult.LOCKED : StepResult.LOCK_FAILED;
}

/**
 * Boost drains energy (and needs fuel); everything else lets energy recharge.
 * Integers keep this exact. Returns whether the ship boosts this step.
 */
function updateEnergy(s, buttons, st) {
  const boosting = (buttons & Button.BOOST) !== 0 && !s.boostLock && s.energy > 0 && s.fuel > 0;
  if (boosting) {
    s.energy = Math.max(0, s.energy - st.boostDrain);
    if (s.energy === 0) s.boostLock = 1;
  } else {
    s.energy = Math.min(st.energyMax, s.energy + st.energyRegen);
    if (s.boostLock && s.energy >= st.boostUnlock) s.boostLock = 0;
  }
  return boosting;
}

/** Works out this step's thrust from the held buttons into `thrust`, scaled by `power`. */
function planThrust(buttons, st, boosting, power) {
  let forward = boosting ? st.boostAccel : buttons & Button.THRUST ? st.thrust : 0;
  let lateral = 0;
  if (buttons & Button.BACK) forward -= st.thrust * st.backThrust;
  if (buttons & Button.STRAFE_RIGHT) lateral += st.thrust * st.strafeThrust;
  if (buttons & Button.STRAFE_LEFT) lateral -= st.thrust * st.strafeThrust;
  thrust.forward = forward * power;
  thrust.lateral = lateral * power;
  // Screen-direction thrusters: y grows downwards on screen.
  const mx = (buttons & Button.MOVE_RIGHT ? 1 : 0) - (buttons & Button.MOVE_LEFT ? 1 : 0);
  const my = (buttons & Button.MOVE_DOWN ? 1 : 0) - (buttons & Button.MOVE_UP ? 1 : 0);
  if (mx !== 0 || my !== 0) {
    const k = (st.thrust * st.moveThrust * power) / Math.sqrt(mx * mx + my * my);
    thrust.x = mx * k;
    thrust.y = my * k;
  } else {
    thrust.x = 0;
    thrust.y = 0;
  }
}

/** Burns fuel for every thruster the pilot fires this step (the ram drive's own burn is free). */
function burnFuel(s, st, buttons, boosting, braking) {
  let burn = 0;
  if (boosting) burn += st.fuelBurnBoost;
  else if (buttons & (Button.THRUST | MOVE_BUTTONS)) burn += st.fuelBurnMain;
  if (buttons & SHIP_FRAME_THRUSTERS) burn += st.fuelBurnThruster;
  if (braking) burn += st.fuelBurnBrake;
  if (burn > 0 && s.fuel > 0) s.fuel = Math.max(0, s.fuel - burn);
}

/**
 * Adds this step's thrust. Thrusters steer freely but cannot raise the speed
 * past `cap`; a ship already faster (from gravity or a dash) keeps its speed.
 */
function applyThrust(s, ca, sa, cap) {
  const ax = ca * thrust.forward - sa * thrust.lateral + thrust.x;
  const ay = sa * thrust.forward + ca * thrust.lateral + thrust.y;
  if (ax === 0 && ay === 0) return;
  const before = s.vx * s.vx + s.vy * s.vy;
  s.vx += ax * TICK_DT;
  s.vy += ay * TICK_DT;
  const after = s.vx * s.vx + s.vy * s.vy;
  if (after > cap * cap && after > before) {
    const k = Math.max(cap, Math.sqrt(before)) / Math.sqrt(after);
    s.vx *= k;
    s.vy *= k;
  }
}

/**
 * The Fighter's afterburner: a kick towards the held thrusters (screen
 * direction first, then the ship's own; forward if none), past the cruise
 * limit like a slingshot.
 */
function afterburner(s, buttons, ca, sa, impulse) {
  const mx = (buttons & Button.MOVE_RIGHT ? 1 : 0) - (buttons & Button.MOVE_LEFT ? 1 : 0);
  const my = (buttons & Button.MOVE_DOWN ? 1 : 0) - (buttons & Button.MOVE_UP ? 1 : 0);
  if (mx !== 0 || my !== 0) {
    const k = impulse / Math.sqrt(mx * mx + my * my);
    s.vx += mx * k;
    s.vy += my * k;
    return;
  }
  let f = (buttons & Button.THRUST ? 1 : 0) - (buttons & Button.BACK ? 1 : 0);
  const l = (buttons & Button.STRAFE_RIGHT ? 1 : 0) - (buttons & Button.STRAFE_LEFT ? 1 : 0);
  if (f === 0 && l === 0) f = 1;
  const k = impulse / Math.sqrt(f * f + l * l);
  s.vx += (ca * f - sa * l) * k;
  s.vy += (sa * f + ca * l) * k;
}

/** Retro brake: slows the ship along its motion by up to `dv`, never reversing it. */
function brake(s, dv) {
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
  if (speed === 0) return;
  const k = Math.min(speed, dv) / speed;
  s.vx -= s.vx * k;
  s.vy -= s.vy * k;
}

/**
 * Coasting drag: above its coast speed, a ship with no thruster firing
 * slows towards it. `openSpace` (1 far from every well, 0 where the pull is
 * felt) scales it, so wells stay drag-free and the drag fades in at their edge.
 */
function coast(s, st, openSpace) {
  if (openSpace <= 0) return;
  const speedSq = s.vx * s.vx + s.vy * s.vy;
  if (speedSq <= st.coastSpeed * st.coastSpeed) return;
  const speed = Math.sqrt(speedSq);
  const target = Math.max(st.coastSpeed, speed * st.coastDecay);
  const k = (speed - (speed - target) * Math.min(1, openSpace)) / speed;
  s.vx *= k;
  s.vy *= k;
}

/* Orbit lock --------------------------------------------------------------------- */

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

/* Weapons ------------------------------------------------------------------------ */

/**
 * Computes the projectiles for one shot of `weapon` from ship state `s`.
 * Fills `out` with {x, y, vx, vy} objects (reused between calls) and returns
 * how many were written. Shots leave the prow of the ship's hull (`st.nose`)
 * and inherit the ship's velocity.
 */
export function computeShots(s, weapon, st, out) {
  const muzzles = (WEAPONS[weapon] ?? WEAPONS[0]).muzzles;
  const ca = Math.cos(s.angle);
  const sa = Math.sin(s.angle);
  for (let i = 0; i < muzzles.length; i++) {
    const spread = muzzles[i][0];
    const lateral = muzzles[i][1];
    const shot = out[i] ?? (out[i] = { x: 0, y: 0, vx: 0, vy: 0 });
    shot.x = wrap(s.x + ca * st.nose - sa * lateral, WORLD_SIZE);
    shot.y = wrap(s.y + sa * st.nose + ca * lateral, WORLD_SIZE);
    const a = s.angle + spread;
    shot.vx = s.vx + Math.cos(a) * st.bulletSpeed;
    shot.vy = s.vy + Math.sin(a) * st.bulletSpeed;
  }
  return muzzles.length;
}
