/** Pickup lifetime and world spawns of power-ups and fuel cells. Collection happens in ships.js. */
import { PickupKind, RemoveReason, isPowerup } from '../../shared/constants.js';
import { dropFuel, dropPowerup } from './combat.js';
import { findOpenSpot } from './spawning.js';
import { FUEL, PICKUP } from './tuning.js';

export function updatePickups(game) {
  const tick = game.tick;
  for (const p of game.pickups) {
    if (!p.dead && tick >= p.expireTick) {
      p.dead = true;
      p.removeReason = RemoveReason.EXPIRED;
    }
  }
}

/** Tops up power-ups and fuel cells in open space (outside gravity wells, out of sight). */
export function maintainPickups(game) {
  if (game.tick % PICKUP.spawnEvery !== 0) return;
  let powerups = 0;
  let cells = 0;
  for (const p of game.pickups) {
    if (p.dead) continue;
    if (isPowerup(p.kind)) powerups++;
    else if (p.kind === PickupKind.FUEL) cells++;
  }
  const ships = game.liveShipCount();
  if (powerups < PICKUP.worldPowerupsBase + Math.floor(ships / PICKUP.shipsPerWorldPowerup)) {
    const spot = findOpenSpot(game, 700, 8);
    dropPowerup(game, spot.x, spot.y, 0, game.rng() < 0.3 ? PickupKind.REPAIR : -1);
  }
  if (cells < FUEL.worldCellsBase + Math.floor(ships / FUEL.shipsPerWorldCell)) {
    const spot = findOpenSpot(game, 700, 8, true);
    dropFuel(game, spot.x, spot.y);
  }
}
