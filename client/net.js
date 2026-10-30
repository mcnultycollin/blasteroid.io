/** WebSocket connection: binary encode/decode, ping, automatic reconnect. */
import { KickReason } from '../shared/constants.js';
import {
  BinaryReader,
  BinaryWriter,
  ServerMsg,
  encodeInput,
  encodeJoin,
  encodePing,
  encodeStealth,
  encodeUpgrade,
  encodeWeapon,
  readAnnounce,
  readDeath,
  readKill,
  readLeaderboard,
  readPong,
  readRoster,
  readWelcome,
} from '../shared/protocol.js';

const PING_INTERVAL_MS = 2000;
const MAX_RETRY_DELAY_MS = 8000;

/**
 * `handlers` receives: open(), close(), welcome(w), joined(playerId),
 * snapshot(reader), roster(list), rosterRemove(id), leaderboard(lb), kill(k),
 * death(d), announce(a), kick(reason).
 */
export class Connection {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.writer = new BinaryWriter(64);
    this.rtt = 0; // smoothed round-trip time, ms
    this.attempts = 0;
    this.pingTimer = 0;
    this.retryTimer = 0;
    this.stopped = false; // kicked for a reason that retrying will not fix
    this.bytesIn = 0;
  }

  get isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    clearTimeout(this.retryTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.attempts = 0;
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.handlers.open();
    };
    ws.onmessage = (event) => this.receive(event.data);
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.close();
      if (!this.stopped) {
        const delay = Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** this.attempts++);
        this.retryTimer = setTimeout(() => this.connect(), delay);
      }
    };
    this.ws = ws;
  }

  send(bytes) {
    if (this.isOpen) this.ws.send(bytes);
  }

  join(name) {
    this.send(encodeJoin(this.writer, name));
  }

  sendInput(seq, buttons, aimQ) {
    this.send(encodeInput(this.writer, seq, buttons, aimQ));
  }

  upgrade(stat) {
    this.send(encodeUpgrade(this.writer, stat));
  }

  chooseWeapon(weapon) {
    this.send(encodeWeapon(this.writer, weapon));
  }

  toggleStealth() {
    this.send(encodeStealth(this.writer));
  }

  ping() {
    this.send(encodePing(this.writer, Math.floor(performance.now()) >>> 0));
  }

  receive(data) {
    this.bytesIn += data.byteLength;
    const r = new BinaryReader(data);
    const h = this.handlers;
    switch (r.u8()) {
      case ServerMsg.SNAPSHOT:
        h.snapshot(r);
        break;
      case ServerMsg.WELCOME:
        h.welcome(readWelcome(r));
        break;
      case ServerMsg.JOINED:
        h.joined(r.u16());
        break;
      case ServerMsg.ROSTER:
        h.roster(readRoster(r));
        break;
      case ServerMsg.ROSTER_REMOVE:
        h.rosterRemove(r.u16());
        break;
      case ServerMsg.LEADERBOARD:
        h.leaderboard(readLeaderboard(r));
        break;
      case ServerMsg.KILL:
        h.kill(readKill(r));
        break;
      case ServerMsg.DEATH:
        h.death(readDeath(r));
        break;
      case ServerMsg.PONG: {
        const sample = ((Math.floor(performance.now()) >>> 0) - readPong(r).time) >>> 0;
        if (sample < 10000) this.rtt = this.rtt ? this.rtt + (sample - this.rtt) * 0.25 : sample;
        break;
      }
      case ServerMsg.ANNOUNCE:
        h.announce(readAnnounce(r));
        break;
      case ServerMsg.KICK: {
        const reason = r.u8();
        this.stopped = reason !== KickReason.SHUTDOWN; // a server restart is worth retrying
        h.kick(reason);
        break;
      }
      default:
        break; // unknown message from a newer server; ignore
    }
  }
}
