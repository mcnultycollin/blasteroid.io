/**
 * Damage, death, rewards and drops. Every way an entity can be hurt or
 * destroyed funnels through here, so kill credit and scoring stay consistent.
 */
import {
  AlienKind,
  Announce,
  EntityType,
  EventKind,
  PickupKind,
  Powerup,
  POWERUP_SECONDS,
  RemoveReason,
  TICK_RATE,
  WORLD_SIZE,
} from '../../shared/constants.js';
import { TAU, clamp, wrap, wrapDelta } from '../../shared/math.js';
import { NO_ID } from '../../shared/protocol.js';
import { WEAPON_UNLOCK_LEVEL, Weapon, deriveStats, levelForScore } from '../../shared/stats.js';
import { orbitAngle, orbitState } from '../../shared/gravity.js';
import { makeOrbit, orbitBand } from './planets.js';
import { randomVelocity, spawnAsteroid, spawnPickup } from './spawning.js';
import { ASTEROID, PICKUP, POWERUP, REWARD, SHIP } from './tuning.js';

const POWERUP_KINDS = [PickupKind.SHIELD, PickupKind.RAPID, PickupKind.REPAIR, PickupKind.OVERDRIVE];
const velocity = { vx: 0, vy: 0 };
const scratchPoint = { x: 0, y: 0, vx: 0, vy: 0 };

/* Score and stats ----------------------------------------------------------- */

/** Adds score to a living ship, levelling it up as thresholds are crossed. */
export function awardScore(game, ship, amount, x, y) {
  if (ship.dead || amount <= 0) return;
  ship.score += amount;
  const level = levelForScore(ship.score);
  if (level > ship.level) {
    ship.points += level - ship.level;
    ship.level = level;
    if (level >= WEAPON_UNLOCK_LEVEL && ship.weapon === Weapon.BLASTER) ship.weaponChoice = true;
  }
  ship.statsVersion++;
  if (ship.player.wantsEvents && x !== undefined) {
    ship.player.events.push({ kind: EventKind.SCORE, amount, x, y });
  }
}

/** Re-derives a ship's effective stats after upgrades or power-up changes. */
export function refreshStats(ship) {
  const oldMax = ship.st.maxHp;
  deriveStats(
    ship.statLevels,
    ship.weapon,
    ship.powerups[Powerup.RAPID] > 0,
    ship.powerups[Powerup.OVERDRIVE] > 0,
    ship.st,
  );
  ship.maxHp = ship.st.maxHp;
  if (ship.maxHp > oldMax) ship.hp += ship.maxHp - oldMax;
  ship.hp = Math.min(ship.hp, ship.maxHp);
  ship.energy = Math.min(ship.energy, ship.st.energyMax);
  ship.statsVersion++;
}

/* Ships --------------------------------------------------------------------- */

/**
 * Damages a ship. `attacker` is the responsible Ship or Alien (or null);
 * (fromX, fromY) is where the damage came from, for the hit indicator.
 * Returns the damage actually applied.
 */
export function damageShip(game, ship, amount, attacker, cause, fromX, fromY) {
  if (ship.dead || amount <= 0 || ship.invuln > 0) return 0;
  const dealt = amount;
  if (ship.shield > 0) {
    const absorbed = Math.min(ship.shield, amount);
    ship.shield -= absorbed;
    amount -= absorbed;
    if (ship.shield <= 0) {
      ship.shield = 0;
      ship.powerups[Powerup.SHIELD] = 0;
      ship.statsVersion++;
    }
  }
  ship.hp -= amount;
  ship.lastDamageTick = game.tick;
  if (attacker && attacker.type === EntityType.SHIP && attacker !== ship) {
    ship.lastAttacker = attacker;
    ship.lastAttackTick = game.tick;
  }
  if (ship.player.wantsEvents) {
    const angle = Math.atan2(wrapDelta(fromY - ship.y, WORLD_SIZE), wrapDelta(fromX - ship.x, WORLD_SIZE));
    ship.player.events.push({ kind: EventKind.DAMAGE, amount: dealt, angle });
  }
  if (ship.hp <= 0) killShip(game, ship, attacker, cause);
  return dealt;
}

export function killShip(game, ship, attacker, cause) {
  if (ship.dead) return;
  ship.dead = true;
  ship.removeReason = RemoveReason.DESTROYED;
  ship.hp = 0;

  // Credit the attacker, or whoever recently damaged the victim when an
  // asteroid or collision finishes the job.
  let killer = attacker && attacker.type === EntityType.SHIP && attacker !== ship ? attacker : null;
  if (!killer && ship.lastAttacker && game.tick - ship.lastAttackTick <= REWARD.assistWindow) {
    killer = ship.lastAttacker;
  }
  if (killer && !killer.dead) {
    killer.kills++;
    awardScore(game, killer, Math.round(REWARD.killBase + ship.score * REWARD.killShare), ship.x, ship.y);
  }
  dropOrbs(game, ship.x, ship.y, ship.score * REWARD.dropShare);

  const player = ship.player;
  const killerId = killer ? killer.playerId : NO_ID;
  game.outbox.kills.push({ killerId, victimId: player.id, cause });
  game.outbox.deaths.push({
    player,
    killerId,
    cause,
    score: ship.score,
    level: ship.level,
    kills: ship.kills,
    aliveTicks: game.tick - ship.spawnTick,
  });
  player.ship = null;
  player.deathTick = game.tick;
  player.respawnTick = game.tick + SHIP.respawnDelay;
  player.killer = killer ?? (attacker && attacker.type === EntityType.ALIEN ? attacker : null);
  player.deathX = ship.x;
  player.deathY = ship.y;
  player.inputs.clear();
  player.credits = 0;
}

/* Asteroids ----------------------------------------------------------------- */

export function damageAsteroid(game, asteroid, amount, attacker) {
  if (asteroid.dead) return 0;
  asteroid.hp -= amount;
  if (asteroid.hp <= 0) destroyAsteroid(game, asteroid, attacker);
  return amount;
}

export function destroyAsteroid(game, asteroid, attacker) {
  asteroid.dead = true;
  asteroid.removeReason = RemoveReason.DESTROYED;
  const size = asteroid.size;
  if (attacker && attacker.type === EntityType.SHIP) {
    awardScore(game, attacker, ASTEROID.score[size], asteroid.x, asteroid.y);
  }
  if (size > 0 && asteroid.orbit) {
    splitOrbiter(game, asteroid);
  } else if (size > 0) {
    const [minSpeed, maxSpeed] = ASTEROID.speed[size - 1];
    for (let i = 0; i < 2; i++) {
      randomVelocity(game.rng, minSpeed, maxSpeed, velocity);
      const offset = asteroid.radius * 0.4;
      const len = Math.hypot(velocity.vx, velocity.vy) || 1;
      spawnAsteroid(
        game,
        size - 1,
        wrap(asteroid.x + (velocity.vx / len) * offset, WORLD_SIZE),
        wrap(asteroid.y + (velocity.vy / len) * offset, WORLD_SIZE),
        asteroid.vx * 0.5 + velocity.vx,
        asteroid.vy * 0.5 + velocity.vy,
      );
    }
  }
  if (size === 2 && game.rng() < ASTEROID.powerupChance) dropPowerup(game, asteroid.x, asteroid.y);
}

/**
 * Fragments of a belt rock take neighbouring circular orbits, one inside and
 * one outside the parent's, so they drift apart naturally and stay cheap to
 * replicate.
 */
function splitOrbiter(game, asteroid) {
  const o = asteroid.orbit;
  const planet = game.planets[o.planet];
  const size = asteroid.size - 1;
  const [minR, maxR] = orbitBand(planet, size);
  const angle = orbitAngle(o, game.tick);
  for (let i = 0; i < 2; i++) {
    const offset = (i === 0 ? -1 : 1) * (12 + game.rng() * 22);
    const orbit = makeOrbit(planet, clamp(o.radius + offset, minR, maxR), angle + (game.rng() - 0.5) * 0.08, game.tick, o.dir);
    orbitState(planet, orbit, game.tick, scratchPoint);
    const fragment = spawnAsteroid(game, size, scratchPoint.x, scratchPoint.y, scratchPoint.vx, scratchPoint.vy);
    if (fragment) fragment.orbit = orbit;
  }
}

/** Moves `point` to just outside any planet it lies within. */
function clearOfPlanets(game, point, margin) {
  for (const p of game.planets) {
    const dx = wrapDelta(point.x - p.x, WORLD_SIZE);
    const dy = wrapDelta(point.y - p.y, WORLD_SIZE);
    const minD = p.radius + margin;
    const dSq = dx * dx + dy * dy;
    if (dSq < minD * minD) {
      const d = Math.sqrt(dSq) || 1;
      point.x = wrap(p.x + (dx / d) * minD, WORLD_SIZE);
      point.y = wrap(p.y + (dy / d) * minD, WORLD_SIZE);
    }
  }
  return point;
}

/* Aliens -------------------------------------------------------------------- */

export function damageAlien(game, alien, amount, attacker) {
  if (alien.dead) return 0;
  alien.hp -= amount;
  if (alien.hp <= 0) killAlien(game, alien, attacker);
  return amount;
}

export function killAlien(game, alien, attacker) {
  alien.dead = true;
  alien.removeReason = RemoveReason.DESTROYED;
  const def = alien.def;
  const killer = attacker && attacker.type === EntityType.SHIP && !attacker.dead ? attacker : null;
  if (killer) awardScore(game, killer, def.score, alien.x, alien.y);
  if (alien.parent) alien.parent.children--;

  if (alien.kind === AlienKind.MOTHERSHIP) {
    for (let i = 0; i < def.powerups; i++) dropPowerup(game, alien.x, alien.y, 90);
    dropOrbs(game, alien.x, alien.y, def.orbValue);
    game.outbox.announcements.push({
      code: Announce.MOTHERSHIP_DESTROYED,
      playerId: killer ? killer.playerId : NO_ID,
    });
    game.mothership = null;
  } else if (game.rng() < def.dropChance) {
    dropPowerup(game, alien.x, alien.y);
  }
}

/* Drops and pickups --------------------------------------------------------- */

/** Scatters `value` score worth of orbs around (x, y). */
export function dropOrbs(game, x, y, value) {
  value = Math.floor(value);
  if (value < 10) return;
  const count = clamp(Math.round(value / REWARD.orbValue), 1, REWARD.maxOrbs);
  const each = Math.floor(value / count);
  const kind = each >= 80 ? PickupKind.ORB_LARGE : each >= 30 ? PickupKind.ORB_MEDIUM : PickupKind.ORB_SMALL;
  for (let i = 0; i < count; i++) {
    const a = game.rng() * TAU;
    const d = 20 + game.rng() * 80;
    scratchPoint.x = wrap(x + Math.cos(a) * d, WORLD_SIZE);
    scratchPoint.y = wrap(y + Math.sin(a) * d, WORLD_SIZE);
    clearOfPlanets(game, scratchPoint, 12);
    spawnPickup(game, kind, scratchPoint.x, scratchPoint.y, each, PICKUP.orbLife);
  }
}

export function dropPowerup(game, x, y, scatter = 0, kind = -1) {
  if (kind < 0) kind = POWERUP_KINDS[Math.floor(game.rng() * POWERUP_KINDS.length)];
  const a = game.rng() * TAU;
  const d = scatter * game.rng();
  scratchPoint.x = wrap(x + Math.cos(a) * d, WORLD_SIZE);
  scratchPoint.y = wrap(y + Math.sin(a) * d, WORLD_SIZE);
  clearOfPlanets(game, scratchPoint, 18);
  spawnPickup(game, kind, scratchPoint.x, scratchPoint.y, 0, PICKUP.powerupLife);
}

export function collectPickup(game, ship, pickup) {
  pickup.dead = true;
  pickup.removeReason = RemoveReason.COLLECTED;
  pickup.collectorId = ship.id;
  switch (pickup.kind) {
    case PickupKind.ORB_SMALL:
    case PickupKind.ORB_MEDIUM:
    case PickupKind.ORB_LARGE:
      awardScore(game, ship, pickup.value, pickup.x, pickup.y);
      return;
    case PickupKind.SHIELD:
      ship.shield = POWERUP.shieldHp;
      ship.powerups[Powerup.SHIELD] = POWERUP_SECONDS[Powerup.SHIELD] * TICK_RATE;
      break;
    case PickupKind.RAPID:
      ship.powerups[Powerup.RAPID] = POWERUP_SECONDS[Powerup.RAPID] * TICK_RATE;
      refreshStats(ship);
      break;
    case PickupKind.OVERDRIVE:
      ship.powerups[Powerup.OVERDRIVE] = POWERUP_SECONDS[Powerup.OVERDRIVE] * TICK_RATE;
      refreshStats(ship);
      ship.energy = ship.st.energyMax;
      ship.boostLock = 0;
      break;
    case PickupKind.REPAIR:
      ship.hp = Math.min(ship.maxHp, ship.hp + ship.maxHp * POWERUP.repairFraction);
      break;
  }
  ship.statsVersion++;
}
