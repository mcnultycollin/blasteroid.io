import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BodyKind, Button, EventKind, KillCause, NO_TEAM, OUTPOST_RADIUS, Perk, RoundPhase, TICK_RATE } from '../shared/constants.js';
import { BinaryReader, BinaryWriter, SnapshotWriter, readEntity, readSnapshot } from '../shared/protocol.js';
import { ShipClass, SINGULARITY } from '../shared/stats.js';
import { nightSide } from '../shared/terrain.js';
import { applyBlast, useAbility } from '../server/game/abilities.js';
import { damageShip, killShip } from '../server/game/combat.js';
import { Game } from '../server/game/Game.js';
import { outpostPoint, resetObjectives } from '../server/game/objectives.js';
import { spawnOrbiter } from '../server/game/planets.js';
import { spawnAsteroid } from '../server/game/spawning.js';
import { FLARE, NEBULA, OUTPOST, ROUND } from '../server/game/tuning.js';
import { buildSnapshot } from '../server/net/replication.js';
import { Session } from '../server/net/Session.js';
import { addShip, emptyGame, fixedBody, hold } from './helpers.js';

/** A team game with a star and one planet carrying an outpost of the given perk. */
function outpostGame(perk = Perk.SHIPYARD) {
  const game = emptyGame(1, { teams: true });
  const star = fixedBody(0, 4096, 4096, 200, 0.64, BodyKind.STAR, 'Sol');
  const planet = fixedBody(1, 5600, 4096, 140, 1);
  planet.spin = 1;
  game.planets = [star, planet];
  game.terrain = { outposts: [{ planet: 1, perk, name: 'Test Outpost' }], nebulae: [] };
  resetObjectives(game);
  return { game, star, planet };
}

/** Adds a ship of `shipClass` on a given team (overriding the automatic pick). */
function teamShip(game, team, name, x, y, shipClass = ShipClass.FIGHTER) {
  const s = addShip(game, name, x, y, 0, shipClass);
  s.player.team = team;
  s.ship.team = team;
  return s;
}

const tick = (game, n) => {
  for (let i = 0; i < n; i++) game.step();
};

test('players join the smaller team; bots keep the teams even', () => {
  const game = new Game({ seed: 4, botTarget: 0 });
  const teams = [];
  for (let i = 0; i < 6; i++) teams.push(game.addPlayer(`P${i}`).team);
  assert.equal(teams.filter((t) => t === 0).length, 3);
  assert.equal(teams.filter((t) => t === 1).length, 3);
  const ffa = new Game({ seed: 4, botTarget: 0, teams: false });
  assert.equal(ffa.addPlayer('Solo').team, NO_TEAM);

  const bots = new Game({ seed: 9, botTarget: 10 });
  tick(bots, 2);
  const sizes = [0, 0];
  for (const p of bots.players.values()) sizes[p.team]++;
  assert.deepEqual(sizes, [5, 5]);
});

test('no friendly fire: teammates’ shots pass through, enemies’ hit', () => {
  const game = emptyGame(1, { teams: true });
  const shooter = teamShip(game, 0, 'Shooter', 1000, 1000);
  const friend = teamShip(game, 0, 'Friend', 1150, 1000);
  const foe = teamShip(game, 1, 'Foe', 1300, 1000);
  hold(game, shooter.player, Button.FIRE, 40);
  assert.equal(friend.ship.hp, friend.ship.maxHp, 'the teammate in the way is untouched');
  assert.ok(foe.ship.hp < foe.ship.maxHp, 'the enemy behind is hit');
});

test('Medic shots repair damaged teammates and pay the Medic for it', () => {
  const game = emptyGame(1, { teams: true });
  const medic = teamShip(game, 0, 'Doc', 1000, 1000, ShipClass.MEDIC);
  const patient = teamShip(game, 0, 'Patient', 1150, 1000);
  patient.ship.hp = 40;
  patient.ship.lastDamageTick = game.tick; // no natural regen during the test
  const score = medic.ship.score;
  hold(game, medic.player, Button.FIRE, 30);
  assert.ok(patient.ship.hp > 40, 'repaired');
  assert.ok(medic.player.events.some((e) => e.kind === EventKind.HEAL), 'the Medic sees the repair');
  assert.ok(medic.ship.score > score, 'and scores for it');
});

test('repair pulse heals allies in range, not enemies; the aura keeps healing', () => {
  const game = emptyGame(1, { teams: true });
  const medic = teamShip(game, 0, 'Doc', 1000, 1000, ShipClass.MEDIC);
  const ally = teamShip(game, 0, 'Ally', 1200, 1000);
  const far = teamShip(game, 0, 'Far', 2000, 1000);
  const foe = teamShip(game, 1, 'Foe', 1000, 1200);
  for (const s of [ally, far, foe]) {
    s.ship.hp = 30;
    s.ship.lastDamageTick = game.tick;
  }
  useAbility(game, medic.ship, game.tick);
  assert.ok(ally.ship.hp > 60, 'ally healed by the pulse');
  assert.equal(far.ship.hp, 30, 'out of range');
  assert.equal(foe.ship.hp, 30, 'enemies are never healed');
  const before = ally.ship.hp;
  tick(game, TICK_RATE);
  assert.ok(ally.ship.hp > before, 'the aura heals nearby allies even right after damage');
  assert.equal(foe.ship.hp, 30);
});

test('outposts: one pilot captures in the capture time, more pilots faster; contested zones freeze', () => {
  const { game } = outpostGame();
  const p = outpostPoint(game, 0, {});
  const a = teamShip(game, 0, 'A', p.x + p.nx * 60, p.y + p.ny * 60);
  a.ship.invuln = 1e9;
  const keep = () => {
    a.ship.x = p.x + p.nx * 60;
    a.ship.y = p.y + p.ny * 60;
    a.ship.vx = a.ship.vy = 0;
  };
  for (let i = 0; i < OUTPOST.captureTime - 2; i++) {
    keep();
    game.step();
  }
  assert.equal(game.match.outposts[0].owner, NO_TEAM, 'not yet');
  for (let i = 0; i < 4; i++) {
    keep();
    game.step();
  }
  assert.equal(game.match.outposts[0].owner, 0, 'captured');
  assert.equal(game.match.outposts[0].progress, -1);
  assert.ok(game.match.perks[0] & Perk.SHIPYARD, 'the team holds the perk');

  // An enemy arrives: contested, nothing moves.
  const b = teamShip(game, 1, 'B', p.x + p.nx * 80, p.y + p.ny * 80);
  b.ship.invuln = 1e9;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    keep();
    b.ship.x = p.x + p.nx * 80;
    b.ship.y = p.y + p.ny * 80;
    game.step();
  }
  assert.equal(game.match.outposts[0].contested, true);
  assert.equal(game.match.outposts[0].progress, -1);
});

test('holding outposts scores team points every second and wins the round', () => {
  const { game } = outpostGame();
  game.match.outposts[0].owner = 1;
  game.match.outposts[0].progress = 1;
  tick(game, TICK_RATE * 5);
  assert.equal(game.match.scores[1], OUTPOST.pointsPerSecond * 5);
  const winner = teamShip(game, 1, 'Winner', 1000, 1000);
  const loser = teamShip(game, 0, 'Loser', 3000, 3000);
  game.match.scores[1] = ROUND.winScore - 1;
  tick(game, TICK_RATE);
  assert.equal(game.match.phase, RoundPhase.INTERMISSION);
  assert.equal(game.match.winner, 1);
  assert.ok(winner.ship.score >= ROUND.winBonus, 'the winning team is rewarded');
  assert.ok(loser.ship.score < ROUND.winBonus);
  tick(game, ROUND.intermission + 1);
  assert.equal(game.match.phase, RoundPhase.PLAYING, 'the next round starts');
  assert.deepEqual(game.match.scores, [0, 0]);
  assert.equal(game.match.outposts[0].owner, NO_TEAM, 'outposts reset');
});

test('enemy kills score for the team; the Shipyard respawns its team on the outpost', () => {
  const { game, star, planet } = outpostGame(Perk.SHIPYARD);
  const killer = teamShip(game, 1, 'Killer', 1000, 1000);
  const victim = teamShip(game, 0, 'Victim', 1100, 1000);
  victim.ship.lastAttacker = killer.ship;
  victim.ship.lastAttackTick = game.tick;
  killShip(game, victim.ship, killer.ship, KillCause.SHIP);
  assert.equal(game.match.scores[1], ROUND.killPoints);

  game.match.outposts[0].owner = 0;
  game.match.outposts[0].progress = -1;
  game.match.perks[0] = Perk.SHIPYARD;
  victim.player.respawnTick = 0;
  game.requestSpawn(victim.player);
  game.step();
  const ship = victim.player.ship;
  const p = nightSide(star, planet, 0, {});
  assert.ok(Math.hypot(ship.x - p.x, ship.y - p.y) < 40, 'spawned on the outpost');
});

test('team perks reach the team’s ships at once (and their clients through the stats block)', () => {
  const { game } = outpostGame(Perk.FORGE);
  const a = teamShip(game, 0, 'A', 1000, 1000);
  const damage = a.ship.st.damage;
  const version = a.ship.statsVersion;
  game.match.outposts[0].progress = -0.999;
  const p = outpostPoint(game, 0, {});
  const holder = teamShip(game, 0, 'Holder', p.x + p.nx * 50, p.y + p.ny * 50);
  holder.ship.invuln = 1e9;
  tick(game, 2);
  assert.equal(game.match.outposts[0].owner, 0);
  assert.ok(Math.abs(a.ship.st.damage / damage - 1.15) < 1e-9, 'Forge damage applied across the team');
  assert.ok(a.ship.statsVersion > version, 'and resent to the client');
});

test('solar flares scorch exposed ships; planets shelter whoever hides behind them', () => {
  const { game, planet } = outpostGame();
  game.nextFlareTick = game.tick + FLARE.warning + 1;
  game.step();
  assert.ok(game.match.flare, 'announced ahead of time');
  game.match.flare.angle = 0; // straight at the planet
  const exposed = teamShip(game, 0, 'Exposed', 4096 + 800, 4096);
  const hiding = teamShip(game, 1, 'Hiding', planet.x + 300, planet.y);
  for (const s of [exposed, hiding]) s.ship.hp = s.ship.maxHp = 1000;
  tick(game, FLARE.warning + FLARE.duration + 2);
  assert.ok(exposed.ship.hp < 1000 - FLARE.duration * FLARE.damage * 0.9, 'scorched');
  assert.equal(hiding.ship.hp, 1000, 'sheltered in the planet’s shadow');
  assert.equal(game.match.flare, null, 'over');
  assert.ok(game.nextFlareTick > game.tick, 'the next one is scheduled');
});

test('nebulae hide pilots from enemy clients (never sent) but not from teammates; firing reveals', () => {
  const game = emptyGame(1, { teams: true });
  game.terrain.nebulae = [{ x: 2000, y: 2000, radius: 300, seed: 1 }];
  const lurker = teamShip(game, 0, 'Lurker', 2000, 2000);
  const friend = teamShip(game, 0, 'Friend', 2800, 2000);
  const enemy = teamShip(game, 1, 'Enemy', 2800, 2100);
  game.step();
  assert.ok(lurker.ship.hidden);
  const sees = (viewer, target) => {
    const session = new Session({ readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() {} }, '::1');
    session.player = viewer.player;
    const r = new BinaryReader(buildSnapshot(game, session, new SnapshotWriter(new BinaryWriter(1024)), null));
    r.u8();
    const ids = [];
    readSnapshot(r, {
      begin() {}, self() {}, stats() {}, spectate() {}, world() {}, remove() {}, event() {}, effect() {}, fields() {}, end() {},
      entity: (type, id, reader) => {
        readEntity(type, reader, {});
        ids.push(id);
      },
    });
    return ids.includes(target.ship.id);
  };
  assert.equal(sees(enemy, lurker), false, 'enemies get nothing');
  assert.equal(sees(friend, lurker), true, 'teammates still see it');
  enemy.ship.x = 2000 + NEBULA.reveal - 50;
  enemy.ship.y = 2000;
  assert.equal(sees(enemy, lurker), true, 'up close it is revealed');
  enemy.ship.x = 2800;
  hold(game, lurker.player, Button.FIRE, 1);
  assert.equal(lurker.ship.hidden, false, 'firing gives you away');
  assert.equal(sees(enemy, lurker), true);
});

test('the singularity drags enemies, not teammates, rips belt rocks loose and crushes its core', () => {
  const { game, planet } = outpostGame();
  const graviton = teamShip(game, 0, 'Grav', 2000, 2000, ShipClass.GRAVITON);
  graviton.ship.angle = 0;
  useAbility(game, graviton.ship, game.tick);
  const f = game.fields[0];
  assert.ok(f && Math.abs(f.x - (2000 + SINGULARITY.distance)) < 0.2, 'deployed ahead of the nose');
  assert.equal(f.born, game.tick + 1);
  const enemy = teamShip(game, 1, 'Enemy', f.x + 200, f.y);
  const friend = teamShip(game, 0, 'Friend', f.x - 200, f.y + 50);
  friend.ship.vx = friend.ship.vy = enemy.ship.vx = enemy.ship.vy = 0;
  for (let i = 0; i < 30; i++) {
    game.queueInput(enemy.player, enemy.player.lastInputSeq + 1, 0, 0);
    game.queueInput(friend.player, friend.player.lastInputSeq + 1, 0, 0);
    game.step();
  }
  assert.ok(enemy.ship.vx < -50, `the enemy is dragged in (${enemy.ship.vx.toFixed(0)})`);
  assert.ok(Math.hypot(friend.ship.vx, friend.ship.vy) < 1, 'the teammate is not');

  // Crushing: an enemy parked in the core takes damage credited to the Graviton.
  enemy.ship.x = f.x;
  enemy.ship.y = f.y;
  enemy.ship.hp = 1;
  game.clearOutbox();
  tick(game, 3);
  const kill = game.outbox.kills.find((k) => k.victimId === enemy.player.id);
  assert.ok(kill && kill.cause === KillCause.SINGULARITY && kill.killerId === graviton.player.id);

  // Belt rocks inside the reach are ripped off their orbits.
  const rock = spawnOrbiter(game, planet, 1, false);
  const near = { ...game.fields[0], x: rock.x, y: rock.y };
  game.fields[0] = Object.assign(game.fields[0], { x: near.x, y: near.y });
  tick(game, 2);
  assert.equal(rock.orbit, null, 'released');
});

test('the Breaker’s ram drive smashes rocks without a scratch and hits enemies hard', () => {
  const game = emptyGame(1, { teams: true });
  const breaker = teamShip(game, 0, 'Ram', 1000, 1000, ShipClass.BREAKER);
  const rock = spawnAsteroid(game, 2, 1150, 1000, 0, 0);
  breaker.ship.energy = 600;
  hold(game, breaker.player, Button.ABILITY, 1);
  hold(game, breaker.player, 0, 20);
  assert.ok(rock.dead, 'the big rock shattered');
  assert.equal(breaker.ship.hp, breaker.ship.maxHp, 'the Breaker is unharmed');

  const arena = emptyGame(2, { teams: true });
  const rammer = teamShip(arena, 0, 'Ram', 1000, 1000, ShipClass.BREAKER);
  const target = teamShip(arena, 1, 'Target', 1200, 1000);
  hold(arena, rammer.player, Button.ABILITY, 1);
  hold(arena, rammer.player, 0, 25);
  const dealt = target.ship.maxHp - target.ship.hp;
  assert.ok(dealt > 30, `rammed for ${Math.round(dealt)}`);
  assert.ok(rammer.ship.maxHp - rammer.ship.hp < dealt / 3, 'the Breaker takes a fraction of it');
});

test('blasts and rams never hurt teammates', () => {
  const game = emptyGame(1, { teams: true });
  const a = teamShip(game, 0, 'A', 1000, 1000);
  const b = teamShip(game, 0, 'B', 1100, 1000);
  applyBlast(game, a.ship);
  assert.equal(b.ship.vx, 0, 'teammates are not shoved');
  b.ship.x = 1020;
  a.ship.vx = 400;
  hold(game, a.player, 0, 10);
  assert.equal(a.ship.hp, a.ship.maxHp);
  assert.equal(b.ship.hp, b.ship.maxHp, 'teammates bounce off each other harmlessly');
  damageShip(game, b.ship, 5, a.ship, KillCause.SHIP, 0, 0); // a direct call still works (e.g. scripted damage)
  assert.ok(b.ship.hp < b.ship.maxHp);
});

test('a full team match with bots: outposts change hands, rounds finish, nobody kills a teammate', () => {
  const game = new Game({ seed: 3, botTarget: 12 });
  game.nextMothershipTick = Infinity;
  let teamKills = 0;
  let captured = false;
  for (let i = 0; i < TICK_RATE * 60 * 5; i++) {
    game.step();
    for (const k of game.outbox.kills) {
      const killer = game.players.get(k.killerId);
      const victim = game.players.get(k.victimId);
      if (killer && victim && killer !== victim && killer.team === victim.team) teamKills++;
    }
    if (game.match.outposts.some((o) => o.owner !== NO_TEAM)) captured = true;
    game.clearOutbox();
  }
  assert.ok(captured, 'bots capture outposts');
  assert.ok(game.match.round > 1 || Math.max(...game.match.scores) > 300, 'and score for their team');
  assert.equal(teamKills, 0);
});
