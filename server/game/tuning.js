/**
 * Server-only gameplay tuning. Durations are in ticks (use `seconds()`),
 * distances in world units, speeds in units per second.
 */
import { BLAST_HALF_ANGLE, BLAST_RANGE, TICK_RATE } from '../../shared/constants.js';
import { GRAVITY } from '../../shared/gravity.js';

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
  // Command time (see processShipInputs): re-anchored at once when it drifts
  // further than timeSlack ticks from world time, or when it stays more than
  // timeSoftSlack ticks off for timeDriftLimit commands in a row.
  timeSlack: 12,
  timeSoftSlack: 3,
  timeDriftLimit: seconds(1),
});

export const ASTEROID = Object.freeze({
  hp: [10, 24, 48],
  score: [12, 8, 5], // smaller rocks are harder to hit
  contactDamage: [8, 15, 26],
  mass: [2, 6, 16],
  speed: [[60, 140], [40, 95], [20, 55]], // [min, max] by size
  maxSpeed: 360, // rammed or blasted rocks are capped here
  massUnits: [1, 2, 4], // contribution towards the population target
  targetMass: 640,
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
  base: 3,
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

/** The solar system: a fixed star orbited by one planet of each type. */
export const PLANETS = Object.freeze({
  star: { radius: 200, density: 0.64 },
  // [min, max] radius and density per planet type. Mass ∝ density × radius³.
  types: {
    core: { radius: [70, 92], density: [2.8, 3.4] }, // small, but pulls hardest (may out-pull base thrust)
    rock: { radius: [120, 160], density: [0.9, 1.3] },
    gas: { radius: [200, 235], density: [0.4, 0.58] }, // huge and light, gentle pull
  },
  wellGap: 90, // clear space between neighbouring gravity wells
  // Orbital periods around the star. The rocky world and the gas giant share
  // the outer orbit on opposite sides, so their wells never meet.
  innerPeriod: seconds(150),
  outerPeriod: seconds(260),
  orbitClearance: 45, // gap between a planet's surface and its innermost belt orbit
  orbitReach: 0.8, // outermost belt orbit, as a fraction of the gravity range
  beltMassPerRange: 1 / 28, // orbiting rock mass kept around a planet, per unit of range
  crashSafeSpeed: GRAVITY.crashSpeed, // touching down slower than this is a landing
  crashDamage: 0.22, // hull damage per unit of impact speed above the safe speed
  starBurn: 18, // hull damage per burn while touching the star...
  burnInterval: seconds(0.1), // ...one burn every this many ticks
});

/** The kinetic blast (P): a cone of force in front of the ship. */
export const BLAST = Object.freeze({
  range: BLAST_RANGE, // measured to the target's surface
  halfAngle: BLAST_HALF_ANGLE, // radians either side of the nose
  impulse: 520, // velocity change (units/s) at point blank...
  edgeShare: 0.3, // ...falling linearly to this share of it at the edge of the range
  rockShare: [1, 0.75, 0.5], // by asteroid size: big rocks are harder to shove
  shipShare: 0.7, // other ships are heavier than rocks
  alienShare: 0.5,
  creditWindow: seconds(4), // a shoved rock that hits a ship this soon credits the shover
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
  // Skill mix: most bots are beatable rookies, a few aces play at full strength.
  // Skill 0.5 and above plays exactly as before; below it, aim, leading,
  // reactions, aggression and trigger discipline all get worse.
  skillTiers: [
    { share: 0.65, skill: [0.05, 0.35] }, // rookie
    { share: 0.25, skill: [0.35, 0.65] }, // regular
    { share: 0.1, skill: [0.65, 0.9] }, // ace
  ],
  thinkInterval: 6,
  respawnDelay: [seconds(2), seconds(6)],
  manageEvery: seconds(1),
  retireUnseenDistance: 1400, // a retiring bot vanishes only when no ship is this close
});
