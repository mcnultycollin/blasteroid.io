/**
 * Owns every room and the fixed-rate loop that ticks them. New connections
 * join the fullest room that still has space, so players find each other;
 * a new room opens when all are full. Empty rooms pause, and extra empty
 * rooms are closed after a while.
 */
import { KickReason, TICK_MS } from '../../shared/constants.js';
import { log } from '../log.js';
import { Room } from './Room.js';
import { Session } from './Session.js';

const MAX_CATCH_UP_TICKS = 4;
const MAX_STRIKES = 20;
const SESSION_TIMEOUT_MS = 20_000; // clients ping every 2 s
const EMPTY_ROOM_TTL_MS = 60_000;

export class RoomManager {
  constructor(options) {
    this.options = options;
    this.rooms = [];
    this.nextRoomId = 1;
    this.timer = null;
    this.lastHousekeeping = 0;
    this.lateTicks = 0;
  }

  connect(ws, ip) {
    const session = new Session(ws, ip);
    this.pickRoom().attach(session);
    ws.on('message', (data, isBinary) => this.onMessage(session, data, isBinary));
    ws.on('close', () => this.onClose(session));
    ws.on('error', (err) => log.debug(`socket error from ${ip}: ${err.message}`));
    return session;
  }

  onMessage(session, data, isBinary) {
    if (session.closed) return;
    const now = Date.now();
    session.lastMessageAt = now;
    if (!isBinary || !session.allowMessage(now)) {
      session.kick(KickReason.ABUSE);
      return;
    }
    try {
      session.room.handleMessage(session, data);
    } catch (err) {
      log.debug(`bad message from ${session.ip}: ${err.message}`);
      if (++session.strikes > MAX_STRIKES) session.kick(KickReason.ABUSE);
    }
  }

  onClose(session) {
    session.closed = true;
    session.room?.detach(session);
  }

  pickRoom() {
    let best = null;
    for (const room of this.rooms) {
      if (room.size < this.options.maxPlayers && (!best || room.size > best.size)) best = room;
    }
    if (!best) {
      best = new Room(this.nextRoomId++, this.options);
      this.rooms.push(best);
      log.info(`opened room ${best.id}`);
    }
    return best;
  }

  /** Starts the fixed-timestep loop. Catches up after short stalls, drops time after long ones. */
  start() {
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      let steps = 0;
      while (now >= next && steps < MAX_CATCH_UP_TICKS) {
        this.tickAll();
        next += TICK_MS;
        steps++;
      }
      if (now - next > 250) {
        this.lateTicks += Math.floor((now - next) / TICK_MS);
        next = now;
      }
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  tickAll() {
    for (const room of this.rooms) if (room.size > 0) room.tick();
    const now = Date.now();
    if (now - this.lastHousekeeping >= 1000) {
      this.lastHousekeeping = now;
      this.housekeeping(now);
    }
  }

  housekeeping(now) {
    for (const room of this.rooms) {
      for (const session of room.sessions) {
        if (now - session.lastMessageAt > SESSION_TIMEOUT_MS) session.terminate();
      }
    }
    // Keep the first room warm; close other rooms that have been empty for a while.
    this.rooms = this.rooms.filter((room, i) => {
      const keep = i === 0 || room.size > 0 || now - room.emptySince < EMPTY_ROOM_TTL_MS;
      if (!keep) log.info(`closed room ${room.id}`);
      return keep;
    });
  }

  shutdown() {
    this.stop();
    for (const room of this.rooms) for (const session of room.sessions) session.kick(KickReason.SHUTDOWN);
  }

  stats() {
    return {
      rooms: this.rooms.map((room) => ({
        id: room.id,
        sessions: room.size,
        humans: room.game.humanCount,
        ships: room.game.ships.length,
        entities: room.game.lists.reduce((n, list) => n + list.length, 0),
        tick: room.game.tick,
        tickMsAvg: Number(room.perf.avgMs.toFixed(3)),
        tickMsMax: Number(room.perf.maxMs.toFixed(3)),
      })),
      lateTicks: this.lateTicks,
    };
  }
}
