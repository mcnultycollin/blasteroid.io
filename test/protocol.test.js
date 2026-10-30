import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AlienKind,
  BulletKind,
  EntityType,
  EventKind,
  MarkerKind,
  PickupKind,
  RemoveReason,
  WORLD_SIZE,
} from '../shared/constants.js';
import {
  BinaryReader,
  BinaryWriter,
  NO_ID,
  ServerMsg,
  SnapshotWriter,
  dqAngle,
  dqPos,
  dqVel,
  encodeLeaderboard,
  encodeRoster,
  qAngle,
  qPos,
  qVel,
  readEntity,
  readLeaderboard,
  readRoster,
  readSnapshot,
} from '../shared/protocol.js';

test('writer and reader round-trip primitives and strings', () => {
  const w = new BinaryWriter(4); // forces growth
  w.u8(200).u16(65000).i16(-1234).u32(4000000000).f64(Math.PI).str('Pilot ✨ 名前');
  const r = new BinaryReader(w.finish());
  assert.equal(r.u8(), 200);
  assert.equal(r.u16(), 65000);
  assert.equal(r.i16(), -1234);
  assert.equal(r.u32(), 4000000000);
  assert.equal(r.f64(), Math.PI);
  assert.equal(r.str(), 'Pilot ✨ 名前');
  assert.equal(r.remaining, 0);
  assert.throws(() => r.u8(), RangeError);
});

test('reader accepts a Node Buffer view into a larger pool', () => {
  const pool = Buffer.alloc(64, 0xff);
  pool[10] = 7;
  pool[11] = 0;
  pool[12] = 9;
  const r = new BinaryReader(pool.subarray(10, 13));
  assert.equal(r.u8(), 7);
  assert.equal(r.u16(), 9);
});

test('quantisation stays within its stated precision', () => {
  for (const v of [0, 1.5, 3071.9, WORLD_SIZE - 0.01]) {
    assert.ok(Math.abs(dqPos(qPos(v)) - v) <= WORLD_SIZE / 65536 || dqPos(qPos(v)) === 0);
  }
  assert.ok(Math.abs(dqAngle(qAngle(1.234)) - 1.234) < 1e-4);
  assert.equal(qAngle(-0.5), qAngle(Math.PI * 2 - 0.5));
  assert.equal(dqVel(qVel(123.4)), 123.375);
  assert.equal(qVel(1e9), 32767, 'velocity clamps instead of overflowing');
});

test('roster and leaderboard round-trip', () => {
  const w = new BinaryWriter();
  let r = new BinaryReader(encodeRoster(w, [{ id: 3, name: 'Ace' }, { id: 9, name: 'Zed' }]));
  assert.equal(r.u8(), ServerMsg.ROSTER);
  assert.deepEqual(readRoster(r), [{ id: 3, name: 'Ace' }, { id: 9, name: 'Zed' }]);

  r = new BinaryReader(encodeLeaderboard(w, 12, 4, [{ playerId: 3, score: 999 }], [{ kind: MarkerKind.LEADER, x: 100, y: 200 }]));
  assert.equal(r.u8(), ServerMsg.LEADERBOARD);
  const lb = readLeaderboard(r);
  assert.equal(lb.total, 12);
  assert.equal(lb.rank, 4);
  assert.deepEqual(lb.entries, [{ playerId: 3, score: 999 }]);
  assert.equal(lb.markers[0].kind, MarkerKind.LEADER);
  assert.ok(Math.abs(lb.markers[0].x - 100) < 0.1);
});

test('snapshot round-trips every section and entity type', () => {
  const ship = {
    id: 11, type: EntityType.SHIP, playerId: 4, x: 100.25, y: 6000.5, vx: -50.75, vy: 20, angle: 1.25,
    hp: 73.4, maxHp: 130, shield: 12.2, energy: 480, cooldown: 3, boostLock: 1, flags: 9,
    score: 1234, kills: 2, level: 6, points: 1, statLevels: Uint8Array.from([1, 0, 2, 0, 3, 0, 0, 1]),
    weapon: 2, weaponChoice: true, powerups: Uint16Array.from([100, 0, 50]), spawnTick: 77,
  };
  const entities = [
    { ...ship, id: 12, playerId: 5 },
    { id: 20, type: EntityType.ASTEROID, x: 50, y: 60, vx: 10, vy: -10, size: 2 },
    { id: 21, type: EntityType.BULLET, ownerId: 11, x: 1, y: 2, vx: 800, vy: 0, kind: BulletKind.CANNON, life: 40, fireSeq: 70001, muzzle: 1, spawnTick: 999 },
    { id: 22, type: EntityType.BULLET, ownerId: 12, x: 1, y: 2, vx: 0, vy: 800, kind: BulletKind.PLAYER, life: 300, fireSeq: 5, muzzle: 0, spawnTick: 100 },
    { id: 23, type: EntityType.ALIEN, x: 300, y: 400, vx: 1, vy: 2, kind: AlienKind.HUNTER, hp: 10, maxHp: 34 },
    { id: 24, type: EntityType.PICKUP, x: 5, y: 6, kind: PickupKind.SHIELD },
  ];
  const events = [
    { kind: EventKind.SCORE, amount: 50, x: 10, y: 20 },
    { kind: EventKind.HIT, seq: 70001, muzzle: 1, damage: 12.6, x: 30, y: 40, killed: true },
    { kind: EventKind.DAMAGE, amount: 8, angle: 2 },
  ];

  const out = new SnapshotWriter(new BinaryWriter(16));
  out.begin(1000, 1 | 2);
  out.self(ship, 555);
  out.stats(ship);
  out.beginList();
  out.removal(30, RemoveReason.DESTROYED, NO_ID);
  out.removal(31, RemoveReason.COLLECTED, 11);
  out.endList();
  out.beginList();
  for (const e of entities) out.entity(e, 11, 1000);
  out.endList();
  out.events(events);
  const bytes = out.finish();

  const got = { removals: [], entities: [], events: [] };
  const r = new BinaryReader(bytes);
  assert.equal(r.u8(), ServerMsg.SNAPSHOT);
  readSnapshot(r, {
    begin: (tick) => (got.tick = tick),
    self: (s) => (got.self = { ...s }),
    stats: (s) => (got.stats = { ...s, statLevels: Array.from(s.statLevels), powerups: Array.from(s.powerups) }),
    spectate: () => assert.fail('no spectate block was written'),
    remove: (id, reason, collector) => got.removals.push([id, reason, collector]),
    entity: (type, id, reader) => got.entities.push({ type, id, ...readEntity(type, reader, {}) }),
    event: (ev) => got.events.push(ev),
    end: () => (got.ended = true),
  });
  assert.equal(r.remaining, 0, 'decoder consumed exactly what the encoder wrote');
  assert.equal(got.tick, 1000);
  assert.equal(got.self.ackSeq, 555);
  assert.equal(got.self.x, 100.25, 'own ship is sent at full precision');
  assert.equal(got.self.vx, -50.75);
  assert.equal(got.self.hp, 74);
  assert.equal(got.self.boostLock, 1);
  assert.deepEqual(got.stats.statLevels, [1, 0, 2, 0, 3, 0, 0, 1]);
  assert.deepEqual(got.stats.powerups, [100, 0, 50]);
  assert.equal(got.stats.weaponChoice, true);
  assert.deepEqual(got.removals, [[30, RemoveReason.DESTROYED, NO_ID], [31, RemoveReason.COLLECTED, 11]]);
  assert.equal(got.entities.length, entities.length);
  const [s, a, own, other, alien, pickup] = got.entities;
  assert.equal(s.playerId, 5);
  assert.ok(Math.abs(s.hpFrac - 73.4 / 130) < 0.01);
  assert.equal(a.size, 2);
  assert.equal(own.own, true);
  assert.equal(own.fireSeq, 70001 & 0xffff);
  assert.equal(own.muzzle, 1);
  assert.equal(own.fresh, true);
  assert.equal(own.kind, BulletKind.CANNON);
  assert.equal(other.own, false);
  assert.equal(other.fresh, false);
  assert.equal(other.life, 255, 'life saturates at one byte');
  assert.equal(alien.kind, AlienKind.HUNTER);
  assert.equal(pickup.kind, PickupKind.SHIELD);
  assert.deepEqual(got.events[0], { kind: EventKind.SCORE, amount: 50, x: dqPos(qPos(10)), y: dqPos(qPos(20)) });
  assert.equal(got.events[1].damage, 13);
  assert.equal(got.events[1].killed, true);
  assert.equal(got.events[2].amount, 8);
  assert.ok(got.ended);
});
