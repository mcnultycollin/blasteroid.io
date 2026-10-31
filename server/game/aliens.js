/** Alien saucers, hunters and the mothership world event. */
import { AlienKind, Announce, BulletKind, RemoveReason, TICK_DT, WORLD_SIZE } from '../../shared/constants.js';
import { applyGravity, collideBodies, isStar } from '../../shared/gravity.js';
import { TAU, interceptTime, wrap, wrapDelta } from '../../shared/math.js';
import { NO_ID } from '../../shared/protocol.js';
import { damageAlien, damageAsteroid } from './combat.js';
import { Mask } from './entities.js';
import { findOpenSpot, spawnAlien, spawnBullet } from './spawning.js';
import { ALIEN_SPAWN, MOTHERSHIP, PLANETS, seconds } from './tuning.js';

const nearby = [];
const shot = { x: 0, y: 0, vx: 0, vy: 0 };
const ALIEN_HITS = Mask.SHIP | Mask.ASTEROID;
const contact = { impact: 0, body: null };

export function updateAliens(game) {
  for (const al of game.aliens) {
    if (al.dead) continue;
    const def = al.def;
    if (al.contactCooldown > 0) al.contactCooldown--;
    if (--al.thinkCooldown <= 0) think(game, al);

    const t = al.target && !al.target.dead && !al.target.player.stealth ? al.target : null;
    let desX;
    let desY;
    let dist = Infinity;
    if (t) {
      const dx = wrapDelta(t.x - al.x, WORLD_SIZE);
      const dy = wrapDelta(t.y - al.y, WORLD_SIZE);
      dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      if (dist > def.preferredRange * 1.15) {
        desX = ux;
        desY = uy;
      } else if (dist < def.preferredRange * 0.7) {
        desX = -ux;
        desY = -uy;
      } else {
        const dir = al.id & 1 ? 1 : -1; // strafe around the target
        desX = -uy * dir;
        desY = ux * dir;
      }
    } else {
      desX = Math.cos(al.wander) * 0.6;
      desY = Math.sin(al.wander) * 0.6;
    }
    const k = Math.min(1, def.agility * TICK_DT);
    al.vx += (desX * def.speed + al.avoidX - al.vx) * k;
    al.vy += (desY * def.speed + al.avoidY - al.vy) * k;
    const grounded = al.kind !== AlienKind.MOTHERSHIP; // the mothership flies above it all
    if (grounded) applyGravity(al, game.planets);
    al.x = wrap(al.x + al.vx * TICK_DT, WORLD_SIZE);
    al.y = wrap(al.y + al.vy * TICK_DT, WORLD_SIZE);
    if (grounded && collideBodies(al, al.radius, game.planets, contact) > 0 && al.contactCooldown === 0) {
      if (isStar(contact.body)) {
        al.contactCooldown = PLANETS.burnInterval;
        damageAlien(game, al, PLANETS.starBurn, null);
      } else if (contact.impact > PLANETS.crashSafeSpeed) {
        al.contactCooldown = seconds(0.5);
        damageAlien(game, al, (contact.impact - PLANETS.crashSafeSpeed) * PLANETS.crashDamage, null);
      }
      if (al.dead) continue;
    }

    if (al.fireCooldown > 0) al.fireCooldown--;
    if (t && al.fireCooldown === 0 && dist < def.fireRange) {
      fireAimed(game, al, t);
      al.fireCooldown = Math.round(def.fireInterval * (0.75 + game.rng() * 0.5));
    }
    if (al.kind === AlienKind.MOTHERSHIP) updateMothership(game, al, t);
  }
}

/** Periodic decisions: target selection and obstacle avoidance. */
function think(game, al) {
  const def = al.def;
  al.thinkCooldown = ALIEN_SPAWN.thinkInterval;

  let best = null;
  let bestScore = Infinity;
  const aggroSq = def.aggroRange * def.aggroRange;
  for (const s of game.ships) {
    if (s.dead || s.player.stealth) continue;
    const dx = wrapDelta(s.x - al.x, WORLD_SIZE);
    const dy = wrapDelta(s.y - al.y, WORLD_SIZE);
    const d = dx * dx + dy * dy;
    if (d > aggroSq) continue;
    let score = d;
    if (al.kind === AlienKind.HUNTER) score /= 1 + s.score / 2000; // hunters go after leaders
    if (s.invuln > 0) score *= 4; // leave fresh spawns alone
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  al.target = best;
  if (!best) al.wander += (game.rng() - 0.5) * 1.2;

  al.avoidX = 0;
  al.avoidY = 0;
  if (al.kind === AlienKind.MOTHERSHIP) return; // flies above the field
  for (const p of game.planets) {
    const dx = wrapDelta(al.x - p.x, WORLD_SIZE);
    const dy = wrapDelta(al.y - p.y, WORLD_SIZE);
    const d = Math.hypot(dx, dy) || 1;
    const margin = isStar(p) ? 320 : 180; // the star pulls hard and burns
    const clear = p.radius + al.radius + margin;
    if (d < clear) {
      const push = ((clear - d) / margin) * def.speed * 2;
      al.avoidX += (dx / d) * push;
      al.avoidY += (dy / d) * push;
    }
  }
  nearby.length = 0;
  game.grid.query(al.x, al.y, 200, 200, Mask.ASTEROID, nearby);
  for (const a of nearby) {
    const dx = wrapDelta(al.x - a.x, WORLD_SIZE);
    const dy = wrapDelta(al.y - a.y, WORLD_SIZE);
    const d = Math.hypot(dx, dy) || 1;
    const clear = a.radius + al.radius + 90;
    if (d < clear) {
      const push = ((clear - d) / clear) * def.speed * 1.5;
      al.avoidX += (dx / d) * push;
      al.avoidY += (dy / d) * push;
    }
  }
}

function fireAimed(game, al, t) {
  const def = al.def;
  const dx = wrapDelta(t.x - al.x, WORLD_SIZE);
  const dy = wrapDelta(t.y - al.y, WORLD_SIZE);
  let aim = Math.atan2(dy, dx);
  if (def.lead > 0) {
    const time = interceptTime(dx, dy, t.vx, t.vy, def.bulletSpeed);
    if (time > 0) aim = Math.atan2(dy + t.vy * time * def.lead, dx + t.vx * time * def.lead);
  }
  fireAlienBullet(game, al, aim + (game.rng() * 2 - 1) * def.spread);
}

function fireAlienBullet(game, al, angle) {
  const def = al.def;
  const mothership = al.kind === AlienKind.MOTHERSHIP;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  shot.x = wrap(al.x + ca * (al.radius + 6), WORLD_SIZE);
  shot.y = wrap(al.y + sa * (al.radius + 6), WORLD_SIZE);
  shot.vx = ca * def.bulletSpeed;
  shot.vy = sa * def.bulletSpeed;
  spawnBullet(
    game,
    al,
    mothership ? BulletKind.MOTHERSHIP : BulletKind.ALIEN,
    shot,
    def.bulletDamage,
    mothership ? 6 : 4,
    def.bulletLife,
    ALIEN_HITS,
    0,
    0,
  );
}

function updateMothership(game, ms, target) {
  const def = ms.def;
  if (--ms.lifeLeft <= 0) {
    ms.dead = true;
    ms.removeReason = RemoveReason.EXPIRED; // clients show it warping out
    game.mothership = null;
    game.outbox.announcements.push({ code: Announce.MOTHERSHIP_ESCAPED, playerId: NO_ID });
    return;
  }
  if (!target) return;
  if (--ms.burstCooldown <= 0) {
    ms.burstCooldown = def.burstInterval;
    const base = game.rng() * TAU;
    for (let i = 0; i < def.burstCount; i++) fireAlienBullet(game, ms, base + (i * TAU) / def.burstCount);
  }
  if (--ms.spawnCooldown <= 0) {
    ms.spawnCooldown = def.spawnInterval;
    if (ms.children < def.maxChildren) {
      const hunter = spawnAlien(game, AlienKind.HUNTER, ms.x, ms.y);
      if (hunter) {
        hunter.parent = ms;
        ms.children++;
      }
    }
  }
}

/** Saucers and hunters bounce off asteroids, taking a little damage. */
export function collideAliens(game) {
  for (const al of game.aliens) {
    if (al.dead || al.kind === AlienKind.MOTHERSHIP) continue;
    nearby.length = 0;
    game.grid.query(al.x, al.y, al.radius, al.radius, Mask.ASTEROID, nearby);
    for (const a of nearby) {
      const dx = wrapDelta(a.x - al.x, WORLD_SIZE);
      const dy = wrapDelta(a.y - al.y, WORLD_SIZE);
      const touch = al.radius + a.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= touch * touch) continue;
      const d = Math.sqrt(distSq) || 1;
      const nx = dx / d;
      const ny = dy / d;
      al.x = wrap(al.x - nx * (touch - d), WORLD_SIZE);
      al.y = wrap(al.y - ny * (touch - d), WORLD_SIZE);
      const closing = (al.vx - a.vx) * nx + (al.vy - a.vy) * ny;
      if (closing > 0) {
        al.vx -= 1.6 * closing * nx;
        al.vy -= 1.6 * closing * ny;
      }
      if (al.contactCooldown === 0) {
        al.contactCooldown = seconds(0.5);
        damageAsteroid(game, a, 8, null);
        damageAlien(game, al, 8, null);
      }
      if (al.dead) break;
    }
  }
}

/** Keeps a population of aliens proportional to the player count, plus the mothership event. */
export function maintainAliens(game) {
  if (game.tick % ALIEN_SPAWN.every === 0) {
    let regulars = 0;
    for (const al of game.aliens) if (!al.dead && al.kind !== AlienKind.MOTHERSHIP && !al.parent) regulars++;
    const wanted = Math.min(
      ALIEN_SPAWN.max,
      ALIEN_SPAWN.base + Math.floor(game.liveShipCount() / ALIEN_SPAWN.shipsPerAlien),
    );
    if (regulars < wanted) {
      const spot = findOpenSpot(game, ALIEN_SPAWN.minDistance, 12, true);
      const kind = game.rng() < ALIEN_SPAWN.hunterChance ? AlienKind.HUNTER : AlienKind.SAUCER;
      spawnAlien(game, kind, spot.x, spot.y);
    }
  }

  if (!game.mothership && game.tick >= game.nextMothershipTick) {
    if (game.liveShipCount() >= MOTHERSHIP.minShips) {
      const spot = findOpenSpot(game, 1500, 16);
      game.mothership = spawnAlien(game, AlienKind.MOTHERSHIP, spot.x, spot.y);
      game.outbox.announcements.push({ code: Announce.MOTHERSHIP_INBOUND, playerId: NO_ID });
      game.nextMothershipTick = game.tick + MOTHERSHIP.interval;
    } else {
      game.nextMothershipTick = game.tick + seconds(30);
    }
  }
}
