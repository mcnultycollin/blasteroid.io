/**
 * Ship abilities that act on the world: the kinetic blast, and the shared
 * rule for shoving ships around (any outside push knocks a ship out of an
 * orbit lock, since a lock is a promise that nothing else moves it).
 */
import { AlienKind, FxKind, WORLD_SIZE } from '../../shared/constants.js';
import { wrapDelta } from '../../shared/math.js';
import { Mask } from './entities.js';
import { releaseFromOrbit } from './planets.js';
import { ASTEROID, BLAST } from './tuning.js';

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

/**
 * The kinetic blast: a cone of force from the ship's nose. Everything inside
 * it is shoved straight away from the ship, hardest up close. Belt rocks are
 * knocked off their orbits and fall freely from then on, so a blast can send
 * them into a planet, out of the well, or into an enemy (who is then hit
 * "by" the blaster). Ships are shoved too, and the blaster is credited if the
 * push ends in a crash. Returns how many things were pushed.
 */
export function applyBlast(game, ship) {
  const ca = Math.cos(ship.angle);
  const sa = Math.sin(ship.angle);
  nearby.length = 0;
  game.grid.query(ship.x, ship.y, REACH, REACH, TARGETS, nearby);
  let pushed = 0;
  for (const e of nearby) {
    if (e === ship || e.dead) continue;
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
      const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      if (speed > ASTEROID.maxSpeed) {
        e.vx *= ASTEROID.maxSpeed / speed;
        e.vy *= ASTEROID.maxSpeed / speed;
      }
      e.version++; // a new trajectory for clients
      e.pusher = ship;
      e.pushTick = game.tick;
    } else if (e.mask === Mask.SHIP) {
      const dv = strength * BLAST.shipShare;
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
