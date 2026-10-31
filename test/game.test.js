import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AlienKind,
  Announce,
  BodyKind,
  Button,
  EntityType,
  FxKind,
  KillCause,
  PickupKind,
  Powerup,
  RemoveReason,
  SNAPSHOT_INTERVAL,
  ShipFlag,
  TICK_RATE,
} from '../shared/constants.js';
import { NO_ID } from '../shared/protocol.js';
import { MAX_LEVEL, STAT_MAX, Stat, WEAPON_UNLOCK_LEVEL, Weapon, scoreForLevel } from '../shared/stats.js';
import { asteroidMass } from '../server/game/asteroids.js';
import { awardScore, collectPickup, damageAlien, damageAsteroid, damageShip, killShip } from '../server/game/combat.js';
import { Game } from '../server/game/Game.js';
import { randomName, sanitizeName } from '../server/game/names.js';
import { findOpenSpot, spawnAsteroid, spawnPickup } from '../server/game/spawning.js';
import { pullAt, setPose } from '../shared/gravity.js';
import { applyBlast } from '../server/game/abilities.js';
import { generateSolarSystem, spawnOrbiter } from '../server/game/planets.js';
import { commandTick } from '../server/game/ships.js';
import { BotBrain, drawSkill } from '../server/game/bots.js';
import { spawnAlien } from '../server/game/spawning.js';
import { createRng } from '../shared/math.js';
import { ASTEROID, BLAST, MOTHERSHIP, PICKUP, PLANETS, REWARD, SHIP } from '../server/game/tuning.js';
import { addShip, emptyGame, fixedBody, hold, orbitingBody } from './helpers.js';

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

/* Planets ------------------------------------------------------------------ */

function planetGame(radius = 140, density = 1.5) {
  const game = emptyGame();
  const planet = fixedBody(0, 3000, 3000, radius, density);
  planet.spin = 1;
  game.planets = [planet];
  return { game, planet };
}

test('the solar system: a fixed star and one planet of each type, on orbits whose wells never meet', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const bodies = generateSolarSystem(createRng(seed));
    assert.deepEqual(bodies.map((b) => b.kind), [BodyKind.STAR, BodyKind.CORE, BodyKind.ROCK, BodyKind.GAS]);
    assert.ok(bodies.every((b, i) => b.id === i));
    const [star, core, rock, gas] = bodies;
    assert.equal(star.orbit.radius, 0, 'the star stays put');
    assert.ok(core.surfacePull > gas.surfacePull, 'the small core pulls hardest at its surface');
    assert.ok(core.orbit.radius < rock.orbit.radius && rock.orbit.radius === gas.orbit.radius, 'core inside, the others share the outer orbit');
    // Sample a whole outer period: no two wells ever overlap, and the system fits the torus.
    for (let tick = 0; tick < PLANETS.outerPeriod; tick += 600) {
      for (const b of bodies) setPose(b, tick);
      for (const a of bodies) {
        for (const b of bodies) {
          if (a.id >= b.id) continue;
          assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.range + b.range, `${a.name} and ${b.name} wells apart at ${tick}`);
        }
      }
    }
    const reach = Math.max(...bodies.map((b) => b.orbit.radius + b.range));
    assert.ok(reach < 4096, 'never closer to itself across the seam than to the star');
  }
});

test('planets block shots: a ship hiding behind one takes no damage', () => {
  const { game, planet } = planetGame();
  const shooter = addShip(game, 'Shooter', planet.x - planet.radius - 120, planet.y, 0);
  const hider = addShip(game, 'Hider', planet.x + planet.radius + 60, planet.y, Math.PI);
  hider.ship.invuln = 0;
  hold(game, shooter.player, Button.FIRE, 90);
  assert.equal(hider.ship.hp, hider.ship.maxHp);
  assert.ok(shooter.player.events.some((e) => e.kind === 2 && e.damage === 0), 'impacts are reported so clients show them');
});

test('crashing into a planet hurts, landing does not, and a crash can kill', () => {
  const { game, planet } = planetGame();
  const lander = addShip(game, 'Lander', planet.x + planet.radius + 24, planet.y);
  hold(game, lander.player, 0, 180); // a short drop: touch down gently and settle
  assert.equal(lander.ship.hp, lander.ship.maxHp);
  const diver = addShip(game, 'Diver', planet.x - planet.radius - 200, planet.y, 0);
  diver.ship.hp = 10;
  diver.ship.vx = 900;
  game.clearOutbox();
  hold(game, diver.player, Button.THRUST, 30);
  assert.equal(diver.player.ship, null, 'destroyed on impact');
  assert.equal(game.outbox.kills[0].cause, KillCause.PLANET);
});

test('belt rocks follow their orbits exactly and are only sent once', () => {
  const { game, planet } = planetGame();
  const rock = spawnOrbiter(game, planet, 2, false);
  assert.ok(rock.orbit);
  const version = rock.version;
  for (let i = 0; i < 300; i++) game.step();
  assert.ok(Math.abs(Math.hypot(rock.x - planet.x, rock.y - planet.y) - rock.orbit.radius) < 1e-6);
  assert.equal(rock.version, version, 'no re-sends: clients compute the orbit themselves');
});

test('ramming a belt rock knocks it off its orbit; from then on it falls freely', () => {
  const { game, planet } = planetGame();
  const rock = spawnOrbiter(game, planet, 2, false);
  const { player, ship } = addShip(game, 'Rammer', rock.x + 120, rock.y);
  game.rebuildGrid();
  ship.vx = rock.vx - 500;
  ship.vy = rock.vy;
  const version = rock.version;
  hold(game, player, 0, 20);
  assert.ok(ship.hp < ship.maxHp, 'the collision happened');
  assert.equal(rock.orbit, null, 'released from its orbit');
  assert.ok(rock.version > version, 'clients are sent its new path');
  hold(game, player, 0, 2);
  assert.equal(rock.streamed, true, 'and it is streamed while it falls inside the well');
});

test('shooting a belt rock splits it into rocks on neighbouring orbits', () => {
  const { game, planet } = planetGame();
  const rock = spawnOrbiter(game, planet, 2, false);
  rock.hp = 1;
  const { player } = addShip(game, 'Gunner', 0, 0);
  damageAsteroid(game, rock, 100, player.ship); // same path a projectile takes
  const fragments = game.asteroids.filter((a) => !a.dead && a !== rock);
  assert.equal(fragments.length, 2);
  for (const f of fragments) {
    assert.ok(f.orbit, 'fragments stay in orbit');
    assert.ok(Math.abs(f.orbit.radius - rock.orbit.radius) <= 34);
  }
  assert.notEqual(fragments[0].orbit.radius, fragments[1].orbit.radius);
});

test('loose rocks entering a well are streamed while they fall, and shatter on the surface', () => {
  const { game, planet } = planetGame();
  const rock = spawnAsteroid(game, 1, planet.x + planet.range + 40, planet.y, -120, 0);
  game.step();
  assert.equal(rock.streamed, false, 'outside the well it drifts in a straight line');
  let enteredAt = -1;
  for (let i = 0; i < 60 * 30 && !rock.dead; i++) {
    game.step();
    if (rock.streamed && enteredAt < 0) enteredAt = game.tick;
  }
  assert.ok(enteredAt > 0, 'streamed once inside the well');
  assert.ok(rock.dead, 'eventually crashed');
  assert.equal(rock.removeReason, RemoveReason.DESTROYED);
});

test('players, asteroids and aliens never spawn inside gravity wells', () => {
  const { game, planet } = planetGame(200, 1);
  for (let i = 0; i < 50; i++) {
    const spot = findOpenSpot(game, 900, 24, true);
    assert.ok(Math.hypot(spot.x - planet.x, spot.y - planet.y) > planet.range, 'outside the well');
  }
});

test('rocks and the star: the star burns ships and swallows rocks', () => {
  const game = emptyGame();
  const star = fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR, 'Sol');
  game.planets = [star];
  const { player, ship } = addShip(game, 'Icarus', 4000 + 200 + 30, 4000, Math.PI);
  game.clearOutbox();
  hold(game, player, 0, TICK_RATE * 3);
  assert.equal(player.ship, null, 'burned up');
  assert.equal(game.outbox.kills.at(-1).cause, KillCause.STAR);
  const rock = spawnAsteroid(game, 2, 4000 + 200 + 60, 4000, -50, 0);
  for (let i = 0; i < TICK_RATE * 2 && !rock.dead; i++) game.step();
  assert.ok(rock.dead && rock.removeReason === RemoveReason.DESTROYED);
});

test('ships land on a moving planet and ride along with it, unharmed', () => {
  const game = emptyGame();
  const planet = orbitingBody(0, 4000, 4000, 1500, TICK_RATE * 120, 140, 1.2);
  game.planets = [planet];
  setPose(planet, game.tick + 1);
  const { player, ship } = addShip(game, 'Lander', planet.x + 140 + 22, planet.y);
  ship.vx = planet.vx;
  ship.vy = planet.vy;
  hold(game, player, 0, TICK_RATE * 3);
  const start = { x: planet.x, y: planet.y };
  hold(game, player, 0, TICK_RATE * 4);
  assert.ok(Math.hypot(planet.x - start.x, planet.y - start.y) > 150, 'the planet moved on');
  assert.ok(Math.abs(Math.hypot(ship.x - planet.x, ship.y - planet.y) - 140 - ship.radius) < 1, 'the ship is still on its surface');
  assert.equal(ship.hp, ship.maxHp, 'a gentle landing does no damage');
});

test('orbit lock on the server: L locks, the ship is flagged, and a collision knocks it loose', () => {
  const { game, planet } = planetGame();
  const r = planet.radius + 150;
  const { player, ship } = addShip(game, 'Orbiter', planet.x + r, planet.y);
  ship.vy = Math.sqrt(pullAt(planet, r) * r);
  hold(game, player, Button.LOCK, 1);
  hold(game, player, 0, TICK_RATE * 2);
  assert.equal(ship.lockBody, 0);
  assert.ok(ship.flags & ShipFlag.LOCKED);
  assert.ok(Math.abs(Math.hypot(ship.x - planet.x, ship.y - planet.y) - r) < 1e-6);
  const rock = spawnAsteroid(game, 1, ship.x + ship.vx * 0.2, ship.y + ship.vy * 0.2, 0, 0);
  game.rebuildGrid();
  hold(game, player, 0, 30);
  assert.ok(rock.dead || rock.version > 0, 'the ship hit the rock');
  assert.equal(ship.lockBody, -1, 'knocked out of the lock');
});

test('the kinetic blast shoves what is in its cone, knocks belt rocks loose and is replicated once', () => {
  const { game, planet } = planetGame();
  const { player, ship } = addShip(game, 'Blaster', planet.x - planet.radius - 360, planet.y, 0); // facing the planet
  const ahead = spawnAsteroid(game, 1, ship.x + 150, ship.y, 0, 0);
  const behind = spawnAsteroid(game, 1, ship.x - 150, ship.y, 0, 0);
  const wide = spawnAsteroid(game, 1, ship.x, ship.y + 150, 0, 0); // 90° off the nose
  const belt = spawnOrbiter(game, planet, 2, false);
  Object.assign(belt, { x: ship.x + 300, y: ship.y + 20 }); // just inside the range
  game.rebuildGrid();
  assert.ok(applyBlast(game, ship) >= 2);
  assert.ok(ahead.vx > 300, 'pushed hard up close');
  assert.ok(ahead.pusher === ship && ahead.version > 0);
  assert.equal(behind.vx, 0, 'nothing behind the ship is touched');
  assert.equal(wide.vy, 0, 'nor outside the cone');
  assert.equal(belt.orbit, null, 'belt rocks are knocked off their orbits');
  assert.ok(belt.vx > 0);
  assert.ok(Math.hypot(belt.vx, belt.vy) <= ASTEROID.maxSpeed + 1e-9);
  assert.equal(game.fx.length, 1);
  assert.equal(game.fx[0].kind, FxKind.BLAST);
  for (let i = 0; i < SNAPSHOT_INTERVAL; i++) game.step();
  assert.equal(game.fx.length, 0, 'effects live for exactly one snapshot interval');

  // Through the input path: P costs energy and pushes the ship back.
  const energy = ship.energy;
  ship.vx = 0;
  hold(game, player, Button.BLAST, 1);
  assert.ok(ship.energy < energy && ship.vx < 0, 'recoil');
});

test('shoving a ship into a planet credits the blaster with the kill', () => {
  const { game, planet } = planetGame();
  const victim = addShip(game, 'Victim', planet.x - planet.radius - 60, planet.y, 0);
  const bully = addShip(game, 'Bully', planet.x - planet.radius - 200, planet.y, 0);
  victim.ship.hp = 5;
  game.clearOutbox();
  applyBlast(game, bully.ship);
  assert.ok(victim.ship.vx > 200, 'shoved towards the planet');
  for (let i = 0; i < 60 && victim.player.ship; i++) {
    game.queueInput(victim.player, victim.player.lastInputSeq + 1, 0, 0);
    game.queueInput(bully.player, bully.player.lastInputSeq + 1, Button.BRAKE, 0);
    game.step();
  }
  assert.equal(victim.player.ship, null, 'crashed');
  const kill = game.outbox.kills.find((k) => k.victimId === victim.player.id);
  assert.equal(kill.cause, KillCause.PLANET);
  assert.equal(kill.killerId, bully.player.id);
});

test('a shoved rock that hits someone counts as the shover’s hit', () => {
  const game = emptyGame();
  const shover = addShip(game, 'Shover', 1000, 1000, 0);
  const target = addShip(game, 'Target', 1500, 1000, Math.PI);
  target.ship.hp = 3;
  const rock = spawnAsteroid(game, 2, 1150, 1000, 0, 0);
  game.rebuildGrid();
  applyBlast(game, shover.ship);
  assert.equal(rock.pusher, shover.ship);
  game.clearOutbox();
  for (let i = 0; i < 90 && target.player.ship; i++) {
    game.queueInput(target.player, target.player.lastInputSeq + 1, 0, 0);
    game.step();
  }
  const kill = game.outbox.kills.find((k) => k.victimId === target.player.id);
  assert.ok(kill, 'the rock killed the target');
  assert.equal(kill.cause, KillCause.ASTEROID);
  assert.equal(kill.killerId, shover.player.id);
});

test('command time is anchored per life and re-anchored only on large or lasting drift', () => {
  const game = emptyGame();
  const player = game.addPlayer('Clock');
  game.tick = 1000;
  assert.equal(commandTick(game, player, 50), 1000, 'the first command anchors at world time');
  assert.equal(player.timeOffset, 950);
  game.tick = 1004;
  assert.equal(commandTick(game, player, 51), 1001, 'a backlog keeps its own times');
  game.tick = 1020;
  assert.equal(commandTick(game, player, 52), 1020, 'drifting past the slack re-anchors');
  assert.equal(player.timeOffset, 968);
  // Small, steady drift is tolerated for a while, then corrected.
  let seq = 53;
  game.tick = 1021 + SHIP.timeSoftSlack + 1;
  let reanchored = false;
  for (let i = 0; i <= SHIP.timeDriftLimit + 1 && !reanchored; i++, seq++, game.tick++) {
    reanchored = commandTick(game, player, seq) === game.tick;
  }
  assert.ok(reanchored, 'sustained drift is corrected');
  assert.ok(seq - 53 > SHIP.timeDriftLimit, 'but only after the drift limit');
});

test('bots fly around the solar system without crashing into it', () => {
  const game = new Game({ seed: 11, botTarget: 12 });
  game.nextMothershipTick = Infinity;
  let crashes = 0;
  let blasts = 0;
  for (let i = 0; i < TICK_RATE * 90; i++) {
    game.step();
    for (const k of game.outbox.kills) if (k.cause === KillCause.PLANET || k.cause === KillCause.STAR) crashes++;
    blasts += game.fx.filter((f) => f.tick === game.tick).length;
    game.clearOutbox();
  }
  assert.ok(crashes <= 2, `bots crashed ${crashes} times`);
  assert.ok(blasts > 0, 'bots use the kinetic blast');
});

/* Bot skill and stealth -------------------------------------------------------- */

test('most bots are rookies, a few are aces', () => {
  const rng = createRng(21);
  const skills = Array.from({ length: 2000 }, () => drawSkill(rng));
  const share = (f) => skills.filter(f).length / skills.length;
  assert.ok(share((s) => s < 0.35) > 0.55, 'majority are rookies');
  assert.ok(share((s) => s >= 0.65) > 0.05, 'some aces remain');
});

test('skilled bots keep the original behaviour; rookies are clearly worse', () => {
  for (const skill of [0.5, 0.75, 0.9]) {
    const b = new BotBrain(createRng(1), skill);
    assert.ok(Math.abs(b.aimJitter - (1 - skill) * 0.3) < 1e-12);
    assert.equal(b.reaction, Math.round((1 - skill) * 20));
    assert.equal(b.leadAccuracy, 1);
    assert.equal(b.aggroRange, 850);
    assert.equal(b.pauseTicks, 0);
  }
  const rookie = new BotBrain(createRng(1), 0.1);
  assert.ok(rookie.aimJitter > 0.35 && rookie.reaction > 30 && rookie.leadAccuracy < 0.6 && rookie.pauseTicks > 0);
});

function duel(skill, seed) {
  const game = emptyGame(seed);
  game.botTarget = 2; // one human + our one bot: nothing gets added or retired
  const target = addShip(game, 'Target', 3000, 3000);
  target.ship.hp = target.ship.maxHp = 1e9;
  const bot = game.addPlayer('Bot', true);
  bot.brain = new BotBrain(createRng(seed + 1), skill);
  bot.wantsSpawn = true;
  game.step();
  Object.assign(bot.ship, { x: 2620, y: 3000, vx: 0, vy: 0, invuln: 0 });
  let dealt = 0;
  for (let t = 0; t < 30 * TICK_RATE; t++) {
    game.queueInput(target.player, target.player.lastInputSeq + 1, Button.THRUST | Button.AIM, (t / TICK_RATE) * 1.2);
    const before = target.ship.hp;
    game.step();
    dealt += Math.max(0, before - target.ship.hp);
  }
  return dealt;
}

test('a rookie deals far less damage than an ace against a moving target', () => {
  const rookie = duel(0.15, 7) + duel(0.15, 8);
  const ace = duel(0.85, 7) + duel(0.85, 8);
  assert.ok(ace > 0);
  assert.ok(rookie < ace * 0.45, `rookie ${Math.round(rookie)} vs ace ${Math.round(ace)}`);
});

test('stealth hides a player from bots', () => {
  const game = emptyGame();
  game.botTarget = 2;
  const human = addShip(game, 'Tester', 3000, 3000);
  human.ship.hp = human.ship.maxHp = 1e9;
  const bot = game.addPlayer('Bot', true);
  bot.brain = new BotBrain(createRng(4), 0.9);
  bot.wantsSpawn = true;
  game.step();
  Object.assign(bot.ship, { x: 2700, y: 3000, invuln: 0 });

  human.player.stealth = true;
  for (let t = 0; t < 4 * TICK_RATE; t++) game.step();
  assert.notEqual(bot.brain.target, human.ship, 'bot ignores a stealthed ship');
  assert.ok(human.ship.flags & 128, 'the STEALTH flag reaches the client');

  human.player.stealth = false;
  Object.assign(bot.ship, { x: 2700, y: 3000 });
  for (let t = 0; t < TICK_RATE; t++) game.step();
  assert.equal(bot.brain.target, human.ship, 'visible again');
});

test('stealth hides a player from aliens', () => {
  const game = emptyGame();
  const human = addShip(game, 'Tester', 3000, 3000);
  human.ship.hp = human.ship.maxHp = 1e9;
  const saucer = spawnAlien(game, AlienKind.SAUCER, 3000, 2600);
  human.player.stealth = true;
  for (let t = 0; t < TICK_RATE; t++) game.step();
  assert.equal(saucer.target, null);
  human.player.stealth = false;
  for (let t = 0; t < TICK_RATE; t++) game.step();
  assert.equal(saucer.target, human.ship);
});
