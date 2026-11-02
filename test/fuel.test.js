import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlienKind, BodyKind, Button, KillCause, PickupKind, Perk, TICK_RATE } from '../shared/constants.js';
import { collectPickup, killShip } from '../server/game/combat.js';
import { Game } from '../server/game/Game.js';
import { outpostPoint, resetObjectives } from '../server/game/objectives.js';
import { maintainPickups } from '../server/game/pickups.js';
import { spawnAlien, spawnPickup } from '../server/game/spawning.js';
import { FUEL, PICKUP } from '../server/game/tuning.js';
import { CLASSES, ShipClass } from '../shared/stats.js';
import { addShip, emptyGame, fixedBody, hold } from './helpers.js';

/* The star --------------------------------------------------------------------- */

test('touching the star destroys a ship outright, shield and spawn protection or not', () => {
  const game = emptyGame();
  game.planets = [fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR, 'Sol')];
  const { player, ship } = addShip(game, 'Icarus', 4000 + 200 + CLASSES[ShipClass.FIGHTER].radius + 2, 4000);
  ship.shield = 1000;
  ship.invuln = 1e9;
  ship.hp = ship.maxHp = 1e6;
  game.clearOutbox();
  hold(game, player, 0, 30);
  assert.equal(player.ship, null, 'gone on contact');
  assert.equal(game.outbox.kills.at(-1).cause, KillCause.STAR);
});

test('a pilot shoved into the star by an enemy is that enemy’s kill', () => {
  const game = emptyGame();
  game.planets = [fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR, 'Sol')];
  const victim = addShip(game, 'Victim', 4000 + 260, 4000);
  const bully = addShip(game, 'Bully', 4000 + 600, 4000);
  victim.ship.lastAttacker = bully.ship;
  victim.ship.lastAttackTick = game.tick;
  victim.ship.vx = -400;
  game.clearOutbox();
  hold(game, victim.player, 0, 30);
  const kill = game.outbox.kills.find((k) => k.victimId === victim.player.id);
  assert.ok(kill && kill.cause === KillCause.STAR && kill.killerId === bully.player.id);
});

test('saucers that touch the star are destroyed too', () => {
  const game = emptyGame();
  game.planets = [fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR, 'Sol')];
  const saucer = spawnAlien(game, AlienKind.SAUCER, 4000 + 200 + 20, 4000);
  for (let i = 0; i < TICK_RATE && !saucer.dead; i++) game.step();
  assert.ok(saucer.dead);
});

/* Spawn protection ------------------------------------------------------------------- */

test('spawn protection ends when a pilot blasts or uses an ability, not just when firing', () => {
  for (const button of [Button.BLAST, Button.ABILITY, Button.FIRE]) {
    const game = emptyGame();
    const { player, ship } = addShip(game, 'Fresh', 1000, 1000);
    ship.invuln = 100;
    hold(game, player, button, 1);
    assert.equal(ship.invuln, 0, `ended by ${button}`);
  }
});

/* Fuel cells and refuelling ----------------------------------------------------------- */

test('destroyed ships leave fuel cells, and a fuel cell refills part of the tank', () => {
  const game = emptyGame();
  const { ship } = addShip(game, 'Wreck', 2000, 2000);
  killShip(game, ship, null, KillCause.ASTEROID);
  const cells = game.pickups.filter((p) => p.kind === PickupKind.FUEL && !p.dead);
  assert.equal(cells.length, FUEL.shipDrop);

  const { ship: scavenger } = addShip(game, 'Scavenger', 3000, 3000);
  scavenger.fuel = 100;
  collectPickup(game, scavenger, cells[0]);
  assert.equal(scavenger.fuel, 100 + FUEL.cell);
  scavenger.fuel = scavenger.st.fuelMax - 10;
  collectPickup(game, scavenger, spawnPickup(game, PickupKind.FUEL, 3000, 3000, 0, 100));
  assert.equal(scavenger.fuel, scavenger.st.fuelMax, 'never past a full tank');
});

test('flying through a fuel cell collects it', () => {
  const game = emptyGame();
  const { player, ship } = addShip(game, 'Pilot', 1000, 1000);
  ship.fuel = 0;
  spawnPickup(game, PickupKind.FUEL, 1040, 1000, 0, 1000);
  game.rebuildGrid();
  ship.vx = 300;
  hold(game, player, 0, 10);
  assert.equal(ship.fuel, FUEL.cell);
});

test('fuel cells are kept floating in open space', () => {
  const game = emptyGame();
  for (let i = 0; i < 20; i++) {
    game.tick = PICKUP.spawnEvery * (i + 1);
    maintainPickups(game);
  }
  assert.ok(game.pickups.filter((p) => p.kind === PickupKind.FUEL).length >= FUEL.worldCellsBase);
});

test('a team’s own outpost refuels its pilots; the enemy’s does not', () => {
  const game = emptyGame(1, { teams: true });
  const star = fixedBody(0, 4096, 4096, 200, 0.64, BodyKind.STAR, 'Sol');
  const planet = fixedBody(1, 5600, 4096, 140, 1);
  game.planets = [star, planet];
  game.terrain = { outposts: [{ planet: 1, perk: Perk.REFINERY, name: 'Depot' }], nebulae: [] };
  resetObjectives(game);
  game.match.outposts[0].owner = 0;
  game.match.outposts[0].progress = -1;
  const p = outpostPoint(game, 0, {});
  const friend = addShip(game, 'Friend', p.x + p.nx * 60, p.y + p.ny * 60);
  const foe = addShip(game, 'Foe', p.x + p.nx * 90, p.y + p.ny * 60);
  friend.player.team = friend.ship.team = 0;
  foe.player.team = foe.ship.team = 1;
  friend.ship.invuln = foe.ship.invuln = 1e9;
  friend.ship.fuel = foe.ship.fuel = 0;
  game.step();
  assert.equal(friend.ship.fuel, FUEL.outpostRefuel);
  assert.equal(foe.ship.fuel, 0);
});

test('bots manage their fuel: they refuel instead of drifting on empty tanks', () => {
  const game = new Game({ seed: 5, botTarget: 10 });
  game.nextMothershipTick = Infinity;
  let samples = 0;
  let empty = 0;
  let refuels = 0;
  const before = new Map();
  for (let i = 0; i < TICK_RATE * 60 * 3; i++) {
    for (const s of game.ships) before.set(s, s.fuel);
    game.step();
    game.clearOutbox();
    for (const s of game.ships) {
      if (s.dead) continue;
      if (s.fuel > (before.get(s) ?? Infinity) + 10) refuels++;
      if (i % TICK_RATE === 0) {
        samples++;
        if (s.fuel === 0) empty++;
      }
    }
  }
  assert.ok(refuels > 0, 'bots refuel');
  assert.ok(empty / samples < 0.1, `bots spent ${((empty / samples) * 100).toFixed(1)}% of the time on empty`);
});
