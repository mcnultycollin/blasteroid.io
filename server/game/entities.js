/**
 * Entity classes. Every field is initialised in the constructor so each class
 * keeps a single stable shape, which keeps V8's property access monomorphic
 * in the hot loops. Field names match what shared/protocol.js encodes.
 */
import {
  ALIEN_RADIUS,
  ASTEROID_RADIUS,
  EntityType,
  PICKUP_RADIUS,
  POWERUP_COUNT,
  RemoveReason,
  SHIP_RADIUS,
} from '../../shared/constants.js';
import { NO_ID } from '../../shared/protocol.js';
import { STAT_COUNT, Weapon, deriveStats } from '../../shared/stats.js';
import { ALIENS, ASTEROID } from './tuning.js';

const bit = (type) => 1 << (type - 1);

/** Bitmasks for grid queries, one bit per EntityType. */
export const Mask = Object.freeze({
  SHIP: bit(EntityType.SHIP),
  ASTEROID: bit(EntityType.ASTEROID),
  BULLET: bit(EntityType.BULLET),
  ALIEN: bit(EntityType.ALIEN),
  PICKUP: bit(EntityType.PICKUP),
  ALL: 0x1f,
});

class Entity {
  constructor(type, radius) {
    this.id = 0;
    this.type = type;
    this.mask = bit(type);
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.radius = radius;
    this.dead = false;
    this.removeReason = RemoveReason.GONE;
    this.collectorId = NO_ID;
    this.version = 0; // bumped when predictable motion changes and must be re-sent
    this.streamed = false; // replicate every snapshot even if the version is unchanged
    this._q = 0; // spatial-grid query stamp
  }
}

export class Ship extends Entity {
  constructor(player) {
    super(EntityType.SHIP, SHIP_RADIUS);
    this.player = player;
    this.playerId = player.id;
    // Prediction state (see shared/physics.js)
    this.angle = 0;
    this.energy = 0;
    this.cooldown = 0;
    this.boostLock = 0;
    this.impact = 0; // planet impact speed from the last physics step
    // Combat
    this.hp = 0;
    this.maxHp = 0;
    this.shield = 0;
    this.invuln = 0;
    this.contactCooldown = 0;
    this.lastDamageTick = -Infinity;
    this.lastAttacker = null;
    this.lastAttackTick = -Infinity;
    // Progression for this life
    this.score = 0;
    this.kills = 0;
    this.level = 1;
    this.points = 0;
    this.statLevels = new Uint8Array(STAT_COUNT);
    this.weapon = Weapon.BLASTER;
    this.weaponChoice = false;
    this.powerups = new Uint16Array(POWERUP_COUNT);
    this.st = deriveStats(this.statLevels, this.weapon, false, false);
    this.statsVersion = 0; // bumped whenever anything in the STATS block changes
    this.rank = 0; // leaderboard position, refreshed once per second
    // Presentation and bookkeeping
    this.flags = 0;
    this.thrusting = false;
    this.boosting = false;
    this.braking = false;
    this.spawnTick = 0;
    this.lastActiveTick = 0;
    this.lastButtons = 0;
    this.lastAim = 0;
  }
}

export class Asteroid extends Entity {
  constructor(size) {
    super(EntityType.ASTEROID, ASTEROID_RADIUS[size]);
    this.size = size;
    this.hp = ASTEROID.hp[size];
    this.orbit = null; // circular orbit around a planet (see shared/gravity.js), or null when free
  }
}

export class Bullet extends Entity {
  constructor(owner, kind, damage, radius, life) {
    super(EntityType.BULLET, radius);
    this.owner = owner; // Ship or Alien; may die before the bullet does
    this.ownerId = owner.id;
    this.kind = kind;
    this.damage = damage;
    this.life = life; // ticks remaining
    this.hitMask = 0;
    this.fireSeq = 0; // input sequence that fired it, for client-side matching
    this.muzzle = 0;
    this.spawnTick = 0;
  }
}

export class Alien extends Entity {
  constructor(kind) {
    super(EntityType.ALIEN, ALIEN_RADIUS[kind]);
    this.kind = kind;
    this.def = ALIENS[kind];
    this.hp = this.def.hp;
    this.maxHp = this.def.hp;
    this.target = null;
    this.thinkCooldown = 0;
    this.fireCooldown = 0;
    this.burstCooldown = 0;
    this.spawnCooldown = 0;
    this.wander = 0;
    this.avoidX = 0;
    this.avoidY = 0;
    this.parent = null; // mothership that launched this alien
    this.children = 0;
    this.lifeLeft = 0; // motherships eventually leave
    this.contactCooldown = 0;
  }
}

export class Pickup extends Entity {
  constructor(kind, value, expireTick) {
    super(EntityType.PICKUP, PICKUP_RADIUS[kind]);
    this.kind = kind;
    this.value = value; // score for orbs
    this.expireTick = expireTick;
  }
}
