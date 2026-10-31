/**
 * Flight-path preview and orbit readout for the player's own ship.
 *
 * The preview coasts a copy of the predicted ship forward with the same
 * stepShip() the server runs, with every body posed for each future tick, so
 * it shows exactly what happens if the pilot lets go of the controls. Points
 * are stored in the frame of the body whose well the ship is in, as that body
 * is drawn now: an orbit looks like an orbit even though the planet itself is
 * travelling around the star.
 */
import { BodyKind, TICK_RATE, WORLD_SIZE } from '../shared/constants.js';
import { GRAVITY, OrbitState, describeOrbit, dominantBody, poseBodies } from '../shared/gravity.js';
import { wrap, wrapDelta } from '../shared/math.js';
import { LOCK_CLEARANCE, copyShipState, createShipState, stepShip } from '../shared/physics.js';

const HORIZON = 300; // ticks of coasting to preview (5 s)
const EVERY = 3; // keep every third tick as a path point
const POINTS = HORIZON / EVERY + 2;

export const Flight = Object.freeze({
  FREE: 0, // outside every gravity well
  STABLE: 1, // a closed orbit that stays clear of the surface
  ESCAPE: 2, // on the way out of the well
  DESCENT: 3, // heading for a gentle touchdown
  IMPACT: 4, // heading for a hull-damaging crash, or the star
  LANDED: 5, // resting on a planet, riding along with it
  LOCKED: 6, // orbit lock engaged
});

export class FlightPath {
  constructor() {
    this.sim = createShipState();
    this.posed = [];
    this.xs = new Float64Array(POINTS);
    this.ys = new Float64Array(POINTS);
    this.count = 0;
    this.contact = false; // the path ends on a body's surface (at the last point)
    this.contactSeconds = 0;
    this.body = null; // the body whose well we are in (posed now), or null
    this.state = Flight.FREE;
    this.altitude = 0; // above the body's surface
    this.orbit = { state: OrbitState.STABLE, periapsis: 0, apoapsis: 0 };
    this.visible = false; // worth drawing: in a well, or about to enter one
  }

  /**
   * Recomputes from predicted ship state `ship` (after the command for
   * `tick`), drawn at (x, y). `bodies` are the world's bodies posed for the
   * frame being drawn; the simulation poses its own copies per future tick.
   */
  update(ship, st, bodies, tick, x, y) {
    this.count = 0;
    this.contact = false;
    this.visible = false;
    const body = bodies.length > 0 ? dominantBody(x, y, bodies) : null;
    this.body = body;
    if (body) {
      const d = Math.hypot(wrapDelta(x - body.x, WORLD_SIZE), wrapDelta(y - body.y, WORLD_SIZE));
      this.altitude = Math.max(0, d - body.radius - st.radius);
      describeOrbit(ship.x, ship.y, ship.vx, ship.vy, body, st.radius + LOCK_CLEARANCE, this.orbit);
    }
    if (ship.lockBody >= 0) {
      this.state = Flight.LOCKED;
      this.visible = true;
      return;
    }
    if (bodies.length === 0) {
      this.state = Flight.FREE;
      return;
    }

    let crash = false;
    const s = copyShipState(this.sim, ship);
    const frame = body ? body.id : -1;
    let nearWell = body !== null;
    this.push(x, y);
    for (let i = 1; i <= HORIZON; i++) {
      const t = tick + i;
      const posed = poseBodies(bodies, t, this.posed);
      stepShip(s, 0, 0, st, posed, t);
      let px = s.x;
      let py = s.y;
      if (frame >= 0) {
        px = wrap(px + wrapDelta(bodies[frame].x - posed[frame].x, WORLD_SIZE), WORLD_SIZE);
        py = wrap(py + wrapDelta(bodies[frame].y - posed[frame].y, WORLD_SIZE), WORLD_SIZE);
      }
      if (s.impact > 0) {
        this.push(px, py);
        this.contact = true;
        this.contactSeconds = i / TICK_RATE;
        crash = s.impact > GRAVITY.crashSpeed || bodies[s.contactBody]?.kind === BodyKind.STAR;
        break;
      }
      if (i % EVERY === 0) {
        this.push(px, py);
        if (!nearWell && dominantBody(s.x, s.y, posed)) nearWell = true;
      }
    }
    this.visible = nearWell;

    if (!body) this.state = Flight.FREE;
    else if (ship.contactBody >= 0 && ship.impact <= GRAVITY.landingSpeed && body.kind !== BodyKind.STAR) this.state = Flight.LANDED;
    else if (this.contact) this.state = crash ? Flight.IMPACT : Flight.DESCENT;
    else if (this.orbit.state === OrbitState.ESCAPE) this.state = Flight.ESCAPE;
    else if (this.orbit.state === OrbitState.IMPACT) this.state = Flight.DESCENT; // touches down past the preview
    else this.state = Flight.STABLE;
  }

  push(x, y) {
    if (this.count >= POINTS) return;
    this.xs[this.count] = x;
    this.ys[this.count] = y;
    this.count++;
  }
}
