/**
 * Ship progression: levels, upgradeable stats and weapons. Shared so the
 * client can predict its own ship with exactly the numbers the server uses
 * and display upgrade information without extra traffic.
 */
import { TICK_DT, TICK_RATE } from './constants.js';
import { clamp } from './math.js';

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

/* Derived stats ----------------------------------------------------------- */

const BASE = Object.freeze({
  hp: 100,
  regen: 2, // hp per second, after a delay without damage
  thrust: 560, // units/s^2
  drag: 1.2, // per second; terminal speed = thrust / drag
  brakeDrag: 4,
  turnRate: 4.4, // rad/s
  damage: 12,
  bulletSpeed: 860,
  range: 900,
  fireInterval: 14, // ticks
  energyMax: 600, // integer energy keeps boost prediction exact
  energyRegen: 4, // per tick
  boostDrain: 10, // per tick
});

/**
 * Computes a ship's effective stats from its upgrade levels, weapon and
 * active power-ups. Pure and deterministic: the client calls it with the same
 * inputs to predict its own ship.
 */
export function deriveStats(levels, weapon, rapid, overdrive, out = {}) {
  const w = WEAPONS[weapon] ?? WEAPONS[0];
  out.maxHp = BASE.hp + 30 * levels[Stat.HULL];
  out.regen = BASE.regen + 1.5 * levels[Stat.REPAIR];
  out.thrust = BASE.thrust * (1 + 0.06 * levels[Stat.ENGINE]);
  out.boostAccel = out.thrust * (overdrive ? 2.3 : 1.9);
  out.dragFactor = Math.exp(-BASE.drag * TICK_DT);
  out.brakeFactor = Math.exp(-BASE.brakeDrag * TICK_DT);
  out.turnRate = BASE.turnRate * (1 + 0.08 * levels[Stat.HANDLING]);
  out.damage = BASE.damage * (1 + 0.14 * levels[Stat.DAMAGE]) * w.damage;
  out.bulletSpeed = BASE.bulletSpeed * (1 + 0.06 * levels[Stat.VELOCITY]) * w.speed;
  const range = BASE.range * (1 + 0.025 * levels[Stat.VELOCITY]) * w.range;
  out.bulletLife = Math.max(1, Math.round((range / out.bulletSpeed) * TICK_RATE));
  out.bulletRadius = w.radius;
  out.fireInterval = Math.max(
    3,
    Math.round(BASE.fireInterval * w.interval * (1 - 0.06 * levels[Stat.RELOAD]) * (rapid ? 0.55 : 1)),
  );
  out.energyMax = BASE.energyMax + 100 * levels[Stat.ENERGY];
  out.energyRegen = BASE.energyRegen + (levels[Stat.ENERGY] >> 1);
  out.boostDrain = overdrive ? 0 : BASE.boostDrain;
  out.boostUnlock = out.energyMax >> 2; // after running dry, boost unlocks again at 25%
  return out;
}
