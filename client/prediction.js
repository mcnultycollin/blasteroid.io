/**
 * Client-side prediction for the player's own ship.
 *
 * Every local tick produces a command that is applied immediately with the
 * shared stepShip() and sent to the server. When a snapshot arrives with the
 * authoritative state after command N, we rewind to it and replay commands
 * N+1..latest. With no outside interference (collisions, knockback) the
 * replay lands exactly where we already were; otherwise the difference is
 * smoothed out visually instead of snapping.
 *
 * Command time: the server runs command `seq` at world tick `seq +
 * timeOffset`, with the star and planets posed for that tick, and reports the
 * offset in every snapshot. Until the first report of a life arrives we use an
 * estimate; spawns are far from any gravity well, so it never matters.
 */
import { Powerup, WORLD_SIZE } from '../shared/constants.js';
import { poseBodies } from '../shared/gravity.js';
import { lerpAngle, wrap, wrapDelta, wrapLerp } from '../shared/math.js';
import { copyShipState, createShipState, stepShip } from '../shared/physics.js';
import { NO_ID } from '../shared/protocol.js';
import { STAT_COUNT, Weapon, deriveStats } from '../shared/stats.js';

const MAX_PENDING = 180; // 3 s of unacknowledged commands
const SNAP_DISTANCE = 160; // larger corrections teleport rather than glide
const SMOOTHING_MS = 90; // time constant for blending out corrections

export class Predictor {
  constructor() {
    this.active = false;
    this.shipId = NO_ID;
    this.state = createShipState();
    this.prev = createShipState();
    this.st = deriveStats(new Uint8Array(STAT_COUNT), Weapon.BLASTER, false, false);
    this.weapon = Weapon.BLASTER;
    this.seq = 0; // last command sequence generated (monotonic for the connection)
    this.lifeFirstSeq = 1; // first command of the current life
    this.pendingSeq = new Uint32Array(MAX_PENDING);
    this.pendingButtons = new Uint16Array(MAX_PENDING);
    this.pendingAim = new Float64Array(MAX_PENDING);
    this.pendingHead = 0;
    this.pendingCount = 0;
    this.errorX = 0; // visual offset still being blended out
    this.errorY = 0;
    this.timeOffset = 0; // command seq -> world tick (see above)
    this.timeKnown = false; // the server has reported the offset for this life
    this.lastButtons = 0;
    this.lastResult = 0;
    this.corrections = 0; // reconciliations that moved the ship (collisions, knockback, loss)
    this.lastCorrection = 0;
    this.bodies = []; // the star and planets, from the welcome message; posed per command
    this.posed = [];
  }

  /** The world tick command `seq` runs at. */
  commandTick(seq) {
    return seq + this.timeOffset;
  }

  /** Steps the ship with one command at its command time. */
  simulate(seq, buttons, aim) {
    const tick = seq + this.timeOffset;
    return stepShip(this.state, buttons, aim, this.st, poseBodies(this.bodies, tick, this.posed), tick);
  }

  setStats(stats) {
    deriveStats(
      stats.statLevels,
      stats.weapon,
      stats.powerups[Powerup.RAPID] > 0,
      stats.powerups[Powerup.OVERDRIVE] > 0,
      this.st,
    );
    this.weapon = stats.weapon;
  }

  /**
   * Starts predicting a freshly spawned ship from its first authoritative
   * state. `firstTick` estimates the world tick at which the server will run
   * our first command.
   */
  start(self, firstTick) {
    this.active = true;
    this.shipId = self.id;
    copyShipState(this.state, self);
    copyShipState(this.prev, self);
    this.pendingCount = 0;
    this.lifeFirstSeq = this.seq + 1;
    this.timeOffset = Math.round(firstTick) - this.lifeFirstSeq;
    this.timeKnown = false;
    this.errorX = 0;
    this.errorY = 0;
  }

  stop() {
    this.active = false;
    this.shipId = NO_ID;
    this.pendingCount = 0;
  }

  /** Applies one local command; returns stepShip's result bits. */
  step(buttons, aim) {
    const seq = ++this.seq;
    if (this.pendingCount === MAX_PENDING) {
      this.pendingHead = (this.pendingHead + 1) % MAX_PENDING;
      this.pendingCount--;
    }
    const i = (this.pendingHead + this.pendingCount) % MAX_PENDING;
    this.pendingSeq[i] = seq;
    this.pendingButtons[i] = buttons;
    this.pendingAim[i] = aim;
    this.pendingCount++;
    copyShipState(this.prev, this.state);
    this.lastButtons = buttons;
    this.lastResult = this.simulate(seq, buttons, aim);
    return this.lastResult;
  }

  /** Rewinds to the server's state after `self.ackSeq` and replays newer commands. */
  reconcile(self) {
    while (this.pendingCount > 0 && this.pendingSeq[this.pendingHead] <= self.ackSeq) {
      this.pendingHead = (this.pendingHead + 1) % MAX_PENDING;
      this.pendingCount--;
    }
    if (self.ackSeq >= this.lifeFirstSeq) {
      // The server has run commands from this life: its offset is authoritative.
      this.timeOffset = self.timeOffset;
      this.timeKnown = true;
    }
    const oldX = this.state.x;
    const oldY = this.state.y;
    copyShipState(this.state, self);
    copyShipState(this.prev, self);
    for (let k = 0; k < this.pendingCount; k++) {
      const i = (this.pendingHead + k) % MAX_PENDING;
      if (k === this.pendingCount - 1) copyShipState(this.prev, this.state);
      this.simulate(this.pendingSeq[i], this.pendingButtons[i], this.pendingAim[i]);
    }
    const dx = wrapDelta(oldX - this.state.x, WORLD_SIZE);
    const dy = wrapDelta(oldY - this.state.y, WORLD_SIZE);
    const error = Math.abs(dx) + Math.abs(dy);
    if (error > 0.01) {
      this.corrections++;
      this.lastCorrection = error;
    }
    if (error > SNAP_DISTANCE) {
      this.errorX = 0;
      this.errorY = 0;
    } else {
      this.errorX += dx;
      this.errorY += dy;
    }
  }

  decayError(dtMs) {
    const k = Math.exp(-dtMs / SMOOTHING_MS);
    this.errorX *= k;
    this.errorY *= k;
  }

  /** Render position between the last two predicted ticks (alpha in [0, 1)), plus smoothing. */
  renderX(alpha) {
    return wrap(wrapLerp(this.prev.x, this.state.x, alpha, WORLD_SIZE) + this.errorX, WORLD_SIZE);
  }

  renderY(alpha) {
    return wrap(wrapLerp(this.prev.y, this.state.y, alpha, WORLD_SIZE) + this.errorY, WORLD_SIZE);
  }

  renderAngle(alpha) {
    return lerpAngle(this.prev.angle, this.state.angle, alpha);
  }
}
