/**
 * Asteroid field and motion. Three kinds of motion, each replicated as
 * cheaply as possible:
 *   - free rocks in open space drift in straight lines (sent once);
 *   - belt rocks follow exact circular orbits around a planet (sent once);
 *   - free rocks inside a gravity well fall under gravity with orbital decay
 *     until they crash or escape (streamed while inside the well).
 */
import { RemoveReason } from '../../shared/constants.js';
import { insideBody, orbitState, stepBallistic } from '../../shared/gravity.js';
import { findOpenSpot, randomVelocity, spawnAsteroid } from './spawning.js';
import { ASTEROID } from './tuning.js';

const velocity = { vx: 0, vy: 0 };

export function updateAsteroids(game) {
  const planets = game.planets;
  for (const a of game.asteroids) {
    if (a.dead) continue;
    if (a.orbit) {
      orbitState(planets[a.orbit.planet], a.orbit, game.tick, a);
      continue;
    }
    const inWell = stepBallistic(a, planets);
    if (inWell !== a.streamed) {
      a.streamed = inWell; // clients switch between streaming and straight-line extrapolation
      a.version++;
    }
    if (inWell && insideBody(a.x, a.y, a.radius, planets)) {
      a.dead = true; // shattered on the surface, or swallowed by the star
      a.removeReason = RemoveReason.DESTROYED;
    }
  }
}

/** Mass of the open asteroid field (belt rocks are counted per planet). */
export function asteroidMass(game) {
  let mass = 0;
  for (const a of game.asteroids) if (!a.dead && !a.orbit) mass += ASTEROID.massUnits[a.size];
  return mass;
}

export function spawnRandomAsteroid(game, size) {
  const spot = findOpenSpot(game, ASTEROID.minSpawnDistance, 12, true);
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
