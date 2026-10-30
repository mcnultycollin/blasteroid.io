/** One WebSocket connection and its per-client replication state. */
import { WORLD_SIZE } from '../../shared/constants.js';
import { BinaryWriter, encodeKick } from '../../shared/protocol.js';

const MAX_BUFFERED_BYTES = 128 * 1024; // beyond this, skip snapshots until the socket drains
const MAX_MESSAGES_PER_SECOND = 180; // inputs arrive at 60 Hz; leave room for bursts
const scratch = new BinaryWriter(16);

export class Session {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.room = null;
    this.player = null;
    this.known = new Map(); // entity object -> version last replicated
    this.statsShip = null;
    this.statsVersion = -1;
    this.spectating = null;
    this.camX = WORLD_SIZE / 2;
    this.camY = WORLD_SIZE / 2;
    this.lastMessageAt = Date.now();
    this.windowStart = 0;
    this.windowCount = 0;
    this.strikes = 0; // malformed messages
    this.congestedSince = 0;
    this.closed = false;
  }

  get open() {
    return !this.closed && this.ws.readyState === 1;
  }

  /**
   * True when a snapshot can be sent now. Snapshots are skipped while the
   * socket is backed up; replication state only advances on actual sends, so
   * skipping one never desynchronises the client.
   */
  canSend(now) {
    if (!this.open) return false;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (!this.congestedSince) this.congestedSince = now;
      return false;
    }
    this.congestedSince = 0;
    return true;
  }

  send(bytes) {
    if (this.open) this.ws.send(bytes);
  }

  /** Sliding one-second message budget. Returns false when exceeded. */
  allowMessage(now) {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    return ++this.windowCount <= MAX_MESSAGES_PER_SECOND;
  }

  /** Tells the client why, then closes the connection. */
  kick(reason) {
    if (this.closed) return;
    this.send(encodeKick(scratch, reason));
    this.closed = true;
    this.ws.close(4000 + reason);
  }

  terminate() {
    this.closed = true;
    this.ws.terminate();
  }
}
