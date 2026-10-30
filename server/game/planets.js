/** Planets: generation from the room seed, and the rock belts that orbit them. */
import { ASTEROID_RADIUS, WORLD_SIZE } from '../../shared/constants.js';
import { createPlanet, orbitAngularSpeed, orbitState } from '../../shared/gravity.js';
import { TAU, lerp, wrapDelta } from '../../shared/math.js';
import { dqAngle, qAngle } from '../../shared/protocol.js';
import { nearestShipDistSq, spawnAsteroid } from './spawning.js';
import { ASTEROID, PLANETS } from './tuning.js';

const NAMES = ['Vesta', 'Ceres', 'Tycho', 'Kepler', 'Hadron', 'Nyx', 'Orin', 'Lumen', 'Zeta', 'Ares', 'Pallas', 'Juno', 'Rhea', 'Io'];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const scratch = { x: 0, y: 0, vx: 0, vy: 0 };

/** Places one planet of each type, keeping their gravity wells apart. */
export function generatePlanets(rng) {
  const planets = [];
  const names = [...NAMES];
  for (let i = 0; i < PLANETS.count; i++) {
    const type = PLANETS.types[i % PLANETS.types.length];
    const radius = Math.round(lerp(type.radius[0], type.radius[1], rng()));
    const density = Math.round(lerp(type.density[0], type.density[1], rng()) * 100) / 100;
    const name = `${names.splice(Math.floor(rng() * names.length), 1)[0]} ${NUMERALS[Math.floor(rng() * NUMERALS.length)]}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      const planet = createPlanet(planets.length, Math.round(rng() * WORLD_SIZE), Math.round(rng() * WORLD_SIZE), radius, density, name);
      const clear = planets.every((p) => {
        const gap = p.range + planet.range + PLANETS.spacing;
        return Math.hypot(wrapDelta(p.x - planet.x, WORLD_SIZE), wrapDelta(p.y - planet.y, WORLD_SIZE)) > gap;
      });
      if (clear) {
        planet.spin = rng() < 0.5 ? -1 : 1; // the direction its belt circles
        planets.push(planet);
        break;
      }
    }
  }
  return planets;
}

/**
 * A circular orbit around `planet`, with its radius and phase snapped to what
 * the wire format carries, so clients compute exactly the same path.
 */
export function makeOrbit(planet, radius, angle, tick, dir) {
  const r = Math.round(radius);
  return { planet: planet.id, radius: r, phase: dqAngle(qAngle(angle)), epoch: tick, dir, omega: orbitAngularSpeed(planet, r) };
}

/** Radius band orbiting rocks of a given size may use around `planet`. */
export function orbitBand(planet, size) {
  return [planet.radius + PLANETS.orbitClearance + ASTEROID_RADIUS[size], planet.range * PLANETS.orbitReach];
}

/** Spawns an orbiting rock; with `outOfSight`, only where no ship can see it appear. */
export function spawnOrbiter(game, planet, size, outOfSight) {
  const [minR, maxR] = orbitBand(planet, size);
  for (let attempt = 0; attempt < 8; attempt++) {
    const orbit = makeOrbit(planet, lerp(minR, maxR, game.rng()), game.rng() * TAU, game.tick, planet.spin);
    orbitState(planet, orbit, game.tick, scratch);
    if (outOfSight && nearestShipDistSq(game, scratch.x, scratch.y) < ASTEROID.minSpawnDistance ** 2) continue;
    const rock = spawnAsteroid(game, size, scratch.x, scratch.y, scratch.vx, scratch.vy);
    if (rock) rock.orbit = orbit;
    return rock;
  }
  return null;
}

function beltTarget(planet) {
  return Math.round(planet.range * PLANETS.beltMassPerRange);
}

function beltMass(game, planet) {
  let mass = 0;
  for (const a of game.asteroids) {
    if (!a.dead && a.orbit && a.orbit.planet === planet.id) mass += ASTEROID.massUnits[a.size];
  }
  return mass;
}

export function seedBelts(game) {
  for (const planet of game.planets) {
    let mass = beltMass(game, planet);
    while (mass < beltTarget(planet)) {
      const roll = game.rng();
      const size = roll < 0.4 ? 2 : roll < 0.8 ? 1 : 0;
      if (!spawnOrbiter(game, planet, size, false)) break;
      mass += ASTEROID.massUnits[size];
    }
  }
}

/** Replenishes belts as players shoot them down, out of sight like the open field. */
export function maintainBelts(game) {
  if (game.tick % ASTEROID.spawnEvery !== 0) return;
  for (const planet of game.planets) {
    if (beltMass(game, planet) < beltTarget(planet)) spawnOrbiter(game, planet, game.rng() < 0.7 ? 2 : 1, true);
  }
}
