import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AlienKind,
  Announce,
  Button,
  EntityType,
  KillCause,
  PickupKind,
  Powerup,
  RemoveReason,
  TICK_RATE,
} from '../shared/constants.js';
import { NO_ID } from '../shared/protocol.js';
import { MAX_LEVEL, STAT_MAX, Stat, WEAPON_UNLOCK_LEVEL, Weapon, scoreForLevel } from '../shared/stats.js';
import { asteroidMass } from '../server/game/asteroids.js';
import { awardScore, collectPickup, damageAlien, damageShip, killShip } from '../server/game/combat.js';
import { Game } from '../server/game/Game.js';
import { randomName, sanitizeName } from '../server/game/names.js';
import { spawnAsteroid, spawnPickup } from '../server/game/spawning.js';
import { ASTEROID, MOTHERSHIP, PICKUP, REWARD, SHIP } from '../server/game/tuning.js';
import { addShip, emptyGame, hold } from './helpers.js';

test('a new game seeds the asteroid field to its target mass', () => {
  const game = new Game({ seed: 5 });
  assert.ok(asteroidMass(game) >= ASTEROID.targetMass);
});

test('players spawn with full hull, full energy and spawn protection', () => {
  const game = emptyGame();
  const player = game.addPlayer('Ace');
  assert.equal(player.ship, null);
  game.requestSpawn(player);
  game.step();
  const ship = player.ship;
  assert.ok(ship);
  assert.equal(ship.hp, ship.maxHp);
  assert.equal(ship.energy, ship.st.energyMax);
  assert.ok(ship.invuln > 0);
  assert.deepEqual(game.outbox.roster.map((p) => p.name), ['Ace']);
});

test('commands move the ship one step each and are acknowledged', () => {
  const game = emptyGame();
  const { player, ship } = addShip(game);
  hold(game, player, Button.THRUST, 30);
  assert.ok(ship.vx > 0 && ship.x > 1000);
  assert.equal(player.ackSeq, player.lastInputSeq);
});

test('stale, duplicate and dead-ship commands are ignored', () => {
  const game = emptyGame();
  const { player } = addShip(game);
  game.queueInput(player, 5, Button.THRUST, 0);
  game.queueInput(player, 5, Button.FIRE, 0);
  game.queueInput(player, 3, Button.FIRE, 0);
  assert.equal(player.inputs.size, 1);
  killShip(game, player.ship, null, KillCause.ASTEROID);
  game.queueInput(player, 6, Button.THRUST, 0);
  assert.equal(player.inputs.size, 0);
});

test('flooding commands cannot make a ship move faster than real time', () => {
  const game = emptyGame();
  const honest = addShip(game, 'Honest', 1000, 1000);
  const cheat = addShip(game, 'Cheat', 1000, 3000);
  for (let t = 0; t < 120; t++) {
    game.queueInput(honest.player, honest.player.lastInputSeq + 1, Button.THRUST, 0);
    for (let k = 0; k < 4; k++) game.queueInput(cheat.player, cheat.player.lastInputSeq + 1, Button.THRUST, 0);
    game.step();
  }
  const honestDistance = honest.ship.x - 1000;
  const cheatDistance = cheat.ship.x - 1000;
  assert.ok(cheatDistance <= honestDistance * 1.05, `cheat ${cheatDistance} vs honest ${honestDistance}`);
  assert.ok(cheat.player.inputs.size <= SHIP.maxCredits, 'excess commands are dropped, not simulated');
});

test('bursty delivery is absorbed: every command is applied in order', () => {
  const game = emptyGame();
  const { player } = addShip(game);
  let seq = 0;
  for (let t = 0; t < 60; t++) {
    if (t % 3 === 2) {
      for (let k = 0; k < 3; k++) game.queueInput(player, ++seq, Button.THRUST, 0);
    }
    game.step();
  }
  assert.equal(player.ackSeq, seq);
  assert.equal(player.inputs.size, 0);
});

test('projectiles split asteroids and award score to the shooter', () => {
  const game = emptyGame();
  const { player, ship } = addShip(game, 'Gunner', 1000, 1000, 0);
  const rock = spawnAsteroid(game, 2, 1150, 1000, 0, 0);
  rock.hp = 1; // one hit
  game.rebuildGrid();
  hold(game, player, Button.FIRE, 20);
  assert.ok(rock.dead);
  assert.equal(rock.removeReason, RemoveReason.DESTROYED);
  assert.equal(ship.score, ASTEROID.score[2]);
  const children = game.asteroids.filter((a) => !a.dead);
  assert.equal(children.length, 2);
  assert.ok(children.every((a) => a.size === 1));
});

test('killing a ship credits the killer, drops orbs and schedules a respawn', () => {
  const game = emptyGame();
  const killer = addShip(game, 'Killer', 1000, 1000, 0);
  const victim = addShip(game, 'Victim', 1150, 1000, Math.PI);
  victim.ship.score = 1000;
  victim.ship.hp = 5;
  game.clearOutbox();
  hold(game, killer.player, Button.FIRE, 15);
  assert.equal(victim.player.ship, null);
  assert.equal(killer.ship.kills, 1);
  assert.ok(killer.ship.score >= REWARD.killBase + 1000 * REWARD.killShare);
  const orbs = game.pickups.filter((p) => p.kind <= PickupKind.ORB_LARGE);
  assert.ok(orbs.length > 0);
  assert.equal(orbs.reduce((sum, p) => sum + p.value, 0) <= 1000 * REWARD.dropShare, true);
  assert.deepEqual(game.outbox.kills[0], { killerId: killer.player.id, victimId: victim.player.id, cause: KillCause.SHIP });
  assert.equal(game.outbox.deaths[0].player, victim.player);

  game.requestSpawn(victim.player);
  game.step();
  assert.equal(victim.player.ship, null, 'respawn waits for the delay');
  for (let i = 0; i < SHIP.respawnDelay; i++) game.step();
  assert.ok(victim.player.ship, 'respawned after the delay');
});

test('an asteroid kill shortly after combat credits the attacker', () => {
  const game = emptyGame();
  const attacker = addShip(game, 'A', 1000, 1000);
  const victim = addShip(game, 'V', 3000, 3000);
  damageShip(game, victim.ship, 10, attacker.ship, KillCause.SHIP, 0, 0);
  killShip(game, victim.ship, null, KillCause.ASTEROID);
  assert.equal(attacker.ship.kills, 1);
  assert.equal(game.outbox.kills.at(-1).killerId, attacker.player.id);
  assert.equal(game.outbox.kills.at(-1).cause, KillCause.ASTEROID);
});

test('spawn protection blocks damage until the ship fires', () => {
  const game = emptyGame();
  const { player, ship } = addShip(game);
  ship.invuln = 100;
  assert.equal(damageShip(game, ship, 50, null, KillCause.ASTEROID, 0, 0), 0);
  hold(game, player, Button.FIRE, 1);
  assert.equal(ship.invuln, 0);
  assert.ok(damageShip(game, ship, 50, null, KillCause.ASTEROID, 0, 0) > 0);
});

test('hull regenerates only after a quiet period', () => {
  const game = emptyGame();
  const { ship } = addShip(game);
  damageShip(game, ship, 40, null, KillCause.ASTEROID, 0, 0);
  const hurt = ship.hp;
  for (let i = 0; i < SHIP.regenDelay - 1; i++) game.step();
  assert.equal(ship.hp, hurt);
  for (let i = 0; i < TICK_RATE; i++) game.step();
  assert.ok(ship.hp > hurt);
});

test('levelling grants points; upgrades and weapon choice are validated', () => {
  const game = emptyGame();
  const { player, ship } = addShip(game);
  assert.equal(game.upgrade(player, Stat.HULL), false, 'no points yet');
  awardScore(game, ship, scoreForLevel(WEAPON_UNLOCK_LEVEL), ship.x, ship.y);
  assert.equal(ship.level, WEAPON_UNLOCK_LEVEL);
  assert.equal(ship.points, WEAPON_UNLOCK_LEVEL - 1);
  assert.ok(ship.weaponChoice);

  const hp = ship.hp;
  assert.ok(game.upgrade(player, Stat.HULL));
  assert.equal(ship.maxHp, 130);
  assert.equal(ship.hp, hp + 30, 'a hull upgrade also repairs the added capacity');
  assert.equal(game.upgrade(player, 99), false);
  for (let i = 1; i < STAT_MAX; i++) game.upgrade(player, Stat.RELOAD);
  assert.equal(ship.statLevels[Stat.RELOAD], STAT_MAX - 1);
  game.upgrade(player, Stat.RELOAD);
  assert.equal(game.upgrade(player, Stat.RELOAD), false, 'capped at STAT_MAX');

  assert.equal(game.chooseWeapon(player, Weapon.BLASTER), false, 'not a choice');
  assert.ok(game.chooseWeapon(player, Weapon.CANNON));
  assert.equal(ship.weapon, Weapon.CANNON);
  assert.equal(game.chooseWeapon(player, Weapon.TWIN), false, 'only one choice');
  assert.ok(ship.st.bulletRadius > 3);

  awardScore(game, ship, 10_000_000, 0, 0);
  assert.equal(ship.level, MAX_LEVEL);
});

test('power-ups: shield absorbs damage, rapid fire speeds up and expires', () => {
  const game = emptyGame();
  const { ship } = addShip(game);
  collectPickup(game, ship, spawnPickup(game, PickupKind.SHIELD, ship.x, ship.y, 0, PICKUP.powerupLife));
  const hp = ship.hp;
  damageShip(game, ship, 30, null, KillCause.ASTEROID, 0, 0);
  assert.equal(ship.hp, hp, 'shield took it');
  const interval = ship.st.fireInterval;
  collectPickup(game, ship, spawnPickup(game, PickupKind.RAPID, ship.x, ship.y, 0, PICKUP.powerupLife));
  assert.ok(ship.st.fireInterval < interval);
  const duration = ship.powerups[Powerup.RAPID];
  for (let i = 0; i <= duration; i++) game.step();
  assert.equal(ship.st.fireInterval, interval);
});

test('flying through a pickup collects it', () => {
  const game = emptyGame();
  const { ship } = addShip(game);
  const orb = spawnPickup(game, PickupKind.ORB_MEDIUM, ship.x + 5, ship.y, 40, PICKUP.orbLife);
  game.step();
  assert.ok(orb.dead);
  assert.equal(orb.removeReason, RemoveReason.COLLECTED);
  assert.equal(orb.collectorId, ship.id);
  assert.ok(ship.score >= 40);
});

test('ramming an asteroid bounces the ship and damages both', () => {
  const game = emptyGame();
  const { player, ship } = addShip(game, 'Rammer', 1000, 1000, 0);
  const rock = spawnAsteroid(game, 2, 1090, 1000, 0, 0);
  game.rebuildGrid();
  ship.vx = 400;
  hold(game, player, 0, 20);
  assert.ok(ship.hp < ship.maxHp);
  assert.ok(ship.vx < 0, 'bounced back');
  assert.ok(rock.version > 0, 'asteroid trajectory change is flagged for replication');
});

test('leaving mid-fight counts as a death for the attacker', () => {
  const game = emptyGame();
  const a = addShip(game, 'A', 1000, 1000);
  const b = addShip(game, 'B', 2000, 2000);
  damageShip(game, b.ship, 10, a.ship, KillCause.SHIP, 0, 0);
  game.removePlayer(b.player);
  assert.equal(a.ship.kills, 1);
  const c = addShip(game, 'C', 3000, 3000);
  game.removePlayer(c.player);
  assert.equal(a.ship.kills, 1, 'a peaceful exit is just a despawn');
  assert.ok(game.outbox.rosterRemoved.includes(c.player.id));
});

test('idle players are despawned, even with a resting mouse aim', () => {
  const game = emptyGame();
  const { player } = addShip(game);
  hold(game, player, Button.AIM, SHIP.idleDespawn + 2, 1.5); // same aim, no buttons
  assert.equal(player.ship, null);
  assert.ok(player.idle);

  const other = addShip(game, 'Busy');
  other.ship.invuln = Infinity; // the field refills meanwhile; keep this ship out of trouble
  hold(game, other.player, Button.AIM | Button.BRAKE, SHIP.idleDespawn + 2, 1.5);
  assert.ok(other.player.ship, 'pressing a button counts as activity');
});

test('bots fill the room at once and retire unseen as humans arrive', () => {
  const game = new Game({ seed: 3, botTarget: 4 });
  game.step();
  const bots = () => [...game.players.values()].filter((p) => p.isBot);
  assert.equal(bots().length, 4, 'a fresh room fills immediately');
  for (let i = 0; i < TICK_RATE; i++) game.step();
  assert.equal(game.ships.length, 4);

  game.addPlayer('Human');
  game.addPlayer('Human 2');
  for (let i = 0; i < TICK_RATE * 3; i++) game.step();
  assert.equal(bots().filter((p) => !p.retiring).length, 2, 'surplus bots retire');
  for (const p of bots().filter((b) => b.retiring && b.ship)) killShip(game, p.ship, null, KillCause.ASTEROID);
  game.step();
  assert.equal(bots().length, 2, 'retired bots leave once they die');
});

test('bots play the game: they move, shoot and score', () => {
  const game = new Game({ seed: 11, botTarget: 6 });
  for (let i = 0; i < TICK_RATE * 40; i++) game.step();
  const best = Math.max(...game.ships.map((s) => s.score));
  assert.ok(best > 50, `bots should score (best ${best})`);
});

test('dead entities are swept and their ids recycled in FIFO order', () => {
  const game = emptyGame();
  const a = spawnAsteroid(game, 0, 10, 10, 0, 0);
  const id = a.id;
  a.dead = true;
  game.sweep();
  assert.ok(!game.asteroids.includes(a));
  const b = spawnAsteroid(game, 0, 10, 10, 0, 0);
  assert.notEqual(b.id, id, 'a freed id goes to the back of the queue');
});

test('the asteroid field is replenished out of sight', () => {
  const game = new Game({ seed: 9 });
  clearAllAsteroids(game);
  for (let i = 0; i < ASTEROID.spawnEvery * 4; i++) game.step();
  assert.ok(game.asteroids.length >= 3);
});

function clearAllAsteroids(game) {
  for (const a of game.asteroids) a.dead = true;
  game.sweep();
}

test('the mothership event spawns, announces itself and can be destroyed', () => {
  const game = new Game({ seed: 4, botTarget: MOTHERSHIP.minShips });
  for (let i = 0; i < TICK_RATE * 6; i++) game.step();
  assert.equal(game.mothership, null, 'not before its schedule');
  game.nextMothershipTick = game.tick + 1;
  game.clearOutbox();
  for (let i = 0; i < 2; i++) game.step();
  assert.ok(game.mothership, 'mothership spawned');
  assert.equal(game.outbox.announcements[0].code, Announce.MOTHERSHIP_INBOUND);
  assert.equal(game.mothership.kind, AlienKind.MOTHERSHIP);
  const ms = game.mothership;
  game.clearOutbox();
  const { ship } = addShip(game, 'Hero', 100, 100);
  ms.hp = 1;
  const before = ship.score;
  damageAlien(game, ms, 10, ship);
  assert.ok(ms.dead);
  assert.equal(game.mothership, null);
  assert.ok(ship.score > before);
  assert.equal(game.outbox.announcements.at(-1).code, Announce.MOTHERSHIP_DESTROYED);
  assert.equal(game.outbox.announcements.at(-1).playerId, ship.playerId);
  assert.notEqual(ship.playerId, NO_ID);
});

test('names are sanitised and random names fit the limit', () => {
  assert.equal(sanitizeName('  Ace\u0000​  Pilot  '), 'Ace Pilot');
  assert.equal(sanitizeName('x'.repeat(40)).length, 16);
  assert.equal(sanitizeName(42), '');
  assert.equal([...sanitizeName('🚀'.repeat(20))].length, 16);
  for (let i = 0; i < 200; i++) assert.ok(randomName().length <= 16);
  assert.ok(randomName(() => 0.999999).length <= 16);
});

test('entity types are consistent', () => {
  const game = emptyGame();
  const { ship } = addShip(game);
  assert.equal(ship.type, EntityType.SHIP);
});
