/**
 * The solar system: generation from the room seed, and the rock belts that
 * orbit each planet. Bodies follow fixed orbits (see shared/gravity.js), so
 * the server only has to pose them once per tick.
 */
import { ASTEROID_RADIUS, BodyKind, WORLD_SIZE } from '../../shared/constants.js';
import { createBody, orbitAngularSpeed, orbitState, setPose } from '../../shared/gravity.js';
import { TAU, lerp } from '../../shared/math.js';
import { dqAngle, qAngle } from '../../shared/protocol.js';
import { nearestShipDistSq, spawnAsteroid } from './spawning.js';
import { ASTEROID, PLANETS } from './tuning.js';

const STAR_NAMES = ['Sol', 'Helios', 'Vega', 'Altair', 'Rigel', 'Lyra', 'Antares'];
const NAMES = ['Vesta', 'Ceres', 'Tycho', 'Kepler', 'Hadron', 'Nyx', 'Orin', 'Lumen', 'Zeta', 'Ares', 'Pallas', 'Juno', 'Rhea', 'Io'];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const scratch = { x: 0, y: 0, vx: 0, vy: 0 };

const pick = (rng, list) => list.splice(Math.floor(rng() * list.length), 1)[0];
const between = (rng, [min, max], round) => Math.round(lerp(min, max, rng()) * round) / round;
const rangeOf = (radius, density) => createBody(0, BodyKind.ROCK, radius, density, '', { cx: 0, cy: 0, radius: 0 }).range;

/**
 * Builds the star and its planets. The dense core takes the inner orbit; the
 * rocky world and the gas giant share the outer one on opposite sides. Orbit
 * radii follow from the gravity ranges, so wells never overlap.
 */
export function generateSolarSystem(rng) {
  const cx = WORLD_SIZE / 2;
  const cy = WORLD_SIZE / 2;
  const names = [...NAMES];
  const star = createBody(0, BodyKind.STAR, PLANETS.star.radius, PLANETS.star.density, pick(rng, [...STAR_NAMES]), {
    cx,
    cy,
    radius: 0,
    phase: 0,
    omega: 0,
  });
  const make = (kind, type) => ({
    kind,
    radius: between(rng, type.radius, 1),
    density: between(rng, type.density, 100),
    name: `${pick(rng, names)} ${NUMERALS[Math.floor(rng() * NUMERALS.length)]}`,
  });
  const core = make(BodyKind.CORE, PLANETS.types.core);
  const rock = make(BodyKind.ROCK, PLANETS.types.rock);
  const gas = make(BodyKind.GAS, PLANETS.types.gas);
  const coreRange = rangeOf(core.radius, core.density);
  const outerRange = Math.max(rangeOf(rock.radius, rock.density), rangeOf(gas.radius, gas.density));
  const inner = Math.round(star.range + coreRange + PLANETS.wellGap);
  const outer = Math.round(inner + coreRange + outerRange + PLANETS.wellGap);
  const innerOmega = TAU / PLANETS.innerPeriod;
  const outerOmega = TAU / PLANETS.outerPeriod;
  const outerPhase = rng() * TAU;
  const bodies = [star];
  for (const [spec, radius, phase, omega] of [
    [core, inner, rng() * TAU, innerOmega],
    [rock, outer, outerPhase, outerOmega],
    [gas, outer, outerPhase + Math.PI, outerOmega],
  ]) {
    const body = createBody(bodies.length, spec.kind, spec.radius, spec.density, spec.name, { cx, cy, radius, phase, omega });
    body.spin = rng() < 0.5 ? -1 : 1; // the direction its belt circles
    bodies.push(body);
  }
  return bodies;
}

/** Poses every body for the current tick; everything else reads these positions. */
export function updateBodies(game) {
  for (const body of game.planets) setPose(body, game.tick);
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

/** Releases a belt rock from its orbit: it keeps its motion and falls freely from now on. */
export function releaseFromOrbit(rock) {
  rock.orbit = null;
  rock.version++;
}

const hasBelt = (body) => body.kind !== BodyKind.STAR;

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
    if (!hasBelt(planet)) continue;
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
    if (hasBelt(planet) && beltMass(game, planet) < beltTarget(planet)) {
      spawnOrbiter(game, planet, game.rng() < 0.7 ? 2 : 1, true);
    }
  }
}
