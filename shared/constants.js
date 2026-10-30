/**
 * Values the server and the browser client must agree on. Anything that
 * affects the wire format or client-side prediction belongs here; server-only
 * tuning (spawn rates, rewards, AI) lives in server/game/tuning.js.
 */

export const PROTOCOL_VERSION = 2;

/* Timing ------------------------------------------------------------------ */

export const TICK_RATE = 60; // fixed simulation steps per second (server and prediction)
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
export const SNAPSHOT_INTERVAL = 2; // ticks between snapshots (30 Hz)

/* World ------------------------------------------------------------------- */

export const WORLD_SIZE = 6144; // square torus: leaving one edge enters the opposite one
export const VIEW_WIDTH = 1920; // world units visible at base zoom. Fixed so that a bigger
export const VIEW_HEIGHT = 1080; // monitor never grants extra vision.
export const VIEW_MARGIN = 260; // replication border beyond the visible area

export const NAME_MAX_LENGTH = 16;
export const MAX_SPEED = 1600; // hard velocity cap, a safety net for stacked impulses

/* Entities ---------------------------------------------------------------- */

export const EntityType = Object.freeze({ SHIP: 1, ASTEROID: 2, BULLET: 3, ALIEN: 4, PICKUP: 5 });

export const RemoveReason = Object.freeze({
  GONE: 0, // left the viewer's area of interest
  DESTROYED: 1,
  HIT: 2, // projectile impact
  COLLECTED: 3,
  EXPIRED: 4,
});

export const SHIP_RADIUS = 16;
export const SHIP_NOSE = 20; // muzzle distance from the ship's centre

export const ShipFlag = Object.freeze({
  THRUST: 1,
  BOOST: 2,
  INVULN: 4,
  SHIELD: 8,
  BRAKE: 16,
  RAPID: 32,
  OVERDRIVE: 64,
  STEALTH: 128, // hidden from bots and aliens (a development tool)
});

export const ASTEROID_RADIUS = [18, 36, 62]; // indexed by size class: small, medium, large

export const AlienKind = Object.freeze({ SAUCER: 0, HUNTER: 1, MOTHERSHIP: 2 });
export const ALIEN_RADIUS = [24, 15, 84];

export const BulletKind = Object.freeze({ PLAYER: 0, CANNON: 1, ALIEN: 2, MOTHERSHIP: 3 });

export const PickupKind = Object.freeze({
  ORB_SMALL: 0,
  ORB_MEDIUM: 1,
  ORB_LARGE: 2,
  SHIELD: 3,
  RAPID: 4,
  REPAIR: 5,
  OVERDRIVE: 6,
});
export const PICKUP_RADIUS = [5, 7, 10, 13, 13, 13, 13];
export const isPowerup = (kind) => kind >= PickupKind.SHIELD;

/** Timed power-up slots on a ship. */
export const Powerup = Object.freeze({ SHIELD: 0, RAPID: 1, OVERDRIVE: 2 });
export const POWERUP_COUNT = 3;
export const POWERUP_SECONDS = [20, 10, 10];

/* Input ------------------------------------------------------------------- */

export const Button = Object.freeze({
  THRUST: 1,
  LEFT: 2,
  RIGHT: 4,
  BRAKE: 8,
  FIRE: 16,
  BOOST: 32,
  AIM: 64, // turn towards the command's aim angle instead of using LEFT/RIGHT
});

/* Messages ---------------------------------------------------------------- */

export const KillCause = Object.freeze({ SHIP: 0, ASTEROID: 1, ALIEN: 2, MOTHERSHIP: 3, RAM: 4, PLANET: 5 });
export const Announce = Object.freeze({
  MOTHERSHIP_INBOUND: 1,
  MOTHERSHIP_DESTROYED: 2,
  MOTHERSHIP_ESCAPED: 3,
});
export const KickReason = Object.freeze({ SERVER_FULL: 1, OUTDATED: 2, SHUTDOWN: 3, IDLE: 4, ABUSE: 5 });
export const EventKind = Object.freeze({ SCORE: 1, HIT: 2, DAMAGE: 3 });
export const MarkerKind = Object.freeze({ LEADER: 1, MOTHERSHIP: 2 });
/** Optional server features, announced in the welcome message. */
export const Feature = Object.freeze({ DEV_TOOLS: 1 });
