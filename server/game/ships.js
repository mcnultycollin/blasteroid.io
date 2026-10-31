/** Player ships: input processing, timers, contact collisions and upgrades. */
import {
  AlienKind,
  BulletKind,
  Button,
  EntityType,
  KillCause,
  POWERUP_COUNT,
  Powerup,
  ShipFlag,
  TICK_DT,
  TICK_RATE,
  WORLD_SIZE,
} from '../../shared/constants.js';
import { isStar, poseBodies } from '../../shared/gravity.js';
import { clamp, wrap, wrapDelta } from '../../shared/math.js';
import { StepResult, computeShots, stepShip } from '../../shared/physics.js';
import { STAT_COUNT, STAT_MAX, WEAPON_CHOICES, Weapon } from '../../shared/stats.js';
import { applyBlast, breakLock } from './abilities.js';
import {
  awardScore,
  collectPickup,
  damageAlien,
  damageAsteroid,
  damageShip,
  refreshStats,
} from './combat.js';
import { Mask } from './entities.js';
import { releaseFromOrbit } from './planets.js';
import { spawnBullet } from './spawning.js';
import { ASTEROID, BLAST, PICKUP, PLANETS, REWARD, SHIP } from './tuning.js';

const shots = [];
const nearby = [];
const PLAYER_HITS = Mask.SHIP | Mask.ASTEROID | Mask.ALIEN;
const CONTACTS = Mask.SHIP | Mask.ASTEROID | Mask.ALIEN | Mask.PICKUP;

/* Input --------------------------------------------------------------------- */

const poseScratch = []; // bodies posed at a command's own tick

/**
 * Applies queued input commands. Each command advances its ship by exactly
 * one physics step, mirroring client-side prediction. Ships bank at most
 * `maxCredits` commands, refilled one per tick, so a client can catch up after
 * jitter but can never run faster than real time.
 *
 * Each command runs at its own command time (see commandTick) with the star
 * and planets posed for that tick, exactly as the client predicted it, even
 * when jitter makes commands arrive in bursts.
 */
export function processShipInputs(game) {
  for (const player of game.players.values()) {
    const ship = player.ship;
    if (!ship) continue;
    if (player.credits < SHIP.maxCredits) player.credits++;
    const q = player.inputs;
    while (q.size > 0 && player.credits > 0) {
      const i = q.first;
      const seq = q.seqs[i];
      const buttons = q.buttons[i];
      const aim = q.aims[i];
      q.drop(); // before applying: a death mid-command clears the queue
      player.credits--;
      player.ackSeq = seq;
      const tick = commandTick(game, player, seq);
      const bodies = tick === game.tick ? game.planets : poseBodies(game.planets, tick, poseScratch);
      applyCommand(game, ship, buttons, aim, seq, bodies, tick);
      if (ship.dead) break;
    }
  }
}

/**
 * The world tick command `seq` simulates: `seq + timeOffset`. The offset is
 * anchored by the first command of each life and sent with every snapshot.
 * It is re-anchored, costing the client one small correction near moving
 * bodies, when command time drifts far from world time, or stays a little
 * off for a sustained stretch (so a landed ship never visibly lags its planet).
 */
export function commandTick(game, player, seq) {
  let tick = seq + player.timeOffset;
  const drift = tick - game.tick;
  player.timeDrift = drift > SHIP.timeSoftSlack || drift < -SHIP.timeSoftSlack ? player.timeDrift + 1 : 0;
  if (!player.timeAnchored || drift > SHIP.timeSlack || drift < -SHIP.timeSlack || player.timeDrift > SHIP.timeDriftLimit) {
    player.timeOffset = game.tick - seq;
    player.timeAnchored = true;
    player.timeDrift = 0;
    tick = game.tick;
  }
  return tick;
}

function applyCommand(game, ship, buttons, aim, seq, bodies, tick) {
  const result = stepShip(ship, buttons, aim, ship.st, bodies, tick);
  ship.thrusting = (result & StepResult.THRUST) !== 0;
  ship.boosting = (result & StepResult.BOOST) !== 0;
  ship.braking = (result & StepResult.BRAKE) !== 0;
  // Holding still with mouse aim still sets the AIM bit, so it doesn't count as activity.
  if ((buttons & ~Button.AIM) !== 0 || aim !== ship.lastAim) ship.lastActiveTick = game.tick;
  ship.lastButtons = buttons;
  ship.lastAim = aim;
  if (result & StepResult.IMPACT) touchBody(game, ship);
  if (ship.dead) return;
  if (result & StepResult.BLAST) applyBlast(game, ship);
  if (result & StepResult.FIRED) fireWeapon(game, ship, seq);
}

function fireWeapon(game, ship, seq) {
  ship.invuln = 0; // firing ends spawn protection
  const st = ship.st;
  const kind = ship.weapon === Weapon.CANNON ? BulletKind.CANNON : BulletKind.PLAYER;
  const n = computeShots(ship, ship.weapon, st, shots);
  for (let i = 0; i < n; i++) {
    spawnBullet(game, ship, kind, shots[i], st.damage, st.bulletRadius, st.bulletLife, PLAYER_HITS, seq, i);
  }
}

/* Timers -------------------------------------------------------------------- */

export function updateShips(game) {
  const tick = game.tick;
  const survivalTick = tick % TICK_RATE === 0;
  for (const ship of game.ships) {
    if (ship.dead) continue;
    if (ship.invuln > 0) ship.invuln--;
    if (ship.contactCooldown > 0) ship.contactCooldown--;

    for (let p = 0; p < POWERUP_COUNT; p++) {
      if (ship.powerups[p] > 0 && --ship.powerups[p] === 0) expirePowerup(ship, p);
    }

    if (ship.hp < ship.maxHp && tick - ship.lastDamageTick >= SHIP.regenDelay) {
      ship.hp = Math.min(ship.maxHp, ship.hp + ship.st.regen * TICK_DT);
    }

    const active = tick - ship.lastActiveTick < REWARD.activeWindow;
    if (survivalTick && active) awardScore(game, ship, REWARD.survivalPerSecond);
    if (!ship.player.isBot && tick - ship.lastActiveTick > SHIP.idleDespawn) {
      ship.player.idle = true;
      despawnShip(game, ship);
      continue;
    }

    ship.flags =
      (ship.thrusting ? ShipFlag.THRUST : 0) |
      (ship.boosting ? ShipFlag.BOOST : 0) |
      (ship.braking ? ShipFlag.BRAKE : 0) |
      (ship.invuln > 0 ? ShipFlag.INVULN : 0) |
      (ship.shield > 0 ? ShipFlag.SHIELD : 0) |
      (ship.powerups[Powerup.RAPID] > 0 ? ShipFlag.RAPID : 0) |
      (ship.powerups[Powerup.OVERDRIVE] > 0 ? ShipFlag.OVERDRIVE : 0) |
      (ship.player.stealth ? ShipFlag.STEALTH : 0) |
      (ship.lockBody >= 0 ? ShipFlag.LOCKED : 0);
  }
}

function expirePowerup(ship, p) {
  if (p === Powerup.SHIELD) ship.shield = 0;
  else refreshStats(ship);
  ship.statsVersion++;
}

/**
 * Surface contact from the last physics step: the star burns anything that
 * touches it, hard planet impacts hurt, and gentle touchdowns are landings.
 */
function touchBody(game, ship) {
  const body = game.planets[ship.contactBody];
  if (!body || ship.contactCooldown > 0) return;
  if (isStar(body)) {
    ship.contactCooldown = PLANETS.burnInterval;
    damageShip(game, ship, PLANETS.starBurn, null, KillCause.STAR, body.x, body.y);
  } else if (ship.impact > PLANETS.crashSafeSpeed) {
    ship.contactCooldown = SHIP.contactCooldown;
    const damage = (ship.impact - PLANETS.crashSafeSpeed) * PLANETS.crashDamage;
    damageShip(game, ship, damage, null, KillCause.PLANET, body.x, body.y);
  }
}

/** Removes a ship without a kill (idle timeout or player leaving). */
export function despawnShip(game, ship) {
  ship.dead = true;
  ship.player.ship = null;
  ship.player.inputs.clear();
  ship.player.credits = 0;
}

/* Contacts ------------------------------------------------------------------ */

export function collideShips(game) {
  for (const ship of game.ships) {
    if (ship.dead) continue;
    const reach = ship.radius + PICKUP.reach;
    nearby.length = 0;
    game.grid.query(ship.x, ship.y, reach, reach, CONTACTS, nearby);
    for (const other of nearby) {
      if (other === ship || other.dead) continue;
      const dx = wrapDelta(other.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(other.y - ship.y, WORLD_SIZE);
      const distSq = dx * dx + dy * dy;
      const touch = ship.radius + other.radius;
      switch (other.type) {
        case EntityType.PICKUP: {
          const r = touch + PICKUP.reach;
          if (distSq <= r * r) collectPickup(game, ship, other);
          break;
        }
        case EntityType.ASTEROID:
          if (distSq < touch * touch) hitAsteroid(game, ship, other, dx, dy, distSq);
          break;
        case EntityType.SHIP:
          if (other.id > ship.id && distSq < touch * touch) hitShip(game, ship, other, dx, dy, distSq);
          break;
        case EntityType.ALIEN:
          if (distSq < touch * touch) hitAlien(game, ship, other, dx, dy, distSq);
          break;
      }
      if (ship.dead) break;
    }
  }
}

/**
 * Resolves an overlap between `a` (pushed by `shareA` of the overlap) and `b`
 * along the normal from a to b, then exchanges momentum. Returns the closing
 * speed before the bounce (0 when already separating). Contact knocks ships
 * out of orbit locks.
 */
function bounce(a, b, dx, dy, distSq, massA, massB, restitution) {
  const dist = Math.sqrt(distSq) || 1;
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = a.radius + b.radius - dist;
  const shareA = massB / (massA + massB);
  a.x = wrap(a.x - nx * overlap * shareA, WORLD_SIZE);
  a.y = wrap(a.y - ny * overlap * shareA, WORLD_SIZE);
  b.x = wrap(b.x + nx * overlap * (1 - shareA), WORLD_SIZE);
  b.y = wrap(b.y + ny * overlap * (1 - shareA), WORLD_SIZE);
  if (a.type === EntityType.SHIP) breakLock(a);
  if (b.type === EntityType.SHIP) breakLock(b);
  const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (closing <= 0) return 0;
  const j = ((1 + restitution) * closing) / (1 / massA + 1 / massB);
  a.vx -= (j / massA) * nx;
  a.vy -= (j / massA) * ny;
  b.vx += (j / massB) * nx;
  b.vy += (j / massB) * ny;
  return closing;
}

const impactScale = (closing) => clamp(closing / 250, 0.4, 2);

function hitAsteroid(game, ship, asteroid, dx, dy, distSq) {
  // Ramming a belt rock knocks it off its orbit; from then on it falls freely.
  if (asteroid.orbit) releaseFromOrbit(asteroid);
  const closing = bounce(ship, asteroid, dx, dy, distSq, SHIP.mass, ASTEROID.mass[asteroid.size], 0.6);
  const speed = Math.hypot(asteroid.vx, asteroid.vy);
  if (speed > ASTEROID.maxSpeed) {
    asteroid.vx *= ASTEROID.maxSpeed / speed;
    asteroid.vy *= ASTEROID.maxSpeed / speed;
  }
  asteroid.version++; // its motion changed; clients need the new trajectory
  if (closing > 0 && ship.contactCooldown === 0) {
    ship.contactCooldown = SHIP.contactCooldown;
    const impact = impactScale(closing);
    // A rock someone else just shoved into us counts as their hit.
    const p = asteroid.pusher;
    const shover = p && p !== ship && !p.dead && game.tick - asteroid.pushTick <= BLAST.creditWindow ? p : null;
    damageAsteroid(game, asteroid, SHIP.ramDamage * impact, ship);
    damageShip(game, ship, ASTEROID.contactDamage[asteroid.size] * impact, shover, KillCause.ASTEROID, asteroid.x, asteroid.y);
  }
  asteroid.pusher = ship;
  asteroid.pushTick = game.tick;
}

function hitShip(game, a, b, dx, dy, distSq) {
  const closing = bounce(a, b, dx, dy, distSq, SHIP.mass, SHIP.mass, 0.8);
  if (closing > 0 && a.contactCooldown === 0 && b.contactCooldown === 0) {
    a.contactCooldown = b.contactCooldown = SHIP.contactCooldown;
    const damage = SHIP.shipRamDamage * impactScale(closing);
    damageShip(game, a, damage, b, KillCause.RAM, b.x, b.y);
    damageShip(game, b, damage, a, KillCause.RAM, a.x, a.y);
  }
}

function hitAlien(game, ship, alien, dx, dy, distSq) {
  const closing = bounce(ship, alien, dx, dy, distSq, SHIP.mass, alien.radius / 12, 0.7);
  if (closing > 0 && ship.contactCooldown === 0) {
    ship.contactCooldown = SHIP.contactCooldown;
    const impact = impactScale(closing);
    damageAlien(game, alien, SHIP.ramDamage * impact, ship);
    damageShip(game, ship, alien.def.contactDamage * impact, alien, alienCause(alien), alien.x, alien.y);
  }
}

export function alienCause(alien) {
  return alien.kind === AlienKind.MOTHERSHIP ? KillCause.MOTHERSHIP : KillCause.ALIEN;
}

/* Upgrades ------------------------------------------------------------------ */

export function upgradeStat(ship, stat) {
  if (!ship || ship.points <= 0 || stat < 0 || stat >= STAT_COUNT) return false;
  if (ship.statLevels[stat] >= STAT_MAX) return false;
  ship.statLevels[stat]++;
  ship.points--;
  refreshStats(ship);
  return true;
}

export function chooseWeapon(ship, weapon) {
  if (!ship || !ship.weaponChoice || !WEAPON_CHOICES.includes(weapon)) return false;
  ship.weapon = weapon;
  ship.weaponChoice = false;
  refreshStats(ship);
  return true;
}
