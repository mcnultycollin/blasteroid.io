/**
 * Terrain geometry shared by the server (which enforces it) and the client
 * (which draws it and warns the pilot): outposts on the planets' night sides,
 * solar flare coverage with planet shadows, and nebulae.
 *
 * Planets are tidally locked: the same face always points away from the star.
 * An outpost sits on that night side, so it moves with its planet and is
 * always sheltered from solar flares by the planet itself.
 */
import { BodyKind, WORLD_SIZE } from './constants.js';
import { normalizeAngle, wrap, wrapDelta } from './math.js';

/**
 * The point `altitude` above the night side of `planet` (the side facing away
 * from `star`), written to `out` as {x, y, nx, ny} where (nx, ny) is the
 * outward surface normal. Both bodies must be posed for the same tick.
 */
export function nightSide(star, planet, altitude, out) {
  let nx = wrapDelta(planet.x - star.x, WORLD_SIZE);
  let ny = wrapDelta(planet.y - star.y, WORLD_SIZE);
  const d = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= d;
  ny /= d;
  out.nx = nx;
  out.ny = ny;
  out.x = wrap(planet.x + nx * (planet.radius + altitude), WORLD_SIZE);
  out.y = wrap(planet.y + ny * (planet.radius + altitude), WORLD_SIZE);
  return out;
}

/** The star among `bodies` (always the first in a generated solar system). */
export const starOf = (bodies) => (bodies.length > 0 && bodies[0].kind === BodyKind.STAR ? bodies[0] : null);

/**
 * True if (x, y) lies in the path of `flare` ({angle, halfWidth}) from the
 * star, within `reach`, and no planet shades it. A planet shades everything
 * in the cone behind it as seen from the star.
 */
export function exposedToFlare(bodies, flare, x, y, reach, margin = 0) {
  const star = starOf(bodies);
  if (!star) return false;
  const dx = wrapDelta(x - star.x, WORLD_SIZE);
  const dy = wrapDelta(y - star.y, WORLD_SIZE);
  const dSq = dx * dx + dy * dy;
  if (dSq > reach * reach || dSq < star.radius * star.radius) return false;
  if (Math.abs(normalizeAngle(Math.atan2(dy, dx) - flare.angle + Math.PI) - Math.PI) > flare.halfWidth) return false;
  return !shaded(bodies, star, dx, dy, dSq, margin);
}

/** True if a planet blocks the straight line from the star to the offset (dx, dy). */
function shaded(bodies, star, dx, dy, dSq, margin) {
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i];
    if (p === star) continue;
    const px = wrapDelta(p.x - star.x, WORLD_SIZE);
    const py = wrapDelta(p.y - star.y, WORLD_SIZE);
    const along = (px * dx + py * dy) / dSq; // planet's position along the ray: 0 at the star, 1 at the point
    if (along <= 0 || along >= 1) continue; // only a planet between the star and the point casts a shadow on it
    const r = p.radius + margin;
    const cx = dx * along - px; // closest point of the ray to the planet's centre
    const cy = dy * along - py;
    if (cx * cx + cy * cy < r * r) return true;
  }
  return false;
}

/** The nebula containing (x, y), or null. Nebulae are {x, y, radius}. */
export function nebulaAt(nebulae, x, y) {
  for (let i = 0; i < nebulae.length; i++) {
    const n = nebulae[i];
    const dx = wrapDelta(x - n.x, WORLD_SIZE);
    const dy = wrapDelta(y - n.y, WORLD_SIZE);
    if (dx * dx + dy * dy < n.radius * n.radius) return n;
  }
  return null;
}
