/**
 * Network glue around one Game: decodes client messages, broadcasts the
 * game's outbox and sends each session its snapshot.
 */
import { KickReason, MarkerKind, PROTOCOL_VERSION, SNAPSHOT_INTERVAL, TICK_RATE } from '../../shared/constants.js';
import {
  BinaryReader,
  BinaryWriter,
  ClientMsg,
  SnapshotWriter,
  dqAngle,
  encodeAnnounce,
  encodeDeath,
  encodeJoined,
  encodeKill,
  encodeLeaderboard,
  encodePong,
  encodeRoster,
  encodeRosterRemove,
  encodeWelcome,
} from '../../shared/protocol.js';
import { Game } from '../game/Game.js';
import { sanitizeName } from '../game/names.js';
import { buildSnapshot } from './replication.js';

const LEADERBOARD_SIZE = 10;
const MAX_COMMANDS_PER_MESSAGE = 8;
const CONGESTION_LIMIT_MS = 10_000;

export class Room {
  constructor(id, options) {
    this.id = id;
    this.options = options;
    this.game = new Game({ seed: options.seed, botTarget: options.botTarget });
    this.sessions = new Set();
    this.sessionsByPlayer = new Map(); // player id -> Session
    this.writer = new BinaryWriter(64 * 1024);
    this.snapshots = new SnapshotWriter(this.writer);
    this.leader = null;
    this.emptySince = Date.now();
    this.perf = { avgMs: 0, maxMs: 0 };
  }

  get size() {
    return this.sessions.size;
  }

  attach(session) {
    this.sessions.add(session);
    session.room = this;
    session.send(encodeWelcome(this.writer, this.game.tick, this.id));
    const players = [...this.game.players.values()];
    for (let i = 0; i < players.length; i += 255) {
      session.send(encodeRoster(this.writer, players.slice(i, i + 255)));
    }
  }

  detach(session) {
    if (!this.sessions.delete(session)) return;
    if (session.player) {
      this.sessionsByPlayer.delete(session.player.id);
      this.game.removePlayer(session.player);
      session.player = null;
    }
    if (this.sessions.size === 0) this.emptySince = Date.now();
  }

  /** Throws on malformed input; the caller counts strikes. */
  handleMessage(session, data) {
    const r = new BinaryReader(data);
    const type = r.u8();
    const game = this.game;
    const player = session.player;
    switch (type) {
      case ClientMsg.INPUT: {
        const first = r.u32();
        const count = r.u8();
        if (count > MAX_COMMANDS_PER_MESSAGE) throw new RangeError('too many commands');
        for (let i = 0; i < count; i++) {
          const buttons = r.u8() & 0x7f;
          const aim = dqAngle(r.u16());
          if (player) game.queueInput(player, first + i, buttons, aim);
        }
        break;
      }
      case ClientMsg.JOIN:
        this.join(session, r.u8(), sanitizeName(r.str()));
        break;
      case ClientMsg.UPGRADE:
        if (player) game.upgrade(player, r.u8());
        break;
      case ClientMsg.WEAPON:
        if (player) game.chooseWeapon(player, r.u8());
        break;
      case ClientMsg.PING:
        session.send(encodePong(this.writer, r.u32(), game.tick));
        break;
      default:
        throw new RangeError(`unknown message type ${type}`);
    }
  }

  join(session, version, name) {
    if (version !== PROTOCOL_VERSION) {
      session.kick(KickReason.OUTDATED);
      return;
    }
    const game = this.game;
    let player = session.player;
    if (!player) {
      player = game.humanCount < this.options.maxPlayers ? game.addPlayer(name, false) : null;
      if (!player) {
        session.kick(KickReason.SERVER_FULL);
        return;
      }
      session.player = player;
      this.sessionsByPlayer.set(player.id, session);
      session.send(encodeJoined(this.writer, player.id));
    } else if (player.ship) {
      return; // already flying; ignoring repeats also stops rename spam
    } else {
      game.renamePlayer(player, name);
    }
    game.requestSpawn(player);
  }

  tick() {
    const start = performance.now();
    const game = this.game;
    game.step();
    this.flushOutbox();
    if (game.tick % SNAPSHOT_INTERVAL === 0) this.sendSnapshots();
    if (game.tick % TICK_RATE === 0) this.sendLeaderboard();
    const ms = performance.now() - start;
    this.perf.avgMs += (ms - this.perf.avgMs) * 0.01;
    this.perf.maxMs = Math.max(ms, this.perf.maxMs * 0.999);
  }

  broadcast(bytes) {
    for (const session of this.sessions) session.send(bytes);
  }

  flushOutbox() {
    const out = this.game.outbox;
    const w = this.writer;
    for (let i = 0; i < out.roster.length; i += 255) this.broadcast(encodeRoster(w, out.roster.slice(i, i + 255)));
    for (const k of out.kills) this.broadcast(encodeKill(w, k.killerId, k.victimId, k.cause));
    for (const d of out.deaths) this.sessionsByPlayer.get(d.player.id)?.send(encodeDeath(w, d));
    for (const a of out.announcements) this.broadcast(encodeAnnounce(w, a.code, a.playerId));
    // Removals last, so clients can still name players in this tick's kill feed.
    for (const id of out.rosterRemoved) this.broadcast(encodeRosterRemove(w, id));
    this.game.clearOutbox();
  }

  sendSnapshots() {
    const now = Date.now();
    for (const session of this.sessions) {
      if (session.canSend(now)) {
        session.send(buildSnapshot(this.game, session, this.snapshots, this.leader));
      } else if (session.congestedSince && now - session.congestedSince > CONGESTION_LIMIT_MS) {
        session.terminate(); // hopelessly behind; the close handler cleans up
      }
    }
  }

  sendLeaderboard() {
    const game = this.game;
    const ranked = game.rankedShips();
    this.leader = ranked[0] ?? null;
    for (let i = 0; i < ranked.length; i++) ranked[i].rank = i + 1;
    const top = ranked.slice(0, LEADERBOARD_SIZE).map((s) => ({ playerId: s.playerId, score: s.score }));
    const markers = [];
    if (this.leader) markers.push({ kind: MarkerKind.LEADER, x: this.leader.x, y: this.leader.y });
    if (game.mothership) markers.push({ kind: MarkerKind.MOTHERSHIP, x: game.mothership.x, y: game.mothership.y });
    for (const session of this.sessions) {
      const ship = session.player?.ship;
      const rank = ship && !ship.dead ? ship.rank : 0;
      session.send(encodeLeaderboard(this.writer, game.players.size, rank, top, markers));
    }
  }
}
