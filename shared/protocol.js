/**
 * Binary wire protocol. Every message starts with a u8 type. Integers are
 * big-endian (DataView default). Positions travel as u16 over the world size
 * (~0.09 unit precision), angles as u16, velocities as i16 in 1/16 unit/s.
 * The player's own ship is sent at full float64 precision so prediction can
 * replay from the exact authoritative state.
 *
 * Both directions of every message are defined here so the layout lives in
 * exactly one place.
 */
import {
  EntityType,
  EventKind,
  POWERUP_COUNT,
  PROTOCOL_VERSION,
  RemoveReason,
  SNAPSHOT_INTERVAL,
  WORLD_SIZE,
} from './constants.js';
import { TAU, clamp, normalizeAngle } from './math.js';
import { STAT_COUNT } from './stats.js';

export const ClientMsg = Object.freeze({ JOIN: 1, INPUT: 2, UPGRADE: 3, WEAPON: 4, PING: 5, STEALTH: 6 });

export const ServerMsg = Object.freeze({
  WELCOME: 1,
  JOINED: 2,
  SNAPSHOT: 3,
  ROSTER: 4,
  ROSTER_REMOVE: 5,
  LEADERBOARD: 6,
  KILL: 7,
  DEATH: 8,
  PONG: 9,
  ANNOUNCE: 10,
  KICK: 11,
});

export const SnapFlag = Object.freeze({ SELF: 1, STATS: 2, SPECTATE: 4 });

/** Sentinel for "no entity / no player". Ids are allocated in 1..0xfffe. */
export const NO_ID = 0xffff;

const BULLET_FRESH = 0x40;
const BULLET_OWN = 0x80;
const BULLET_KIND_MASK = 0x3f;
const ASTEROID_SIZE_MASK = 0x03;
const ASTEROID_ORBIT = 0x04; // on a circular orbit: sent once as orbit parameters
const ASTEROID_BALLISTIC = 0x08; // loose inside a gravity well: streamed every snapshot
const ASTEROID_RETROGRADE = 0x10; // orbit runs clockwise on screen

/* Quantisation ------------------------------------------------------------ */

const POS_SCALE = 65536 / WORLD_SIZE;
const ANGLE_SCALE = 65536 / TAU;
const VEL_SCALE = 16;

export const qPos = (v) => Math.round(v * POS_SCALE) & 0xffff;
export const dqPos = (q) => q / POS_SCALE;
export const qAngle = (a) => Math.round(normalizeAngle(a) * ANGLE_SCALE) & 0xffff;
export const dqAngle = (q) => q / ANGLE_SCALE;
export const qVel = (v) => clamp(Math.round(v * VEL_SCALE), -32768, 32767);
export const dqVel = (q) => q / VEL_SCALE;
const qFrac = (v, max) => clamp(Math.ceil((255 * v) / max), 0, 255);

/* Buffers ----------------------------------------------------------------- */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Growable writer. Reuse one instance; finish() returns an independent copy. */
export class BinaryWriter {
  constructor(capacity = 256) {
    this.pos = 0;
    this.allocate(capacity);
  }

  allocate(capacity) {
    const old = this.bytes;
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    if (old) this.bytes.set(old.subarray(0, this.pos));
  }

  ensure(n) {
    const need = this.pos + n;
    if (need > this.buffer.byteLength) this.allocate(Math.max(need, this.buffer.byteLength * 2));
  }

  reset() {
    this.pos = 0;
    return this;
  }

  u8(v) {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  u16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v);
    this.pos += 2;
    return this;
  }

  i16(v) {
    this.ensure(2);
    this.view.setInt16(this.pos, v);
    this.pos += 2;
    return this;
  }

  u32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0);
    this.pos += 4;
    return this;
  }

  f64(v) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v);
    this.pos += 8;
    return this;
  }

  /** UTF-8 string with a u8 byte-length prefix (truncated to 255 bytes). */
  str(s) {
    const bytes = textEncoder.encode(s);
    const n = Math.min(bytes.length, 255);
    this.u8(n);
    this.ensure(n);
    this.bytes.set(bytes.subarray(0, n), this.pos);
    this.pos += n;
    return this;
  }

  patchU16(at, v) {
    this.view.setUint16(at, v);
  }

  finish() {
    return this.bytes.slice(0, this.pos);
  }
}

/** Reader over an ArrayBuffer or any ArrayBufferView (e.g. a Node Buffer). Throws RangeError on overrun. */
export class BinaryReader {
  constructor(source) {
    this.view =
      source instanceof ArrayBuffer
        ? new DataView(source)
        : new DataView(source.buffer, source.byteOffset, source.byteLength);
    this.pos = 0;
  }

  get remaining() {
    return this.view.byteLength - this.pos;
  }

  u8() {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16() {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16() {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  f64() {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  str() {
    const n = this.u8();
    if (n > this.remaining) throw new RangeError('string overruns message');
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return textDecoder.decode(bytes);
  }
}

/* Client -> server -------------------------------------------------------- */

export function encodeJoin(w, name) {
  return w.reset().u8(ClientMsg.JOIN).u8(PROTOCOL_VERSION).str(name).finish();
}

/** One input command. The count byte leaves room for batching later. */
export function encodeInput(w, seq, buttons, aimQ) {
  return w.reset().u8(ClientMsg.INPUT).u32(seq).u8(1).u8(buttons).u16(aimQ).finish();
}

export function encodeUpgrade(w, stat) {
  return w.reset().u8(ClientMsg.UPGRADE).u8(stat).finish();
}

export function encodeWeapon(w, weapon) {
  return w.reset().u8(ClientMsg.WEAPON).u8(weapon).finish();
}

export function encodePing(w, time) {
  return w.reset().u8(ClientMsg.PING).u32(time).finish();
}

/** Toggles stealth (hidden from bots and aliens); servers only honour it with dev tools on. */
export function encodeStealth(w) {
  return w.reset().u8(ClientMsg.STEALTH).finish();
}

/* Server -> client: small messages ------------------------------------------ */

/** Includes the room's planets (they never move, so clients learn them once) and Feature bits. */
export function encodeWelcome(w, tick, roomId, planets, features) {
  w.reset().u8(ServerMsg.WELCOME).u8(PROTOCOL_VERSION).u32(tick).u16(roomId).u8(features).u8(planets.length);
  for (const p of planets) w.f64(p.x).f64(p.y).f64(p.radius).f64(p.density).str(p.name);
  return w.finish();
}

export function readWelcome(r) {
  const welcome = { version: r.u8(), tick: r.u32(), roomId: r.u16(), features: r.u8(), planets: [] };
  for (let n = r.u8(); n > 0; n--) {
    welcome.planets.push({ x: r.f64(), y: r.f64(), radius: r.f64(), density: r.f64(), name: r.str() });
  }
  return welcome;
}

export function encodeJoined(w, playerId) {
  return w.reset().u8(ServerMsg.JOINED).u16(playerId).finish();
}

/** Up to 255 players per message; callers chunk larger rosters. */
export function encodeRoster(w, players) {
  w.reset().u8(ServerMsg.ROSTER).u8(players.length);
  for (const p of players) w.u16(p.id).str(p.name);
  return w.finish();
}

export function readRoster(r) {
  const list = [];
  for (let n = r.u8(); n > 0; n--) list.push({ id: r.u16(), name: r.str() });
  return list;
}

export function encodeRosterRemove(w, playerId) {
  return w.reset().u8(ServerMsg.ROSTER_REMOVE).u16(playerId).finish();
}

/**
 * entries: [{playerId, score}], markers: [{kind, x, y}]. `rank` is the
 * recipient's 1-based position (0 when not playing).
 */
export function encodeLeaderboard(w, total, rank, entries, markers) {
  w.reset().u8(ServerMsg.LEADERBOARD).u16(total).u16(rank).u8(entries.length);
  for (const e of entries) w.u16(e.playerId).u32(e.score);
  w.u8(markers.length);
  for (const m of markers) w.u8(m.kind).u16(qPos(m.x)).u16(qPos(m.y));
  return w.finish();
}

export function readLeaderboard(r) {
  const total = r.u16();
  const rank = r.u16();
  const entries = [];
  for (let n = r.u8(); n > 0; n--) entries.push({ playerId: r.u16(), score: r.u32() });
  const markers = [];
  for (let n = r.u8(); n > 0; n--) markers.push({ kind: r.u8(), x: dqPos(r.u16()), y: dqPos(r.u16()) });
  return { total, rank, entries, markers };
}

export function encodeKill(w, killerId, victimId, cause) {
  return w.reset().u8(ServerMsg.KILL).u16(killerId).u16(victimId).u8(cause).finish();
}

export function readKill(r) {
  return { killerId: r.u16(), victimId: r.u16(), cause: r.u8() };
}

export function encodeDeath(w, d) {
  return w
    .reset()
    .u8(ServerMsg.DEATH)
    .u16(d.killerId)
    .u8(d.cause)
    .u32(d.score)
    .u8(d.level)
    .u16(d.kills)
    .u32(d.aliveTicks)
    .finish();
}

export function readDeath(r) {
  return {
    killerId: r.u16(),
    cause: r.u8(),
    score: r.u32(),
    level: r.u8(),
    kills: r.u16(),
    aliveTicks: r.u32(),
  };
}

export function encodePong(w, time, tick) {
  return w.reset().u8(ServerMsg.PONG).u32(time).u32(tick).finish();
}

export function readPong(r) {
  return { time: r.u32(), tick: r.u32() };
}

export function encodeAnnounce(w, code, playerId) {
  return w.reset().u8(ServerMsg.ANNOUNCE).u8(code).u16(playerId).finish();
}

export function readAnnounce(r) {
  return { code: r.u8(), playerId: r.u16() };
}

export function encodeKick(w, reason) {
  return w.reset().u8(ServerMsg.KICK).u8(reason).finish();
}

/* Snapshots ----------------------------------------------------------------- */
/*
 * u8   ServerMsg.SNAPSHOT
 * u32  tick
 * u8   SnapFlag bits
 * [SELF]      own ship, full precision (see writeSelf)
 * [STATS]     progression, sent only when changed (see writeStats)
 * [SPECTATE]  u16 entity id, u16 x, u16 y: camera target while not playing
 * u16  removal count, then { u16 id, u8 RemoveReason, [u16 collector id if COLLECTED] }
 * u16  entity count,  then { u8 EntityType, u16 id, payload }
 * u8   event count,   then { u8 EventKind, payload }
 *
 * Entity records are creates when the client does not know the id yet and
 * updates otherwise. Ships and aliens are streamed every snapshot; asteroids,
 * projectiles and pickups move predictably, so they are sent once and again
 * only when their motion changes. Removals always precede records, which keeps
 * id reuse unambiguous.
 */

export class SnapshotWriter {
  constructor(writer) {
    this.w = writer;
    this.countAt = 0;
    this.count = 0;
  }

  begin(tick, flags) {
    this.w.reset().u8(ServerMsg.SNAPSHOT).u32(tick).u8(flags);
  }

  self(ship, ackSeq) {
    this.w
      .u32(ackSeq)
      .u16(ship.id)
      .f64(ship.x)
      .f64(ship.y)
      .f64(ship.vx)
      .f64(ship.vy)
      .f64(ship.angle)
      .u16(ship.energy)
      .u8(ship.cooldown)
      .u8(ship.boostLock)
      .u16(Math.ceil(ship.hp))
      .u16(Math.ceil(ship.shield))
      .u8(ship.flags);
  }

  stats(ship) {
    const w = this.w;
    w.u32(ship.score).u16(ship.kills).u8(ship.level).u8(ship.points);
    for (let i = 0; i < STAT_COUNT; i++) w.u8(ship.statLevels[i]);
    w.u8(ship.weapon).u8(ship.weaponChoice ? 1 : 0);
    for (let i = 0; i < POWERUP_COUNT; i++) w.u16(ship.powerups[i]);
    w.u32(ship.spawnTick);
  }

  spectate(id, x, y) {
    this.w.u16(id).u16(qPos(x)).u16(qPos(y));
  }

  beginList() {
    this.countAt = this.w.pos;
    this.count = 0;
    this.w.u16(0);
  }

  endList() {
    this.w.patchU16(this.countAt, this.count);
  }

  removal(id, reason, collectorId) {
    this.w.u16(id).u8(reason);
    if (reason === RemoveReason.COLLECTED) this.w.u16(collectorId);
    this.count++;
  }

  /** `viewerShipId` marks the recipient's own projectiles; `tick` flags freshly fired ones. */
  entity(e, viewerShipId, tick) {
    const w = this.w;
    w.u8(e.type).u16(e.id);
    switch (e.type) {
      case EntityType.SHIP:
        w.u16(e.playerId)
          .u16(qPos(e.x))
          .u16(qPos(e.y))
          .u16(qAngle(e.angle))
          .i16(qVel(e.vx))
          .i16(qVel(e.vy))
          .u8(qFrac(e.hp, e.maxHp))
          .u8(e.flags)
          .u8(e.level)
          .u8(e.weapon);
        break;
      case EntityType.ASTEROID: {
        const o = e.orbit;
        w.u8(e.size | (o ? ASTEROID_ORBIT : 0) | (e.streamed ? ASTEROID_BALLISTIC : 0) | (o && o.dir < 0 ? ASTEROID_RETROGRADE : 0));
        // Orbit phases and radii are snapped to these encodings server-side, so they round-trip exactly.
        if (o) w.u8(o.planet).u16(o.radius).u16(qAngle(o.phase)).u32(o.epoch);
        else w.u16(qPos(e.x)).u16(qPos(e.y)).i16(qVel(e.vx)).i16(qVel(e.vy));
        break;
      }
      case EntityType.BULLET: {
        const own = viewerShipId !== NO_ID && e.ownerId === viewerShipId;
        const fresh = tick - e.spawnTick <= SNAPSHOT_INTERVAL;
        w.u16(e.ownerId)
          .u16(qPos(e.x))
          .u16(qPos(e.y))
          .i16(qVel(e.vx))
          .i16(qVel(e.vy))
          .u8(e.kind | (fresh ? BULLET_FRESH : 0) | (own ? BULLET_OWN : 0))
          .u8(Math.min(255, e.life));
        if (own) w.u16(e.fireSeq & 0xffff).u8(e.muzzle);
        break;
      }
      case EntityType.ALIEN:
        w.u16(qPos(e.x))
          .u16(qPos(e.y))
          .i16(qVel(e.vx))
          .i16(qVel(e.vy))
          .u8(e.kind)
          .u8(qFrac(e.hp, e.maxHp));
        break;
      case EntityType.PICKUP:
        w.u16(qPos(e.x)).u16(qPos(e.y)).u8(e.kind);
        break;
      default:
        throw new Error(`cannot encode entity type ${e.type}`);
    }
    this.count++;
  }

  events(list) {
    const w = this.w;
    const n = Math.min(list.length, 255);
    w.u8(n);
    for (let i = 0; i < n; i++) {
      const ev = list[i];
      w.u8(ev.kind);
      switch (ev.kind) {
        case EventKind.SCORE:
          w.u16(Math.min(ev.amount, 0xffff)).u16(qPos(ev.x)).u16(qPos(ev.y));
          break;
        case EventKind.HIT:
          w.u16(ev.seq & 0xffff)
            .u8(ev.muzzle)
            .u16(Math.min(Math.round(ev.damage), 0xffff))
            .u16(qPos(ev.x))
            .u16(qPos(ev.y))
            .u8(ev.killed ? 1 : 0);
          break;
        case EventKind.DAMAGE:
          w.u16(Math.min(Math.round(ev.amount), 0xffff)).u16(qAngle(ev.angle));
          break;
        default:
          throw new Error(`cannot encode event kind ${ev.kind}`);
      }
    }
  }

  finish() {
    return this.w.finish();
  }
}

/** Decodes an entity payload into `o`, using the same field names the server entities use. */
export function readEntity(type, r, o) {
  switch (type) {
    case EntityType.SHIP:
      o.playerId = r.u16();
      o.x = dqPos(r.u16());
      o.y = dqPos(r.u16());
      o.angle = dqAngle(r.u16());
      o.vx = dqVel(r.i16());
      o.vy = dqVel(r.i16());
      o.hpFrac = r.u8() / 255;
      o.flags = r.u8();
      o.level = r.u8();
      o.weapon = r.u8();
      break;
    case EntityType.ASTEROID: {
      const bits = r.u8();
      o.size = bits & ASTEROID_SIZE_MASK;
      o.streamed = (bits & ASTEROID_BALLISTIC) !== 0;
      if (bits & ASTEROID_ORBIT) {
        const orbit = o.orbit ?? (o.orbit = { planet: 0, radius: 0, phase: 0, epoch: 0, dir: 1, omega: 0 });
        orbit.planet = r.u8();
        orbit.radius = r.u16();
        orbit.phase = dqAngle(r.u16());
        orbit.epoch = r.u32();
        orbit.dir = bits & ASTEROID_RETROGRADE ? -1 : 1;
      } else {
        o.orbit = null;
        o.x = dqPos(r.u16());
        o.y = dqPos(r.u16());
        o.vx = dqVel(r.i16());
        o.vy = dqVel(r.i16());
      }
      break;
    }
    case EntityType.BULLET: {
      o.ownerId = r.u16();
      o.x = dqPos(r.u16());
      o.y = dqPos(r.u16());
      o.vx = dqVel(r.i16());
      o.vy = dqVel(r.i16());
      const bits = r.u8();
      o.kind = bits & BULLET_KIND_MASK;
      o.fresh = (bits & BULLET_FRESH) !== 0;
      o.own = (bits & BULLET_OWN) !== 0;
      o.life = r.u8();
      if (o.own) {
        o.fireSeq = r.u16();
        o.muzzle = r.u8();
      }
      break;
    }
    case EntityType.ALIEN:
      o.x = dqPos(r.u16());
      o.y = dqPos(r.u16());
      o.vx = dqVel(r.i16());
      o.vy = dqVel(r.i16());
      o.kind = r.u8();
      o.hpFrac = r.u8() / 255;
      break;
    case EntityType.PICKUP:
      o.x = dqPos(r.u16());
      o.y = dqPos(r.u16());
      o.kind = r.u8();
      break;
    default:
      throw new Error(`unknown entity type ${type}`);
  }
  return o;
}

function readSelf(r, o) {
  o.ackSeq = r.u32();
  o.id = r.u16();
  o.x = r.f64();
  o.y = r.f64();
  o.vx = r.f64();
  o.vy = r.f64();
  o.angle = r.f64();
  o.energy = r.u16();
  o.cooldown = r.u8();
  o.boostLock = r.u8();
  o.hp = r.u16();
  o.shield = r.u16();
  o.flags = r.u8();
  return o;
}

function readStats(r, o) {
  o.score = r.u32();
  o.kills = r.u16();
  o.level = r.u8();
  o.points = r.u8();
  o.statLevels = o.statLevels ?? new Uint8Array(STAT_COUNT);
  for (let i = 0; i < STAT_COUNT; i++) o.statLevels[i] = r.u8();
  o.weapon = r.u8();
  o.weaponChoice = r.u8() === 1;
  o.powerups = o.powerups ?? new Uint16Array(POWERUP_COUNT);
  for (let i = 0; i < POWERUP_COUNT; i++) o.powerups[i] = r.u16();
  o.spawnTick = r.u32();
  return o;
}

function readEvent(kind, r) {
  switch (kind) {
    case EventKind.SCORE:
      return { kind, amount: r.u16(), x: dqPos(r.u16()), y: dqPos(r.u16()) };
    case EventKind.HIT:
      return {
        kind,
        seq: r.u16(),
        muzzle: r.u8(),
        damage: r.u16(),
        x: dqPos(r.u16()),
        y: dqPos(r.u16()),
        killed: r.u8() === 1,
      };
    case EventKind.DAMAGE:
      return { kind, amount: r.u16(), angle: dqAngle(r.u16()) };
    default:
      throw new Error(`unknown event kind ${kind}`);
  }
}

/**
 * Decodes a snapshot (type byte already consumed) into callbacks on `sink`:
 *   begin(tick), self(s), stats(s), spectate(id, x, y), remove(id, reason, collectorId),
 *   entity(type, id, reader) -> must call readEntity(type, reader, target), event(ev), end()
 * `self` and `stats` objects are reused between calls.
 */
export function readSnapshot(r, sink, scratch = { self: {}, stats: {} }) {
  const tick = r.u32();
  const flags = r.u8();
  sink.begin(tick);
  if (flags & SnapFlag.SELF) sink.self(readSelf(r, scratch.self));
  if (flags & SnapFlag.STATS) sink.stats(readStats(r, scratch.stats));
  if (flags & SnapFlag.SPECTATE) sink.spectate(r.u16(), dqPos(r.u16()), dqPos(r.u16()));
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u16();
    const reason = r.u8();
    sink.remove(id, reason, reason === RemoveReason.COLLECTED ? r.u16() : NO_ID);
  }
  for (let n = r.u16(); n > 0; n--) {
    const type = r.u8();
    sink.entity(type, r.u16(), r);
  }
  for (let n = r.u8(); n > 0; n--) sink.event(readEvent(r.u8(), r));
  sink.end();
}
