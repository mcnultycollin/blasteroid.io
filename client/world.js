/**
 * Client-side replica of the world: entity store, roster, server clock
 * estimation, interpolation and predicted ("ghost") projectiles.
 *
 * Time bases:
 *  - renderTick: slightly in the past, so ships and aliens can be
 *    interpolated between two received snapshots.
 *  - presentTick: the tick at which the server will process the command we
 *    are sending now. Our own ship lives here (it is predicted), and so do
 *    the star and planets, asteroids, pickups and our own projectiles. Those
 *    move predictably, so they can be computed for any time, which keeps our
 *    shots and the rocks they hit consistent on screen.
 *  - Other players' projectiles start in renderTick, so they leave the
 *    shooter's muzzle, then catch up to presentTick over a few frames.
 *  - Ships and aliens inside a gravity well are carried along with its body
 *    from renderTick to presentTick, so a pilot landed on a moving planet is
 *    drawn on its surface rather than where the planet was a moment ago.
 */
import {
  ASTEROID_RADIUS,
  EntityType,
  SNAPSHOT_INTERVAL,
  TICK_DT,
  TICK_RATE,
  WORLD_SIZE,
} from '../shared/constants.js';
import {
  createBody,
  dominantBody,
  insideBody,
  orbitAngularSpeed,
  orbitState,
  poseBodies,
  setPose,
  stepBallistic,
} from '../shared/gravity.js';
import { TAU, clamp, createRng, hash32, lerpAngle, wrap, wrapDelta, wrapLerp } from '../shared/math.js';
import { NO_ID, readEntity, readSnapshot } from '../shared/protocol.js';

const TICKS_PER_MS = TICK_RATE / 1000;
const HISTORY = 16; // interpolation samples per streamed entity
const MAX_EXTRAPOLATION = 8; // ticks to coast past the newest sample before freezing
const CATCH_UP_TICKS = 12; // remote projectiles converge onto the present over this long
const CLOCK_WINDOW = 60; // snapshot arrivals used to estimate latency and jitter
const GHOST_TIMEOUT = 45; // ticks an unconfirmed predicted projectile may live
const POSE_CACHE = 64; // ticks of body poses kept for extrapolating falling rocks
const CARRY_DEPTH = 0.3; // carrying along with a body ramps up over this outer share of its well

/** Estimates the server tick from snapshot arrival times. */
class ServerClock {
  constructor() {
    this.samples = new Float64Array(CLOCK_WINDOW);
    this.count = 0;
    this.head = 0;
    this.best = 0; // latest-arriving offset: server tick at arrival under best-case latency
    this.jitter = 0;
    this.offset = 0; // smoothed render offset
    this.ready = false;
  }

  observe(tick, now) {
    this.samples[this.head] = tick - now * TICKS_PER_MS;
    this.head = (this.head + 1) % CLOCK_WINDOW;
    if (this.count < CLOCK_WINDOW) this.count++;
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < this.count; i++) {
      const s = this.samples[i];
      if (s > max) max = s;
      if (s < min) min = s;
    }
    this.best = max;
    this.jitter = max - min;
    if (!this.ready) {
      this.ready = true;
      this.offset = this.target();
    }
  }

  /** Interpolation delay in ticks: one snapshot interval plus measured jitter. */
  get delay() {
    return SNAPSHOT_INTERVAL + Math.min(this.jitter, 6) + 1;
  }

  target() {
    return this.best - this.delay;
  }

  /** Advances the render clock, easing towards the target rather than jumping. */
  renderTick(now, dtMs) {
    const error = this.target() - this.offset;
    if (Math.abs(error) > 12) this.offset += error;
    else {
      const step = dtMs * TICKS_PER_MS * 0.08; // at most 8% time dilation
      this.offset += clamp(error, -step, step);
    }
    return now * TICKS_PER_MS + this.offset;
  }

  /** Best estimate of the server's current tick. */
  serverTick(now) {
    return now * TICKS_PER_MS + this.best;
  }
}

export class ClientEntity {
  constructor(id, type, now) {
    this.id = id;
    this.type = type;
    // Latest replicated state
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.angle = 0;
    this.t0 = 0; // tick that (x, y) refers to
    this.birth = -Infinity; // projectiles are hidden before they were fired
    this.playerId = NO_ID;
    this.hpFrac = 1;
    this.flags = 0;
    this.level = 1;
    this.weapon = 0;
    this.size = 0;
    this.kind = 0;
    this.ownerId = NO_ID;
    this.life = 0;
    this.fresh = false;
    this.own = false;
    this.fireSeq = 0;
    this.muzzle = 0;
    this.orbit = null; // asteroid on a circular orbit: position is a function of time
    this.streamed = false; // asteroid falling inside a gravity well: extrapolated with gravity
    this.sim = null; // that asteroid's gravity extrapolation state ({x, y, vx, vy} at simTick)
    this.simTick = 0;
    // Interpolation history for ships and aliens: [tick, x, y, angle] per sample
    this.hist = type === EntityType.SHIP || type === EntityType.ALIEN ? new Float64Array(HISTORY * 4) : null;
    this.histCount = 0;
    this.histHead = 0;
    // Presentation
    this.rx = 0;
    this.ry = 0;
    this.ra = 0;
    this.dx = 0; // camera-relative offset, set by the renderer
    this.dy = 0;
    this.visible = true;
    this.seed = hash32(id * 7919 + type);
    this.shape = null;
    this.spin = 0;
    this.hitFlash = 0;
    this.createdAt = now;
    this.predictedHit = false;
  }

  pushSample(tick, x, y, angle) {
    const h = this.hist;
    const i = this.histHead * 4;
    h[i] = tick;
    h[i + 1] = x;
    h[i + 2] = y;
    h[i + 3] = angle;
    this.histHead = (this.histHead + 1) % HISTORY;
    if (this.histCount < HISTORY) this.histCount++;
  }
}

/** Builds a jagged asteroid outline from the entity's seed: [x0, y0, x1, y1, ...] in world units. */
function asteroidShape(seed, radius) {
  const rng = createRng(seed);
  const n = 9 + Math.floor(rng() * 5);
  const shape = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (rng() - 0.5) * 0.35;
    const r = radius * (0.74 + rng() * 0.42);
    shape[i * 2] = Math.cos(a) * r;
    shape[i * 2 + 1] = Math.sin(a) * r;
  }
  return shape;
}

export class ClientWorld {
  /**
   * `events` callbacks: self(s, tick), stats(s, tick), spectate(id, x, y),
   * created(e), removed(e, reason, collectorId), event(ev), damaged(e),
   * effect(kind, x, y, angle, sourceId).
   */
  constructor(events) {
    this.events = events;
    this.entities = new Map();
    this.roster = new Map(); // playerId -> { name, hue }
    this.ghosts = [];
    this.clock = new ServerClock();
    this.planets = []; // the star and planets, posed for presentTick each frame
    this.renderBodies = []; // the same bodies posed for renderTick
    this.poseCache = [];
    this.tick = 0; // tick of the snapshot being decoded / last decoded
    this.myShipId = NO_ID;
    this.snapshotCount = 0;
    this.scratch = { self: {}, stats: {} };
    this.now = 0;
    this.netStats = { extrapolations: 0, ghostsConfirmed: 0, ghostsExpired: 0 };
  }

  reset() {
    this.setBodies([]);
    this.entities.clear();
    this.roster.clear();
    this.ghosts.length = 0;
    this.clock = new ServerClock();
    this.myShipId = NO_ID;
  }

  /**
   * The star and planets arrive once, in the welcome message. They follow
   * fixed orbits, so their position at any tick is computed locally.
   */
  setBodies(list) {
    this.planets = list.map((b, i) => createBody(i, b.kind, b.radius, b.density, b.name, b.orbit));
    this.renderBodies = [];
    this.poseCache = Array.from({ length: POSE_CACHE }, () => ({ tick: NaN, bodies: [] }));
  }

  /** The bodies posed for a whole tick (cached; used to extrapolate falling rocks). */
  bodiesAt(tick) {
    const slot = this.poseCache[((tick % POSE_CACHE) + POSE_CACHE) % POSE_CACHE];
    if (slot.tick !== tick) {
      poseBodies(this.planets, tick, slot.bodies);
      slot.tick = tick;
    }
    return slot.bodies;
  }

  /* Roster ------------------------------------------------------------------ */

  setPlayer(id, name) {
    const existing = this.roster.get(id);
    if (existing) existing.name = name;
    else this.roster.set(id, { name, hue: (id * 137.508) % 360 });
  }

  playerName(id) {
    return this.roster.get(id)?.name ?? '???';
  }

  playerHue(id) {
    return this.roster.get(id)?.hue ?? (id * 137.508) % 360;
  }

  /* Snapshot decoding (sink interface for readSnapshot) ----------------------- */

  applySnapshot(reader, now) {
    this.now = now;
    readSnapshot(reader, this, this.scratch);
  }

  begin(tick) {
    this.tick = tick;
    this.snapshotCount++;
    this.clock.observe(tick, this.now);
  }

  self(s) {
    this.myShipId = s.id;
    this.events.self(s, this.tick);
  }

  stats(s) {
    this.events.stats(s, this.tick);
  }

  spectate(id, x, y) {
    this.events.spectate(id, x, y);
  }

  remove(id, reason, collectorId) {
    const e = this.entities.get(id);
    if (!e) return;
    this.entities.delete(id);
    this.events.removed(e, reason, collectorId);
  }

  entity(type, id, reader) {
    let e = this.entities.get(id);
    const created = !e || e.type !== type;
    if (created) e = new ClientEntity(id, type, this.now);
    const previousHp = e.hpFrac;
    readEntity(type, reader, e);
    e.t0 = this.tick;
    if (e.hist) e.pushSample(this.tick, e.x, e.y, e.angle);
    if (type === EntityType.ASTEROID) this.prepareAsteroidMotion(e);
    if (!created) {
      if (e.hpFrac < previousHp - 0.001) {
        e.hitFlash = 1;
        this.events.damaged(e);
      }
      return;
    }
    e.rx = e.x;
    e.ry = e.y;
    e.ra = e.angle;
    switch (type) {
      case EntityType.ASTEROID:
        e.shape = asteroidShape(e.seed, ASTEROID_RADIUS[e.size]);
        e.spin = ((e.seed & 0xff) / 255 - 0.5) * 1.2;
        break;
      case EntityType.BULLET:
        if (e.own) this.adoptGhost(e);
        else if (e.fresh) e.birth = this.tick - 1;
        break;
    }
    this.entities.set(id, e);
    this.events.created(e);
  }

  event(ev) {
    this.events.event(ev);
  }

  effect(kind, x, y, angle, sourceId) {
    this.events.effect(kind, x, y, angle, sourceId);
  }

  prepareAsteroidMotion(e) {
    if (e.orbit) {
      const planet = this.planets[e.orbit.planet];
      if (planet) e.orbit.omega = orbitAngularSpeed(planet, e.orbit.radius);
      else e.orbit = null; // unknown planet: should not happen, but never crash on it
    } else if (e.streamed) {
      const sim = e.sim ?? (e.sim = { x: 0, y: 0, vx: 0, vy: 0 });
      sim.x = e.x;
      sim.y = e.y;
      sim.vx = e.vx;
      sim.vy = e.vy;
      e.simTick = e.t0;
    }
  }

  end() {}

  /* Predicted projectiles ----------------------------------------------------- */

  /** Spawns a locally predicted projectile at `tick` (present time base). */
  addGhost(seq, muzzle, shot, kind, life, tick) {
    const g = new ClientEntity(0, EntityType.BULLET, this.now);
    g.x = shot.x;
    g.y = shot.y;
    g.vx = shot.vx;
    g.vy = shot.vy;
    g.t0 = tick;
    g.birth = tick;
    g.kind = kind;
    g.life = life;
    g.own = true;
    g.fireSeq = seq & 0xffff;
    g.muzzle = muzzle;
    g.ownerId = this.myShipId;
    this.ghosts.push(g);
    return g;
  }

  /**
   * Replaces a ghost with the server's confirmed projectile. If the two
   * trajectories agree, keep the ghost's (already on screen) to avoid a pop.
   */
  adoptGhost(e) {
    const i = this.ghosts.findIndex((g) => g.fireSeq === e.fireSeq && g.muzzle === e.muzzle);
    if (i === -1) return;
    const g = this.ghosts[i];
    this.ghosts.splice(i, 1);
    this.netStats.ghostsConfirmed++;
    const t = this.tick;
    const gx = g.x + g.vx * (t - g.t0) * TICK_DT;
    const gy = g.y + g.vy * (t - g.t0) * TICK_DT;
    if (Math.abs(wrapDelta(gx - e.x, WORLD_SIZE)) + Math.abs(wrapDelta(gy - e.y, WORLD_SIZE)) < 30) {
      e.x = g.x;
      e.y = g.y;
      e.vx = g.vx;
      e.vy = g.vy;
      e.t0 = g.t0;
    }
    e.birth = g.birth;
    e.predictedHit = g.predictedHit;
  }

  /** Removes our projectile (ghost or confirmed) fired by command `seq`, `muzzle`. Returns it. */
  takeOwnProjectile(seq, muzzle) {
    const i = this.ghosts.findIndex((g) => g.fireSeq === seq && g.muzzle === muzzle);
    if (i !== -1) return this.ghosts.splice(i, 1)[0];
    for (const e of this.entities.values()) {
      if (e.type === EntityType.BULLET && e.own && e.fireSeq === seq && e.muzzle === muzzle) {
        this.entities.delete(e.id);
        return e;
      }
    }
    return null;
  }

  /* Per-frame presentation ---------------------------------------------------- */

  /** Computes render positions (rx, ry, ra) and visibility for every entity. */
  updatePresentation(renderTick, presentTick) {
    for (const body of this.planets) setPose(body, presentTick);
    poseBodies(this.planets, renderTick, this.renderBodies);
    for (const e of this.entities.values()) {
      switch (e.type) {
        case EntityType.SHIP:
        case EntityType.ALIEN:
          if (!interpolate(e, renderTick)) this.netStats.extrapolations++;
          this.carryWithBody(e);
          break;
        case EntityType.ASTEROID:
          if (e.orbit) {
            orbitState(this.planets[e.orbit.planet], e.orbit, presentTick, orbitScratch);
            e.rx = orbitScratch.x;
            e.ry = orbitScratch.y;
          } else if (e.streamed) {
            this.extrapolateBallistic(e, presentTick);
          } else {
            extrapolate(e, presentTick);
          }
          e.ra = (e.seed % 628) / 100 + e.spin * presentTick * TICK_DT;
          break;
        case EntityType.PICKUP:
          e.rx = e.x;
          e.ry = e.y;
          break;
        case EntityType.BULLET: {
          let t = presentTick;
          if (!e.own && e.birth > -Infinity) {
            const k = clamp((renderTick - e.birth) / CATCH_UP_TICKS, 0, 1);
            t = renderTick + (presentTick - renderTick) * k;
          }
          extrapolate(e, t);
          if (e.own) this.predictPlanetImpact(e);
          e.visible = t >= e.birth && t - e.t0 <= e.life && !e.predictedHit && !insideBody(e.rx, e.ry, 0, this.planets);
          break;
        }
      }
      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - 0.08);
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      extrapolate(g, presentTick);
      if (presentTick >= g.birth) this.predictPlanetImpact(g);
      g.visible = presentTick >= g.birth && !g.predictedHit;
      if (presentTick - g.t0 > Math.min(g.life, GHOST_TIMEOUT)) {
        this.ghosts.splice(i, 1);
        this.netStats.ghostsExpired++;
      }
    }
  }

  /**
   * Moves a streamed entity, interpolated at renderTick, along with the body
   * whose well it is in, to where that body is at presentTick. The carry
   * fades in over the outer part of the well, so nothing pops at its edge.
   */
  carryWithBody(e) {
    const from = dominantBody(e.rx, e.ry, this.renderBodies);
    if (!from) return;
    const to = this.planets[from.id];
    const d = Math.hypot(wrapDelta(e.rx - from.x, WORLD_SIZE), wrapDelta(e.ry - from.y, WORLD_SIZE));
    const k = clamp((from.range - d) / (from.range * CARRY_DEPTH), 0, 1);
    e.rx = wrap(e.rx + wrapDelta(to.x - from.x, WORLD_SIZE) * k, WORLD_SIZE);
    e.ry = wrap(e.ry + wrapDelta(to.y - from.y, WORLD_SIZE) * k, WORLD_SIZE);
  }

  /** Our shots hitting a body are predictable (bodies move on rails): show the impact immediately. */
  predictPlanetImpact(e) {
    if (!e.predictedHit && insideBody(e.rx, e.ry, 0, this.planets)) {
      e.predictedHit = true;
      this.events.predictedImpact(e.rx, e.ry);
    }
  }

  /**
   * Advances a falling asteroid's gravity simulation to `t`, from the last
   * streamed state, using the same stepBallistic() as the server, with the
   * bodies posed for each tick. Fresh states arrive every snapshot, so the
   * horizon is only a few ticks.
   */
  extrapolateBallistic(e, t) {
    const sim = e.sim;
    const target = Math.floor(t);
    for (let steps = 0; e.simTick < target && steps < 60; steps++) {
      e.simTick++;
      stepBallistic(sim, this.bodiesAt(e.simTick));
    }
    const dt = (t - e.simTick) * TICK_DT;
    e.rx = wrap(sim.x + sim.vx * dt, WORLD_SIZE);
    e.ry = wrap(sim.y + sim.vy * dt, WORLD_SIZE);
  }
}

const orbitScratch = { x: 0, y: 0, vx: 0, vy: 0 };

function extrapolate(e, t) {
  const dt = (t - e.t0) * TICK_DT;
  e.rx = wrap(e.x + e.vx * dt, WORLD_SIZE);
  e.ry = wrap(e.y + e.vy * dt, WORLD_SIZE);
}

/** Sets the render state of a streamed entity at tick `t`. Returns false when it had to extrapolate. */
function interpolate(e, t) {
  const h = e.hist;
  let newer = -1;
  let older = -1;
  for (let k = 0; k < e.histCount; k++) {
    const i = ((e.histHead - 1 - k + HISTORY) % HISTORY) * 4;
    if (h[i] <= t) {
      older = i;
      break;
    }
    newer = i;
  }
  if (older === -1) {
    // Before the oldest sample (just appeared): hold the oldest.
    e.rx = h[newer + 1];
    e.ry = h[newer + 2];
    e.ra = h[newer + 3];
    return true;
  }
  if (newer === -1) {
    // Past the newest sample (late packet): coast briefly on the last velocity.
    const dt = Math.min(t - h[older], MAX_EXTRAPOLATION) * TICK_DT;
    e.rx = wrap(h[older + 1] + e.vx * dt, WORLD_SIZE);
    e.ry = wrap(h[older + 2] + e.vy * dt, WORLD_SIZE);
    e.ra = h[older + 3];
    return false;
  }
  const span = h[newer] - h[older];
  const f = span > 0 ? (t - h[older]) / span : 1;
  e.rx = wrapLerp(h[older + 1], h[newer + 1], f, WORLD_SIZE);
  e.ry = wrapLerp(h[older + 2], h[newer + 2], f, WORLD_SIZE);
  e.ra = lerpAngle(h[older + 3], h[newer + 3], f);
  return true;
}
