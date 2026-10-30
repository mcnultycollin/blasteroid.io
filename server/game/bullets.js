/** Projectile movement and impact resolution. */
import { EntityType, EventKind, KillCause, RemoveReason, TICK_DT, WORLD_SIZE } from '../../shared/constants.js';
import { segmentCircleHit, wrap, wrapDelta } from '../../shared/math.js';
import { damageAlien, damageAsteroid, damageShip } from './combat.js';
import { alienCause } from './ships.js';
import { SHIP } from './tuning.js';

const nearby = [];

export function updateBullets(game) {
  for (const b of game.bullets) {
    if (b.dead) continue;
    if (--b.life < 0) {
      b.dead = true;
      b.removeReason = RemoveReason.EXPIRED;
      continue;
    }
    // A projectile fired this tick starts at the muzzle; it moves from the next tick on,
    // matching how clients extrapolate it.
    if (b.spawnTick === game.tick) continue;
    b.x = wrap(b.x + b.vx * TICK_DT, WORLD_SIZE);
    b.y = wrap(b.y + b.vy * TICK_DT, WORLD_SIZE);
  }
}

/**
 * Tests each projectile's path over the last tick against targets, so fast
 * shots cannot tunnel through small asteroids or grazing ships.
 */
export function collideBullets(game) {
  const grid = game.grid;
  for (const b of game.bullets) {
    if (b.dead) continue;
    const moved = b.spawnTick !== game.tick;
    const sx = moved ? b.vx * TICK_DT : 0;
    const sy = moved ? b.vy * TICK_DT : 0;
    const px = b.x - sx;
    const py = b.y - sy;
    nearby.length = 0;
    grid.query(b.x - sx / 2, b.y - sy / 2, Math.abs(sx) / 2 + b.radius, Math.abs(sy) / 2 + b.radius, b.hitMask, nearby);
    let target = null;
    let first = 2;
    for (const t of nearby) {
      if (t === b.owner) continue;
      const hit = segmentCircleHit(px, py, sx, sy, t.x, t.y, t.radius + b.radius, WORLD_SIZE);
      if (hit >= 0 && hit < first) {
        first = hit;
        target = t;
      }
    }
    // Planets block shots: fight around them, or hide behind them.
    for (const p of game.planets) {
      const reach = p.radius + b.radius + Math.abs(sx) + Math.abs(sy);
      const dx = wrapDelta(p.x - b.x, WORLD_SIZE);
      const dy = wrapDelta(p.y - b.y, WORLD_SIZE);
      if (dx > reach || dx < -reach || dy > reach || dy < -reach) continue;
      const hit = segmentCircleHit(px, py, sx, sy, p.x, p.y, p.radius + b.radius, WORLD_SIZE);
      if (hit >= 0 && hit < first) {
        first = hit;
        target = p;
      }
    }
    if (target) resolveHit(game, b, target, wrap(px + sx * first, WORLD_SIZE), wrap(py + sy * first, WORLD_SIZE));
  }
}

function resolveHit(game, b, target, x, y) {
  b.dead = true;
  b.removeReason = RemoveReason.HIT;
  b.x = x;
  b.y = y;
  const owner = b.owner;
  let dealt = 0;
  switch (target.type) {
    case EntityType.SHIP: {
      const cause = owner.type === EntityType.SHIP ? KillCause.SHIP : alienCause(owner);
      dealt = damageShip(game, target, b.damage, owner, cause, x - b.vx * 0.1, y - b.vy * 0.1);
      if (dealt > 0 && !target.dead) {
        const speed = Math.hypot(b.vx, b.vy) || 1;
        target.vx += (b.vx / speed) * dealt * SHIP.hitKnockback;
        target.vy += (b.vy / speed) * dealt * SHIP.hitKnockback;
      }
      break;
    }
    case EntityType.ASTEROID:
      dealt = damageAsteroid(game, target, b.damage, owner);
      break;
    case EntityType.ALIEN:
      dealt = damageAlien(game, target, b.damage, owner);
      break;
    default:
      break; // a planet: absorbs the shot
  }
  if (owner.type === EntityType.SHIP && owner.player.wantsEvents) {
    owner.player.events.push({
      kind: EventKind.HIT,
      seq: b.fireSeq,
      muzzle: b.muzzle,
      damage: dealt,
      x,
      y,
      killed: target.dead === true,
    });
  }
}
