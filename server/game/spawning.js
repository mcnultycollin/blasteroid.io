/** Factory helpers that create entities and register them with the game. */
import { AlienKind, NO_TEAM, WORLD_SIZE } from '../../shared/constants.js';
import { TAU, wrap, wrapDelta } from '../../shared/math.js';
import { Alien, Asteroid, Bullet, Mask, Pickup, Ship } from './entities.js';
import { ALIENS, SHIP } from './tuning.js';

const nearby = [];

/** Squared distance from (x, y) to the closest live ship (not of `team`), or Infinity. */
export function nearestShipDistSq(game, x, y, team = NO_TEAM) {
  let best = Infinity;
  for (const s of game.ships) {
    if (s.dead || (team !== NO_TEAM && s.team === team)) continue;
    const dx = wrapDelta(s.x - x, WORLD_SIZE);
    const dy = wrapDelta(s.y - y, WORLD_SIZE);
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Picks a random point, preferring spots at least `minShipDistance` from any
 * ship (any enemy of `team`) and clear of asteroids, aliens and planets (and
 * of gravity wells entirely with `avoidWells`). With `around` ({x, y,
 * radius}) it only samples that area. Returns the best of a few samples.
 */
export function findOpenSpot(game, minShipDistance, tries = 24, avoidWells = false, around = null, team = NO_TEAM) {
  let bestX = 0;
  let bestY = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < tries; i++) {
    let x;
    let y;
    if (around) {
      const a = game.rng() * TAU;
      const d = Math.sqrt(game.rng()) * around.radius;
      x = wrap(around.x + Math.cos(a) * d, WORLD_SIZE);
      y = wrap(around.y + Math.sin(a) * d, WORLD_SIZE);
    } else {
      x = game.rng() * WORLD_SIZE;
      y = game.rng() * WORLD_SIZE;
    }
    let score = Math.min(Math.sqrt(nearestShipDistSq(game, x, y, team)), minShipDistance);
    nearby.length = 0;
    game.grid.query(x, y, 180, 180, Mask.ASTEROID | Mask.ALIEN, nearby);
    for (const o of nearby) {
      const dx = wrapDelta(o.x - x, WORLD_SIZE);
      const dy = wrapDelta(o.y - y, WORLD_SIZE);
      const clear = o.radius + 110;
      if (dx * dx + dy * dy < clear * clear) score -= 10000;
    }
    for (const p of game.planets) {
      const dx = wrapDelta(p.x - x, WORLD_SIZE);
      const dy = wrapDelta(p.y - y, WORLD_SIZE);
      const keepOut = avoidWells ? p.range + 60 : p.radius + 140;
      if (dx * dx + dy * dy < keepOut * keepOut) score -= 10000;
    }
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
      bestY = y;
      if (score >= minShipDistance) break;
    }
  }
  return { x: bestX, y: bestY };
}

export function randomVelocity(rng, minSpeed, maxSpeed, out) {
  const a = rng() * TAU;
  const speed = minSpeed + rng() * (maxSpeed - minSpeed);
  out.vx = Math.cos(a) * speed;
  out.vy = Math.sin(a) * speed;
  return out;
}

/**
 * Spawns the player's ship at `spot` ({x, y, vx, vy, angle}), or by default
 * somewhere quiet outside every gravity well.
 */
export function spawnShip(game, player, spot = null) {
  const ship = new Ship(player);
  if (spot) {
    ship.x = spot.x;
    ship.y = spot.y;
    ship.vx = spot.vx;
    ship.vy = spot.vy;
    ship.angle = spot.angle;
  } else {
    const open = findOpenSpot(game, 900, 24, true); // never spawn inside a gravity well
    ship.x = open.x;
    ship.y = open.y;
    ship.angle = game.rng() * TAU;
  }
  ship.hp = ship.maxHp = ship.st.maxHp;
  ship.energy = ship.st.energyMax;
  ship.invuln = SHIP.spawnInvuln;
  ship.spawnTick = ship.lastActiveTick = game.tick;
  if (!game.add(game.ships, ship)) return null;
  player.ship = ship;
  player.idle = false;
  player.killer = null;
  return ship;
}

export function spawnAsteroid(game, size, x, y, vx, vy) {
  const a = new Asteroid(size);
  a.x = x;
  a.y = y;
  a.vx = vx;
  a.vy = vy;
  return game.add(game.asteroids, a);
}

export function spawnBullet(game, owner, kind, shot, damage, radius, life, hitMask, fireSeq, muzzle) {
  const b = new Bullet(owner, kind, damage, radius, life);
  b.x = shot.x;
  b.y = shot.y;
  b.vx = shot.vx;
  b.vy = shot.vy;
  b.hitMask = hitMask;
  b.fireSeq = fireSeq;
  b.muzzle = muzzle;
  b.spawnTick = game.tick;
  return game.add(game.bullets, b);
}

export function spawnAlien(game, kind, x, y) {
  const al = new Alien(kind);
  al.x = x;
  al.y = y;
  al.wander = game.rng() * TAU;
  al.thinkCooldown = Math.floor(game.rng() * 15);
  al.fireCooldown = al.def.fireInterval;
  if (kind === AlienKind.MOTHERSHIP) {
    al.lifeLeft = ALIENS[kind].lifetime;
    al.burstCooldown = ALIENS[kind].burstInterval;
    al.spawnCooldown = ALIENS[kind].spawnInterval >> 1;
  }
  return game.add(game.aliens, al);
}

export function spawnPickup(game, kind, x, y, value, life) {
  const p = new Pickup(kind, value, game.tick + life);
  p.x = x;
  p.y = y;
  return game.add(game.pickups, p);
}
