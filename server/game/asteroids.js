/** Asteroid field: straight-line drift and population upkeep. */
import { TICK_DT, WORLD_SIZE } from '../../shared/constants.js';
import { wrap } from '../../shared/math.js';
import { findOpenSpot, randomVelocity, spawnAsteroid } from './spawning.js';
import { ASTEROID } from './tuning.js';

const velocity = { vx: 0, vy: 0 };

export function updateAsteroids(game) {
  for (const a of game.asteroids) {
    if (a.dead) continue;
    a.x = wrap(a.x + a.vx * TICK_DT, WORLD_SIZE);
    a.y = wrap(a.y + a.vy * TICK_DT, WORLD_SIZE);
  }
}

export function asteroidMass(game) {
  let mass = 0;
  for (const a of game.asteroids) if (!a.dead) mass += ASTEROID.massUnits[a.size];
  return mass;
}

export function spawnRandomAsteroid(game, size) {
  const spot = findOpenSpot(game, ASTEROID.minSpawnDistance, 12);
  const [minSpeed, maxSpeed] = ASTEROID.speed[size];
  randomVelocity(game.rng, minSpeed, maxSpeed, velocity);
  return spawnAsteroid(game, size, spot.x, spot.y, velocity.vx, velocity.vy);
}

/** Fills the world at startup with a mix of sizes. */
export function seedAsteroids(game) {
  while (asteroidMass(game) < ASTEROID.targetMass) {
    const roll = game.rng();
    spawnRandomAsteroid(game, roll < 0.25 ? 0 : roll < 0.55 ? 1 : 2);
  }
}

export function targetAsteroidMass(game) {
  return ASTEROID.targetMass + ASTEROID.massPerShip * game.liveShipCount();
}

/** Tops the field back up out of sight as players clear it. */
export function maintainAsteroids(game) {
  if (game.tick % ASTEROID.spawnEvery !== 0) return;
  let mass = asteroidMass(game);
  const target = targetAsteroidMass(game);
  for (let i = 0; i < ASTEROID.maxSpawnsPerCheck && mass < target; i++) {
    const size = game.rng() < 0.8 ? 2 : 1;
    spawnRandomAsteroid(game, size);
    mass += ASTEROID.massUnits[size];
  }
}
