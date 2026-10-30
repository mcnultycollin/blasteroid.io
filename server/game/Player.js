/**
 * A participant in a game, human or bot. Outlives individual ships: a player
 * dies and respawns many times. Knows nothing about networking.
 */

/** Ring buffer of input commands, stored in typed arrays to avoid per-command allocation. */
export class CommandQueue {
  constructor(capacity) {
    this.capacity = capacity;
    this.seqs = new Uint32Array(capacity);
    this.buttons = new Uint8Array(capacity);
    this.aims = new Float64Array(capacity);
    this.head = 0;
    this.size = 0;
  }

  /** Appends a command, dropping the oldest one when full. */
  push(seq, buttons, aim) {
    if (this.size === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.size--;
    }
    const i = (this.head + this.size) % this.capacity;
    this.seqs[i] = seq;
    this.buttons[i] = buttons;
    this.aims[i] = aim;
    this.size++;
  }

  /** Index of the oldest command; read its fields, then call drop(). */
  get first() {
    return this.head;
  }

  drop() {
    this.head = (this.head + 1) % this.capacity;
    this.size--;
  }

  clear() {
    this.size = 0;
  }
}

export class Player {
  constructor(id, name, isBot, queueCapacity) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.ship = null;
    this.inputs = new CommandQueue(queueCapacity);
    this.credits = 0; // commands the ship may still process; refilled one per tick
    this.lastInputSeq = 0;
    this.ackSeq = 0; // last command applied to the ship
    this.wantsSpawn = false;
    this.respawnTick = 0;
    this.deathTick = -1;
    this.killer = null; // ship or alien to spectate after dying
    this.deathX = 0;
    this.deathY = 0;
    this.idle = false; // despawned for inactivity
    this.events = []; // per-player feedback events, drained with each snapshot
    this.wantsEvents = !isBot;
    this.brain = null; // BotBrain for bots
    this.retiring = false; // surplus bot waiting to leave unnoticed
    this.removed = false;
  }
}
