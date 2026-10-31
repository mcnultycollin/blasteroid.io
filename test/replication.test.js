import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Button, EntityType, PickupKind, RemoveReason } from '../shared/constants.js';
import { BinaryReader, BinaryWriter, SnapshotWriter, readEntity, readSnapshot } from '../shared/protocol.js';
import { collectPickup } from '../server/game/combat.js';
import { spawnAsteroid, spawnPickup } from '../server/game/spawning.js';
import { PICKUP } from '../server/game/tuning.js';
import { buildSnapshot } from '../server/net/replication.js';
import { Session } from '../server/net/Session.js';
import { addShip, emptyGame, fixedBody, hold } from './helpers.js';

const fakeSocket = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() {} });
const writer = new SnapshotWriter(new BinaryWriter(1024));

function snapshot(game, session, leader = null) {
  const r = new BinaryReader(buildSnapshot(game, session, writer, leader));
  r.u8();
  const out = { records: [], removals: [], events: [], effects: [], self: null, stats: null, spectate: null };
  readSnapshot(r, {
    begin: (tick) => (out.tick = tick),
    self: (s) => (out.self = { ...s }),
    stats: (s) => (out.stats = { ...s }),
    spectate: (id, x, y) => (out.spectate = { id, x, y }),
    remove: (id, reason, collectorId) => out.removals.push({ id, reason, collectorId }),
    entity: (type, id, reader) => out.records.push({ type, id, ...readEntity(type, reader, {}) }),
    event: (ev) => out.events.push(ev),
    effect: (kind, x, y, angle, sourceId) => out.effects.push({ kind, x, y, angle, sourceId }),
    end: () => {},
  });
  assert.equal(r.remaining, 0);
  return out;
}

function setup() {
  const game = emptyGame();
  const me = addShip(game, 'Me', 1000, 1000);
  const other = addShip(game, 'Other', 1300, 1000);
  const near = spawnAsteroid(game, 1, 900, 900, 0, 0);
  const far = spawnAsteroid(game, 1, 4000, 4000, 0, 0);
  game.rebuildGrid();
  const session = new Session(fakeSocket(), '127.0.0.1');
  session.player = me.player;
  return { game, me, other, near, far, session };
}

test('first snapshot creates what is in view, with self and stats', () => {
  const { game, me, other, near, session } = setup();
  const s = snapshot(game, session);
  assert.equal(s.self.id, me.ship.id);
  assert.ok(s.stats, 'stats sent the first time');
  const ids = s.records.map((r) => r.id).sort();
  assert.deepEqual(ids, [other.ship.id, near.id].sort(), 'own ship and far asteroid excluded');
});

test('predictable entities are sent once; streamed ones every snapshot', () => {
  const { game, other, near, session } = setup();
  snapshot(game, session);
  game.step();
  let s = snapshot(game, session);
  assert.deepEqual(s.records.map((r) => r.id), [other.ship.id]);
  assert.equal(s.stats, null, 'unchanged stats are not resent');
  near.vx = 50;
  near.version++;
  game.step();
  s = snapshot(game, session);
  assert.ok(s.records.some((r) => r.id === near.id && r.vx === 50), 'trajectory change is resent');
});

test('removals carry the reason, including leaving the view', () => {
  const { game, other, near, session, me } = setup();
  const orb = spawnPickup(game, PickupKind.ORB_SMALL, 1100, 1100, 10, PICKUP.orbLife);
  game.rebuildGrid();
  snapshot(game, session);
  near.dead = true;
  near.removeReason = RemoveReason.DESTROYED;
  other.ship.x = 4000;
  collectPickup(game, me.ship, orb);
  game.step();
  const s = snapshot(game, session);
  const byId = Object.fromEntries(s.removals.map((r) => [r.id, r]));
  assert.equal(byId[near.id].reason, RemoveReason.DESTROYED);
  assert.equal(byId[other.ship.id].reason, RemoveReason.GONE);
  assert.equal(byId[orb.id].reason, RemoveReason.COLLECTED);
  assert.equal(byId[orb.id].collectorId, me.ship.id);
});

test('a recycled id is removed before it is re-created', () => {
  const { game, near, session } = setup();
  snapshot(game, session);
  near.dead = true;
  near.removeReason = RemoveReason.DESTROYED;
  game.sweep();
  const replacement = spawnAsteroid(game, 0, 950, 950, 0, 0);
  replacement.id = near.id; // force the worst case: immediate reuse
  game.rebuildGrid();
  const s = snapshot(game, session);
  assert.deepEqual(s.removals.map((r) => r.id), [near.id]);
  assert.ok(s.records.some((r) => r.id === near.id && r.size === 0));
});

test('own projectiles are flagged with the firing command for client matching', () => {
  const { game, me, session } = setup();
  snapshot(game, session);
  hold(game, me.player, Button.FIRE, 1);
  const s = snapshot(game, session);
  const bullet = s.records.find((r) => r.type === EntityType.BULLET);
  assert.ok(bullet, 'bullet replicated');
  assert.equal(bullet.own, true);
  assert.equal(bullet.fireSeq, me.player.ackSeq & 0xffff);
  assert.equal(bullet.fresh, true);
});

test('spectators get a camera target instead of a self block', () => {
  const { game, other } = setup();
  const spectator = new Session(fakeSocket(), '127.0.0.2');
  const s = snapshot(game, spectator, other.ship);
  assert.equal(s.self, null);
  assert.equal(s.spectate.id, other.ship.id);
  assert.ok(s.records.length > 0);
});

test('per-player events are delivered once', () => {
  const { game, session, me } = setup();
  me.player.events.push({ kind: 1, amount: 10, x: 1, y: 2 });
  assert.equal(snapshot(game, session).events.length, 1);
  assert.equal(snapshot(game, session).events.length, 0);
});

test('belt rocks are sent once; rocks falling in a gravity well are streamed', async () => {
  const { spawnOrbiter } = await import('../server/game/planets.js');
  const { game, session } = setup();
  const planet = fixedBody(0, 1000, 1250, 120, 1.2);
  planet.spin = 1;
  game.planets = [planet];
  const orbiter = spawnOrbiter(game, planet, 1, false);
  const faller = spawnAsteroid(game, 0, 1000, 1250 - 250, 0, 0);
  game.step();
  assert.ok(faller.streamed);
  snapshot(game, session);
  for (let i = 0; i < 3; i++) {
    game.step();
    const ids = snapshot(game, session).records.map((r) => r.id);
    assert.ok(ids.includes(faller.id), 'falling rock streamed');
    assert.ok(!ids.includes(orbiter.id), 'orbiting rock not resent');
  }
});

test('the self block carries command time and the orbit lock', () => {
  const { game, me, session } = setup();
  me.player.timeOffset = -1234;
  let s = snapshot(game, session);
  assert.equal(s.self.timeOffset, -1234);
  assert.equal(s.self.lockBody, -1);
  Object.assign(me.ship, { lockBody: 2, lockRadius: 321.5, lockPhase: 1.25, lockEpoch: 99999, lockOmega: 0.37, lockDir: -1 });
  s = snapshot(game, session);
  assert.deepEqual(
    [s.self.lockBody, s.self.lockRadius, s.self.lockPhase, s.self.lockEpoch, s.self.lockOmega, s.self.lockDir],
    [2, 321.5, 1.25, 99999, 0.37, -1],
    'exact, so the client follows the same orbit',
  );
});

test('blasts are replicated to nearby viewers, except the one who fired', async () => {
  const { applyBlast } = await import('../server/game/abilities.js');
  const { game, me, other, session } = setup();
  const theirs = new Session(fakeSocket(), '127.0.0.1');
  theirs.player = other.player;
  const farAway = addShip(game, 'Far', 5000, 5000);
  const distant = new Session(fakeSocket(), '127.0.0.1');
  distant.player = farAway.player;
  applyBlast(game, me.ship);
  assert.equal(snapshot(game, session).effects.length, 0, 'the blaster predicted their own');
  const seen = snapshot(game, theirs).effects;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sourceId, me.ship.id);
  assert.ok(Math.abs(seen[0].x - me.ship.x) < 0.2);
  assert.equal(snapshot(game, distant).effects.length, 0, 'out of view');
});
