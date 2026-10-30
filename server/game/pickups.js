/** Pickup lifetime and world power-up spawns. Collection happens in ships.js. */
import { PickupKind, RemoveReason, isPowerup } from '../../shared/constants.js';
import { dropPowerup } from './combat.js';
import { findOpenSpot } from './spawning.js';
import { PICKUP } from './tuning.js';

export function updatePickups(game) {
  const tick = game.tick;
  for (const p of game.pickups) {
    if (!p.dead && tick >= p.expireTick) {
      p.dead = true;
      p.removeReason = RemoveReason.EXPIRED;
    }
  }
}

export function maintainPickups(game) {
  if (game.tick % PICKUP.spawnEvery !== 0) return;
  let powerups = 0;
  for (const p of game.pickups) if (!p.dead && isPowerup(p.kind)) powerups++;
  const target = PICKUP.worldPowerupsBase + Math.floor(game.liveShipCount() / PICKUP.shipsPerWorldPowerup);
  if (powerups < target) {
    const spot = findOpenSpot(game, 700, 8);
    dropPowerup(game, spot.x, spot.y, 0, game.rng() < 0.3 ? PickupKind.REPAIR : -1);
  }
}
