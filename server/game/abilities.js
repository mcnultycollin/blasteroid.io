/**
 * Ship abilities that act on the world: the kinetic blast, the class
 * abilities' effects, and the shared rule for shoving ships around (any
 * outside push knocks a ship out of an orbit lock, since a lock is a promise
 * that nothing else moves it).
 *
 * Abilities that only move their own ship (the Fighter's afterburner, the
 * Breaker's ram drive) live in shared/physics.js so they are predicted; this
 * module adds what they do to others. The Medic's repair pulse and the
 * Graviton's singularity act on the world only.
 */
import { AlienKind, EventKind, FxKind, KillCause, WORLD_SIZE } from '../../shared/constants.js';
import { createField } from '../../shared/gravity.js';
import { wrap, wrapDelta } from '../../shared/math.js';
import { dqPos, qPos } from '../../shared/protocol.js';
import { Ability, SINGULARITY, ShipClass } from '../../shared/stats.js';
import { awardScore, damageAlien, damageAsteroid, damageShip } from './combat.js';
import { Mask } from './entities.js';
import { releaseFromOrbit } from './planets.js';
import { allies } from './teams.js';
import { ABILITY, ASTEROID, BLAST } from './tuning.js';

const nearby = [];
const TARGETS = Mask.ASTEROID | Mask.SHIP | Mask.ALIEN;
const REACH = BLAST.range + 64; // range plus the largest radius worth catching

/** Knocks a ship out of its orbit lock. */
export function breakLock(ship) {
  ship.lockBody = -1;
}

/** Changes a ship's velocity from outside (knockback, blasts), breaking any orbit lock. */
export function pushShip(ship, dvx, dvy) {
  ship.vx += dvx;
  ship.vy += dvy;
  ship.lockBody = -1;
}

/** True while a Breaker's ram drive is running. */
export const ramming = (ship) => ship.st.ability === Ability.RAM && ship.abilityTime > 0;

/**
 * The kinetic blast: a cone of force from the ship's nose. Everything inside
 * it except teammates is shoved straight away from the ship, hardest up close.
 * Belt rocks are knocked off their orbits and fall freely from then on, so a
 * blast can send them into a planet, out of the well, or into an enemy (who
 * is then hit "by" the blaster). Ships are shoved too, and the blaster is
 * credited if the push ends in a crash. Returns how many things were pushed.
 */
export function applyBlast(game, ship) {
  const ca = Math.cos(ship.angle);
  const sa = Math.sin(ship.angle);
  nearby.length = 0;
  game.grid.query(ship.x, ship.y, REACH, REACH, TARGETS, nearby);
  let pushed = 0;
  for (const e of nearby) {
    if (e === ship || e.dead || (e.mask === Mask.SHIP && allies(e, ship))) continue;
    const dx = wrapDelta(e.x - ship.x, WORLD_SIZE);
    const dy = wrapDelta(e.y - ship.y, WORLD_SIZE);
    const d = Math.sqrt(dx * dx + dy * dy);
    const gap = d - e.radius;
    if (gap > BLAST.range) continue;
    if (d > e.radius) {
      // Inside the cone, allowing for the target's size.
      const along = (dx * ca + dy * sa) / d;
      const off = Math.acos(along > 1 ? 1 : along < -1 ? -1 : along);
      if (off > BLAST.halfAngle + Math.asin(e.radius / d)) continue;
    }
    const nx = d > 0 ? dx / d : ca;
    const ny = d > 0 ? dy / d : sa;
    const strength = BLAST.impulse * (1 - (1 - BLAST.edgeShare) * Math.max(0, gap / BLAST.range));
    if (e.mask === Mask.ASTEROID) {
      if (e.orbit) releaseFromOrbit(e);
      const dv = strength * BLAST.rockShare[e.size];
      e.vx += nx * dv;
      e.vy += ny * dv;
      capSpeed(e, ASTEROID.maxSpeed);
      e.version++; // a new trajectory for clients
      e.pusher = ship;
      e.pushTick = game.tick;
    } else if (e.mask === Mask.SHIP) {
      const dv = (strength * BLAST.shipShare) / Math.sqrt(e.st.mass); // heavy hulls budge less
      pushShip(e, nx * dv, ny * dv);
      e.lastAttacker = ship; // so a shove into a planet or the star counts as a kill
      e.lastAttackTick = game.tick;
    } else {
      if (e.kind === AlienKind.MOTHERSHIP) continue; // far too heavy
      const dv = strength * BLAST.alienShare;
      e.vx += nx * dv;
      e.vy += ny * dv;
    }
    pushed++;
  }
  game.fx.push({ kind: FxKind.BLAST, x: ship.x, y: ship.y, angle: ship.angle, sourceId: ship.id, tick: game.tick });
  return pushed;
}

function capSpeed(e, max) {
  const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  if (speed > max) {
    e.vx *= max / speed;
    e.vy *= max / speed;
  }
}

/**
 * A class ability fired by `ship` in a command that ran at command tick
 * `tick`. Movement was already applied by stepShip; this adds the effect on
 * everything else and tells nearby clients to draw it.
 */
export function useAbility(game, ship, tick) {
  switch (ship.st.ability) {
    case Ability.DASH:
      effect(game, ship, FxKind.DASH);
      break;
    case Ability.RAM:
      effect(game, ship, FxKind.RAM);
      break;
    case Ability.PULSE:
      repairPulse(game, ship);
      break;
    case Ability.SINGULARITY:
      deploySingularity(game, ship, tick);
      break;
  }
}

function effect(game, ship, kind, x = ship.x, y = ship.y) {
  game.fx.push({ kind, x, y, angle: ship.angle, sourceId: ship.id, tick: game.tick });
}

/* Medic ----------------------------------------------------------------------------- */

/**
 * Restores up to `amount` hull to `target`. The healer is credited with score
 * for what was actually restored, and told so (green numbers on screen).
 * Returns the hull restored.
 */
export function healShip(game, healer, target, amount) {
  if (target.dead || target.hp >= target.maxHp || amount <= 0) return 0;
  const healed = Math.min(amount, target.maxHp - target.hp);
  target.hp += healed;
  if (healer && healer !== target && !healer.dead) {
    healer.healCredit += healed * ABILITY.healScore;
    const whole = Math.floor(healer.healCredit);
    if (whole > 0) {
      healer.healCredit -= whole;
      awardScore(game, healer, whole);
    }
    if (healer.player.wantsEvents && healed >= 1) {
      healer.player.events.push({ kind: EventKind.HEAL, amount: healed, x: target.x, y: target.y });
    }
  }
  return healed;
}

/** Repair pulse: heals every ally around the Medic at once, and the Medic a little. */
function repairPulse(game, medic) {
  const r = ABILITY.pulseRange;
  for (const ship of game.ships) {
    if (ship === medic || ship.dead || !allies(ship, medic)) continue;
    const dx = wrapDelta(ship.x - medic.x, WORLD_SIZE);
    const dy = wrapDelta(ship.y - medic.y, WORLD_SIZE);
    if (dx * dx + dy * dy < r * r) healShip(game, medic, ship, ABILITY.pulseHeal);
  }
  healShip(game, medic, medic, ABILITY.pulseSelfHeal);
  effect(game, medic, FxKind.PULSE);
}

/** Nanite aura: allies close to a Medic regenerate, even right after taking damage. */
export function updateMedics(game) {
  const r = ABILITY.auraRange;
  const amount = ABILITY.auraHealPerSecond / 2; // twice a second
  if (game.tick % 30 !== 0) return;
  for (const medic of game.ships) {
    if (medic.dead || medic.shipClass !== ShipClass.MEDIC || medic.team < 0) continue;
    for (const ship of game.ships) {
      if (ship === medic || ship.dead || !allies(ship, medic)) continue;
      const dx = wrapDelta(ship.x - medic.x, WORLD_SIZE);
      const dy = wrapDelta(ship.y - medic.y, WORLD_SIZE);
      if (dx * dx + dy * dy < r * r) healShip(game, medic, ship, amount);
    }
  }
}

/* Graviton ---------------------------------------------------------------------------- */

/**
 * Deploys a singularity ahead of the Graviton: a gravity well that pulls
 * enemies (never teammates) and loose rocks for a few seconds, rips belt
 * rocks off their orbits and crushes whatever reaches its core. Its position
 * is snapped to the wire format and it starts on the next command tick, so
 * every client can predict its pull exactly once it hears of it.
 */
function deploySingularity(game, ship, tick) {
  const x = dqPos(qPos(wrap(ship.x + Math.cos(ship.angle) * SINGULARITY.distance, WORLD_SIZE)));
  const y = dqPos(qPos(wrap(ship.y + Math.sin(ship.angle) * SINGULARITY.distance, WORLD_SIZE)));
  if (game.fields.length >= ABILITY.maxFields) game.fields.shift();
  game.nextFieldId = (game.nextFieldId + 1) & 0xffff;
  const field = createField(game.nextFieldId, x, y, SINGULARITY.gm, SINGULARITY.range, SINGULARITY.core, tick + 1, tick + 1 + SINGULARITY.life, ship.team, ship.id);
  field.owner = ship;
  game.fields.push(field);
  effect(game, ship, FxKind.SINGULARITY, x, y);
}

/**
 * Expires old fields and lists those active this tick (`game.activeFields`,
 * which act on rocks and aliens of any side). Runs at the start of a tick.
 */
export function updateFields(game) {
  const fields = game.fields;
  let n = 0;
  for (let i = 0; i < fields.length; i++) if (fields[i].expires > game.tick) fields[n++] = fields[i];
  fields.length = n;
  const active = game.activeFields;
  active.length = 0;
  for (const f of fields) if (f.born <= game.tick) active.push(f);
}

/** What active fields do besides pulling: rip belt rocks loose and crush their cores. */
export function applyFieldEffects(game) {
  for (const f of game.activeFields) {
    const owner = f.owner && !f.owner.dead ? f.owner : null;
    nearby.length = 0;
    game.grid.query(f.x, f.y, f.range, f.range, TARGETS, nearby);
    const coreSq = f.radius * f.radius;
    for (const e of nearby) {
      if (e.dead) continue;
      const dx = wrapDelta(e.x - f.x, WORLD_SIZE);
      const dy = wrapDelta(e.y - f.y, WORLD_SIZE);
      const dSq = dx * dx + dy * dy;
      if (dSq > f.rangeSq) continue;
      const inCore = dSq < coreSq;
      if (e.mask === Mask.ASTEROID) {
        if (e.orbit) releaseFromOrbit(e);
        if (inCore) damageAsteroid(game, e, ABILITY.crushRocks, owner);
      } else if (e.mask === Mask.SHIP) {
        if (inCore && !allies(e, f) && e !== f.owner) damageShip(game, e, ABILITY.crushShips, owner, KillCause.SINGULARITY, f.x, f.y);
      } else if (inCore && e.kind !== AlienKind.MOTHERSHIP) {
        damageAlien(game, e, ABILITY.crushAliens, owner);
      }
    }
  }
}
