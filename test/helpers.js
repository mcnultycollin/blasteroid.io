/** Test helpers for building controlled game worlds. */
import { Button } from '../shared/constants.js';
import { Game } from '../server/game/Game.js';

/** A game with no asteroids, aliens or pickups, so tests control everything in it. */
export function emptyGame(seed = 1) {
  const game = new Game({ seed, botTarget: 0 });
  game.nextMothershipTick = Infinity;
  clearWorld(game);
  return game;
}

export function clearWorld(game) {
  for (const list of [game.asteroids, game.aliens, game.pickups, game.bullets]) {
    for (const e of list) e.dead = true;
  }
  game.sweep();
  game.rebuildGrid();
}

/** Adds a human player and spawns their ship at (x, y), facing `angle`, without spawn protection. */
export function addShip(game, name = 'Pilot', x = 1000, y = 1000, angle = 0) {
  const player = game.addPlayer(name, false);
  game.requestSpawn(player);
  game.step();
  const ship = player.ship;
  ship.x = x;
  ship.y = y;
  ship.vx = 0;
  ship.vy = 0;
  ship.angle = angle;
  ship.invuln = 0;
  game.rebuildGrid();
  return { player, ship };
}

/** Feeds one command per tick for `ticks` ticks. */
export function hold(game, player, buttons, ticks, aim = 0) {
  for (let i = 0; i < ticks; i++) {
    game.queueInput(player, player.lastInputSeq + 1, buttons, aim);
    game.step();
  }
}

export { Button };
