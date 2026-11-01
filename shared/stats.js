/**
 * Ship progression: levels, upgradeable stats and weapons. Shared so the
 * client can predict its own ship with exactly the numbers the server uses
 * and display upgrade information without extra traffic.
 */
import { Perk, TICK_RATE } from './constants.js';
import { clamp } from './math.js';

const seconds = (s) => Math.round(s * TICK_RATE);

export const Stat = Object.freeze({
  HULL: 0,
  REPAIR: 1,
  ENGINE: 2,
  HANDLING: 3,
  DAMAGE: 4,
  VELOCITY: 5,
  RELOAD: 6,
  ENERGY: 7,
});
export const STAT_COUNT = 8;
export const STAT_MAX = 7; // upgrade levels per stat

export const STAT_INFO = Object.freeze([
  { name: 'Hull', desc: 'Maximum hull integrity' },
  { name: 'Repair', desc: 'Hull regeneration' },
  { name: 'Engines', desc: 'Thrust and top speed' },
  { name: 'Handling', desc: 'Turn rate' },
  { name: 'Damage', desc: 'Projectile damage' },
  { name: 'Velocity', desc: 'Projectile speed and range' },
  { name: 'Reload', desc: 'Fire rate' },
  { name: 'Energy', desc: 'Boost capacity and recharge' },
]);

/* Levels ------------------------------------------------------------------ */

export const MAX_LEVEL = 40; // one upgrade point per level, so 39 points for 56 slots

const LEVEL_SCORE = [0, 0];
for (let level = 2; level <= MAX_LEVEL; level++) {
  LEVEL_SCORE.push(50 * (level - 1) ** 2);
}

/** Total score needed to reach `level`. */
export function scoreForLevel(level) {
  return LEVEL_SCORE[clamp(level, 1, MAX_LEVEL)];
}

export function levelForScore(score) {
  let level = 1;
  while (level < MAX_LEVEL && score >= LEVEL_SCORE[level + 1]) level++;
  return level;
}

/** Veterans see a little further: up to +20% view at max level. */
export function viewScaleForLevel(level) {
  return 1 + (0.2 * (clamp(level, 1, MAX_LEVEL) - 1)) / (MAX_LEVEL - 1);
}

/* Weapons ----------------------------------------------------------------- */

export const Weapon = Object.freeze({ BLASTER: 0, TWIN: 1, SCATTER: 2, CANNON: 3 });
export const WEAPON_UNLOCK_LEVEL = 10;
export const WEAPON_CHOICES = Object.freeze([Weapon.TWIN, Weapon.SCATTER, Weapon.CANNON]);

/**
 * Multipliers over the ship's base projectile stats. `muzzles` lists
 * [angle offset (rad), lateral offset (units)] for each projectile per shot.
 */
export const WEAPONS = Object.freeze([
  {
    name: 'Blaster',
    desc: 'Reliable single shot',
    damage: 1, speed: 1, range: 1, interval: 1, radius: 3,
    muzzles: [[0, 0]],
  },
  {
    name: 'Twin',
    desc: 'Two parallel shots',
    damage: 0.75, speed: 1, range: 1, interval: 1, radius: 3,
    muzzles: [[0, -6], [0, 6]],
  },
  {
    name: 'Scatter',
    desc: 'Three-way spread',
    damage: 0.62, speed: 0.95, range: 0.72, interval: 1.1, radius: 3,
    muzzles: [[-0.2, 0], [0, 0], [0.2, 0]],
  },
  {
    name: 'Cannon',
    desc: 'Heavy, long range',
    damage: 2.9, speed: 0.74, range: 1.15, interval: 2.2, radius: 7,
    muzzles: [[0, 0]],
  },
]);

/* Ship classes ----------------------------------------------------------- */

export const ShipClass = Object.freeze({ FIGHTER: 0, BREAKER: 1, MEDIC: 2, GRAVITON: 3 });
export const CLASS_COUNT = 4;

/** Each class has one ability on E; the ids match the classes. */
export const Ability = Object.freeze({ DASH: 0, RAM: 1, PULSE: 2, SINGULARITY: 3 });

/**
 * Ship classes: multipliers over the base stats, hull size and mass, and the
 * class ability. Upgrades and weapons stack on top, so every class levels up
 * the same way but plays differently. An ability costs energy (shared with
 * boost and the blast) and then recharges for `cooldown` ticks.
 */
export const CLASSES = Object.freeze([
  {
    name: 'Fighter',
    role: 'Dogfighter',
    desc: 'Balanced and nimble. Afterburner: an instant burst of speed in the direction you are thrusting.',
    hp: 1, regen: 1, thrust: 1, speed: 1, turn: 1, damage: 1, fireRate: 1, radius: 16, mass: 1,
    ability: { name: 'Afterburner', cost: 120, cooldown: seconds(3.5), duration: seconds(0.25), impulse: 420 },
  },
  {
    name: 'Breaker',
    role: 'Rammer',
    desc: 'Heavy armoured hull. Ram drive: charge forward, smashing straight through asteroids and enemies.',
    hp: 1.6, regen: 1.2, thrust: 0.95, speed: 0.92, turn: 0.78, damage: 0.8, fireRate: 0.8, radius: 21, mass: 3,
    ability: { name: 'Ram Drive', cost: 200, cooldown: seconds(7), duration: seconds(1.2), impulse: 380, rushSpeed: 1.8 },
  },
  {
    name: 'Medic',
    role: 'Support',
    desc: 'Shots repair teammates and allies near you regenerate. Repair pulse: heals every ally around you.',
    hp: 0.9, regen: 2, thrust: 1.05, speed: 1.06, turn: 1.08, damage: 0.65, fireRate: 1.1, radius: 15, mass: 0.9,
    ability: { name: 'Repair Pulse', cost: 220, cooldown: seconds(9), duration: seconds(0.5), impulse: 0, range: 430 },
  },
  {
    name: 'Graviton',
    role: 'Controller',
    desc: 'Deploys a singularity that drags enemies and loose rocks into a crushing core. Great for team kills.',
    hp: 1.2, regen: 1, thrust: 0.9, speed: 0.9, turn: 0.92, damage: 0.85, fireRate: 0.9, radius: 18, mass: 1.5,
    ability: { name: 'Singularity', cost: 260, cooldown: seconds(12), duration: seconds(0.5), impulse: 0 },
  },
]);

/** The Graviton's singularity: a temporary gravity well with no surface. */
export const SINGULARITY = Object.freeze({
  distance: 230, // deployed this far ahead of the nose
  gm: 400 * 120 * 120, // pulls 400 units/s² at 120 units
  range: 470,
  core: 40, // the pull is capped inside the core, and the core crushes
  life: seconds(4),
});

/* Derived stats ----------------------------------------------------------- */

const BASE = Object.freeze({
  hp: 100,
  regen: 2, // hp per second, after a delay without damage
  thrust: 560, // units/s^2 (main engine)
  maxSpeed: 480, // thrusters cannot push past this; gravity and boost can
  boostSpeed: 1.7, // × maxSpeed while boosting
  backThrust: 0.6, // reverse thruster, × thrust
  strafeThrust: 0.75, // lateral thrusters, × thrust
  brake: 0.9, // retro-brake deceleration, × thrust
  turnRate: 4.4, // rad/s
  damage: 12,
  bulletSpeed: 860,
  range: 900,
  fireInterval: 14, // ticks
  energyMax: 600, // integer energy keeps boost prediction exact
  energyRegen: 4, // per tick
  boostDrain: 10, // per tick
  blastCost: 160, // energy per kinetic blast
  blastInterval: 72, // ticks between blasts
  blastRecoil: 70, // units/s the blaster is pushed back
});

/**
 * Computes a ship's effective stats from its upgrade levels, weapon, active
 * power-ups, class and its team's perks. Pure and deterministic: the client
 * calls it with the same inputs to predict its own ship.
 */
export function deriveStats(levels, weapon, rapid, overdrive, out = {}, shipClass = ShipClass.FIGHTER, perks = 0) {
  const w = WEAPONS[weapon] ?? WEAPONS[0];
  const c = CLASSES[shipClass] ?? CLASSES[0];
  out.shipClass = CLASSES[shipClass] ? shipClass : ShipClass.FIGHTER;
  out.maxHp = Math.round((BASE.hp + 30 * levels[Stat.HULL]) * c.hp);
  out.regen = (BASE.regen + 1.5 * levels[Stat.REPAIR]) * c.regen;
  out.radius = c.radius;
  out.mass = c.mass;
  out.thrust = BASE.thrust * (1 + 0.06 * levels[Stat.ENGINE]) * c.thrust;
  out.boostAccel = out.thrust * (overdrive ? 2.3 : 1.9);
  out.maxSpeed = BASE.maxSpeed * (1 + 0.06 * levels[Stat.ENGINE]) * c.speed;
  out.boostSpeed = out.maxSpeed * BASE.boostSpeed * (overdrive ? 1.15 : 1);
  out.backThrust = BASE.backThrust;
  out.strafeThrust = BASE.strafeThrust;
  out.brakeAccel = out.thrust * BASE.brake;
  out.turnRate = BASE.turnRate * (1 + 0.08 * levels[Stat.HANDLING]) * c.turn;
  out.damage = BASE.damage * (1 + 0.14 * levels[Stat.DAMAGE]) * w.damage * c.damage * (perks & Perk.FORGE ? 1.15 : 1);
  out.bulletSpeed = BASE.bulletSpeed * (1 + 0.06 * levels[Stat.VELOCITY]) * w.speed;
  const range = BASE.range * (1 + 0.025 * levels[Stat.VELOCITY]) * w.range;
  out.bulletLife = Math.max(1, Math.round((range / out.bulletSpeed) * TICK_RATE));
  out.bulletRadius = w.radius;
  out.fireInterval = Math.max(
    3,
    Math.round((BASE.fireInterval * w.interval * (1 - 0.06 * levels[Stat.RELOAD]) * (rapid ? 0.55 : 1)) / c.fireRate),
  );
  out.energyMax = BASE.energyMax + 100 * levels[Stat.ENERGY];
  const regen = BASE.energyRegen + (levels[Stat.ENERGY] >> 1);
  out.energyRegen = perks & Perk.REFINERY ? Math.round(regen * 1.5) : regen; // integers keep energy exact
  out.boostDrain = overdrive ? 0 : BASE.boostDrain;
  out.boostUnlock = out.energyMax >> 2; // after running dry, boost unlocks again at 25%
  out.blastCost = BASE.blastCost;
  out.blastInterval = BASE.blastInterval;
  out.blastRecoil = BASE.blastRecoil;
  const a = c.ability;
  out.ability = out.shipClass; // Ability ids match the classes
  out.abilityCost = a.cost;
  out.abilityCooldown = a.cooldown;
  out.abilityDuration = a.duration;
  out.abilityImpulse = a.impulse;
  out.rushSpeed = out.maxSpeed * (a.rushSpeed ?? 1);
  return out;
}
