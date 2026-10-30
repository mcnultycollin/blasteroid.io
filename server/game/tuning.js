/**
 * Server-only gameplay tuning. Durations are in ticks (use `seconds()`),
 * distances in world units, speeds in units per second.
 */
import { TICK_RATE } from '../../shared/constants.js';

export const seconds = (s) => Math.round(s * TICK_RATE);

export const GRID_CELL = 128; // spatial grid cell size; WORLD_SIZE must be a multiple

export const SHIP = Object.freeze({
  spawnInvuln: seconds(3), // ends early when the ship fires
  respawnDelay: seconds(1.2),
  regenDelay: seconds(4), // no regeneration until this long after taking damage
  idleDespawn: seconds(60),
  mass: 1,
  ramDamage: 12, // dealt to what the ship rams, scaled by impact speed
  shipRamDamage: 6, // ship-on-ship contact, each way
  contactCooldown: seconds(0.3),
  hitKnockback: 2.5, // velocity gained per point of projectile damage
  maxCredits: 16, // queued input commands a ship may bank (jitter buffer, speed-hack cap)
});

export const ASTEROID = Object.freeze({
  hp: [10, 24, 48],
  score: [12, 8, 5], // smaller rocks are harder to hit
  contactDamage: [8, 15, 26],
  mass: [2, 6, 16],
  speed: [[60, 140], [40, 95], [20, 55]], // [min, max] by size
  maxSpeed: 220,
  massUnits: [1, 2, 4], // contribution towards the population target
  targetMass: 360,
  massPerShip: 4, // busier rooms get a denser field
  maxSpawnsPerCheck: 3,
  spawnEvery: seconds(0.5),
  minSpawnDistance: 1300, // never pop into existence on someone's screen
  powerupChance: 0.04, // large asteroids only
});

/** Indexed by AlienKind. */
export const ALIENS = Object.freeze([
  {
    // Saucer: big, sloppy aim, wanders into fights
    hp: 60, speed: 150, agility: 2.2, aggroRange: 900, preferredRange: 420, fireRange: 760,
    fireInterval: seconds(1.1), spread: 0.45, lead: 0, bulletSpeed: 520, bulletLife: seconds(1.6),
    bulletDamage: 9, score: 100, contactDamage: 20, dropChance: 0.5,
  },
  {
    // Hunter: small, fast, leads its shots, prefers high scorers
    hp: 34, speed: 260, agility: 3.2, aggroRange: 1150, preferredRange: 320, fireRange: 700,
    fireInterval: seconds(0.85), spread: 0.08, lead: 1, bulletSpeed: 640, bulletLife: seconds(1.3),
    bulletDamage: 8, score: 250, contactDamage: 18, dropChance: 1,
  },
  {
    // Mothership: rare world event, radial bursts and hunter escorts
    hp: 2400, speed: 55, agility: 0.6, aggroRange: 1250, preferredRange: 520, fireRange: 1000,
    fireInterval: seconds(1.2), spread: 0.12, lead: 0.6, bulletSpeed: 480, bulletLife: seconds(2.2),
    bulletDamage: 12, score: 2000, contactDamage: 40, dropChance: 1,
    burstInterval: seconds(3.2), burstCount: 18, spawnInterval: seconds(12), maxChildren: 3,
    lifetime: seconds(180), powerups: 4, orbValue: 2400,
  },
]);

export const ALIEN_SPAWN = Object.freeze({
  base: 2,
  shipsPerAlien: 4,
  max: 10,
  every: seconds(6),
  minDistance: 1400,
  hunterChance: 0.35,
  thinkInterval: 15,
});

export const MOTHERSHIP = Object.freeze({
  firstDelay: seconds(150),
  interval: seconds(300),
  minShips: 4,
});

export const PICKUP = Object.freeze({
  orbLife: seconds(45),
  powerupLife: seconds(60),
  worldPowerupsBase: 4,
  shipsPerWorldPowerup: 5,
  spawnEvery: seconds(4),
  reach: 10, // pickups are collected slightly before visual contact
});

export const POWERUP = Object.freeze({
  shieldHp: 80,
  repairFraction: 0.5,
});

export const REWARD = Object.freeze({
  killBase: 100,
  killShare: 0.3, // of the victim's score, paid to the killer
  dropShare: 0.3, // of the victim's score, scattered as orbs
  orbValue: 40, // target value per orb
  maxOrbs: 16,
  survivalPerSecond: 1,
  activeWindow: seconds(10), // survival score only accrues while the player is active
  assistWindow: seconds(6), // credit a recent attacker when an asteroid finishes the job
});

export const BOT = Object.freeze({
  thinkInterval: 6,
  respawnDelay: [seconds(2), seconds(6)],
  manageEvery: seconds(1),
  retireUnseenDistance: 1400, // a retiring bot vanishes only when no ship is this close
});
