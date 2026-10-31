/** Test helpers for building controlled game worlds. */
import { BodyKind, Button } from '../shared/constants.js';
import { createBody } from '../shared/gravity.js';
import { TAU } from '../shared/math.js';
import { Game } from '../server/game/Game.js';

/** A star or planet fixed at (x, y). */
export function fixedBody(id, x, y, radius, density, kind = BodyKind.ROCK, name = 'Test') {
  return createBody(id, kind, radius, density, name, { cx: x, cy: y, radius: 0, phase: 0, omega: 0 });
}

/** A planet circling (cx, cy) at `orbitRadius`, once every `period` ticks, starting at angle `phase`. */
export function orbitingBody(id, cx, cy, orbitRadius, period, radius, density, phase = 0, kind = BodyKind.ROCK) {
  return createBody(id, kind, radius, density, 'Mover', { cx, cy, radius: orbitRadius, phase, omega: TAU / period });
}

/** A game with no planets, asteroids, aliens or pickups, so tests control everything in it. */
export function emptyGame(seed = 1) {
  const game = new Game({ seed, botTarget: 0 });
  game.nextMothershipTick = Infinity;
  game.planets = []; // tests that need gravity add their own planet
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
