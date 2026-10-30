/** Factory helpers that create entities and register them with the game. */
import { AlienKind, WORLD_SIZE } from '../../shared/constants.js';
import { TAU, wrapDelta } from '../../shared/math.js';
import { Alien, Asteroid, Bullet, Mask, Pickup, Ship } from './entities.js';
import { ALIENS, SHIP } from './tuning.js';

const nearby = [];

/** Squared distance from (x, y) to the closest live ship, or Infinity. */
export function nearestShipDistSq(game, x, y) {
  let best = Infinity;
  for (const s of game.ships) {
    if (s.dead) continue;
    const dx = wrapDelta(s.x - x, WORLD_SIZE);
    const dy = wrapDelta(s.y - y, WORLD_SIZE);
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Picks a random point, preferring spots at least `minShipDistance` from any
 * ship and clear of asteroids and aliens. Returns the best of a few samples.
 */
export function findOpenSpot(game, minShipDistance, tries = 24) {
  let bestX = 0;
  let bestY = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < tries; i++) {
    const x = game.rng() * WORLD_SIZE;
    const y = game.rng() * WORLD_SIZE;
    let score = Math.min(Math.sqrt(nearestShipDistSq(game, x, y)), minShipDistance);
    nearby.length = 0;
    game.grid.query(x, y, 180, 180, Mask.ASTEROID | Mask.ALIEN, nearby);
    for (const o of nearby) {
      const dx = wrapDelta(o.x - x, WORLD_SIZE);
      const dy = wrapDelta(o.y - y, WORLD_SIZE);
      const clear = o.radius + 110;
      if (dx * dx + dy * dy < clear * clear) score -= 10000;
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

export function spawnShip(game, player) {
  const ship = new Ship(player);
  const spot = findOpenSpot(game, 900);
  ship.x = spot.x;
  ship.y = spot.y;
  ship.angle = game.rng() * TAU;
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
