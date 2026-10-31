import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BodyKind, TICK_DT, TICK_RATE, WORLD_SIZE } from '../shared/constants.js';
import {
  GRAVITY,
  OrbitState,
  applyGravity,
  collideBodies,
  describeOrbit,
  dominantBody,
  gravityAt,
  insideBody,
  orbitAngularSpeed,
  orbitState,
  poseBodies,
  pullAt,
  setPose,
  stepBallistic,
} from '../shared/gravity.js';
import { fixedBody, orbitingBody } from './helpers.js';

const rocky = fixedBody(0, 3000, 3000, 160, 1, BodyKind.ROCK, 'Rocky');
const hit = { impact: 0, body: null };

test('mass comes from size and density: a small dense planet out-pulls a big light one at the surface', () => {
  const giant = fixedBody(0, 0, 0, 240, 0.5, BodyKind.GAS);
  const dense = fixedBody(1, 0, 0, 85, 3.5, BodyKind.CORE);
  assert.ok(giant.gm > dense.gm, 'the giant is more massive');
  assert.ok(dense.surfacePull > giant.surfacePull, 'but the dense world pulls harder at its surface');
  assert.ok(Math.abs(rocky.surfacePull - GRAVITY.G * 1 * 160) < 1e-9, 'surface pull = G × density × radius');
  assert.ok(giant.range > dense.range, 'range grows with mass');
});

test('pull is inverse-square inside, fades smoothly and is exactly zero outside the range', () => {
  assert.ok(Math.abs(pullAt(rocky, 300) / pullAt(rocky, 170) - (170 / 300) ** 2) < 1e-12);
  assert.equal(pullAt(rocky, rocky.range), 0);
  assert.equal(pullAt(rocky, rocky.range + 500), 0);
  assert.ok(Math.abs(pullAt(rocky, rocky.fadeFrom + 1e-6) - pullAt(rocky, rocky.fadeFrom - 1e-6)) < 1e-3, 'no jump at the fade start');
  assert.ok(pullAt(rocky, rocky.range - 1e-3) < 1e-4, 'fades to nothing at the edge');
  assert.equal(pullAt(rocky, 10), pullAt(rocky, rocky.radius), 'clamped at the surface');
});

test('applyGravity pulls towards the body only within range, across the world seam too', () => {
  const near = { x: 3000 + 300, y: 3000, vx: 0, vy: 0 };
  assert.equal(applyGravity(near, [rocky]), rocky);
  assert.ok(near.vx < 0 && Math.abs(near.vy) < 1e-12);
  const far = { x: 3000 + rocky.range + 1, y: 3000, vx: 0, vy: 0 };
  assert.equal(applyGravity(far, [rocky]), null);
  assert.equal(far.vx, 0);
  const edge = fixedBody(0, 10, 500, 100, 1);
  const acrossSeam = { x: WORLD_SIZE - 150, y: 500, vx: 0, vy: 0 };
  applyGravity(acrossSeam, [edge]);
  assert.ok(acrossSeam.vx > 0, 'pulled the short way, across the wrap');
  const out = { x: 0, y: 0 };
  assert.equal(gravityAt(3300, 3000, [rocky], out), rocky);
  assert.ok(out.x < 0);
  assert.equal(gravityAt(9, 9, [rocky], out), null);
  assert.equal(dominantBody(3300, 3000, [rocky]), rocky);
  assert.ok(insideBody(3000 + 170, 3000, 16, [rocky]) && !insideBody(3000 + 180, 3000, 16, [rocky]));
});

test('bodies ride their orbits on rails: position and velocity are exact functions of time', () => {
  const period = 600;
  const p = orbitingBody(0, 4000, 4000, 900, period, 120, 1);
  const prev = { x: 0, y: 0 };
  for (const tick of [0, 1, 150, 299.5, 600, 12345]) {
    setPose(p, tick);
    assert.ok(Math.abs(Math.hypot(p.x - 4000, p.y - 4000) - 900) < 1e-6, 'on its circle');
    const speed = Math.hypot(p.vx, p.vy);
    assert.ok(Math.abs(speed - ((2 * Math.PI * 900) / period) * TICK_RATE) < 1e-6, 'moving at its orbital speed');
    assert.ok(Math.abs((p.x - 4000) * p.vx + (p.y - 4000) * p.vy) < 1e-6, 'tangentially');
  }
  setPose(p, 10);
  prev.x = p.x;
  prev.y = p.y;
  setPose(p, 11);
  const chordX = p.x - prev.x;
  const chordY = p.y - prev.y;
  setPose(p, 10.5);
  assert.ok(Math.abs(chordX - p.vx * TICK_DT) < 1e-3 && Math.abs(chordY - p.vy * TICK_DT) < 1e-3, 'velocity matches the motion between ticks');
  setPose(p, period * 3);
  const start = { x: p.x, y: p.y };
  setPose(p, 0);
  assert.ok(Math.abs(p.x - start.x) < 1e-6 && Math.abs(p.y - start.y) < 1e-6, 'periodic');

  // poseBodies poses reusable copies and leaves the originals alone.
  const out = [];
  setPose(p, 0);
  const [copy] = poseBodies([p], 300, out);
  assert.notEqual(copy, p);
  assert.ok(Math.abs(copy.x - p.x) > 100, 'the copy moved half an orbit');
  assert.equal(poseBodies([p], 301, out)[0], copy, 'copies are reused');
  assert.equal(copy.id, p.id);
});

test('surface contact: gentle touchdowns settle, fast impacts bounce and report their speed', () => {
  const soft = { x: 3000 + 160 + 15, y: 3000, vx: -30, vy: 0 };
  const softImpact = collideBodies(soft, 16, [rocky], hit);
  assert.ok(softImpact > 0 && softImpact < GRAVITY.landingSpeed);
  assert.equal(hit.body, rocky);
  assert.equal(soft.vx, 0, 'landed');
  assert.ok(Math.hypot(soft.x - 3000, soft.y - 3000) >= 160 + 16 - 1e-9, 'pushed out of the surface');
  const hard = { x: 3000 + 160 + 10, y: 3000, vx: -400, vy: 0 };
  assert.equal(collideBodies(hard, 16, [rocky], hit), 400);
  assert.ok(Math.abs(hard.vx - 400 * GRAVITY.bounce) < 1e-9, 'bounced');
  const clear = { x: 3500, y: 3000, vx: -400, vy: 0 };
  assert.equal(collideBodies(clear, 16, [rocky], hit), 0);
  assert.equal(hit.body, null);
});

test('contact works in the moving body’s frame: something resting on a planet rides along', () => {
  const p = orbitingBody(0, 4000, 4000, 1500, 9000, 150, 1.2);
  setPose(p, 0);
  // Resting on the trailing side, moving with the planet: no impact, stays put relative to it.
  const ux = -p.vx / Math.hypot(p.vx, p.vy);
  const uy = -p.vy / Math.hypot(p.vx, p.vy);
  const s = { x: p.x + ux * 166, y: p.y + uy * 166, vx: p.vx, vy: p.vy };
  for (let tick = 1; tick <= 600; tick++) {
    setPose(p, tick);
    applyGravity(s, [p]);
    s.x += s.vx * TICK_DT;
    s.y += s.vy * TICK_DT;
    collideBodies(s, 16, [p], hit);
    assert.ok(hit.impact < GRAVITY.landingSpeed, 'never a crash, just resting contact');
  }
  assert.ok(Math.abs(Math.hypot(s.x - p.x, s.y - p.y) - 166) < 0.5, 'still on the surface after the planet moved on');
  assert.ok(Math.hypot(s.vx - p.vx, s.vy - p.vy) < 12, 'moving with the planet');
});

test('circular orbits keep their radius and match the pull, around moving planets too', () => {
  const r = 260;
  const orbit = { planet: 0, radius: r, phase: 1, epoch: 100, dir: -1, omega: orbitAngularSpeed(rocky, r) };
  const s = { x: 0, y: 0, vx: 0, vy: 0 };
  for (const tick of [100, 137.5, 5000]) {
    orbitState(rocky, orbit, tick, s);
    assert.ok(Math.abs(Math.hypot(s.x - 3000, s.y - 3000) - r) < 1e-6);
    const speed = Math.hypot(s.vx, s.vy);
    assert.ok(Math.abs((speed * speed) / r - pullAt(rocky, r)) < 1e-6, 'v²/r equals the pull');
  }
  const mover = orbitingBody(0, 4000, 4000, 1200, 6000, 150, 1.2);
  setPose(mover, 777);
  orbitState(mover, orbit, 777, s);
  assert.ok(Math.abs(Math.hypot(s.x - mover.x, s.y - mover.y) - r) < 1e-6, 'centred on the moving planet');
  const rvx = s.vx - mover.vx;
  const rvy = s.vy - mover.vy;
  assert.ok(Math.abs(Math.hypot(rvx, rvy) - orbit.omega * r) < 1e-6, 'its velocity includes the planet’s');
});

test('loose rocks in a well spiral in (orbital decay) and crash', () => {
  const r = 300;
  const v = Math.sqrt(pullAt(rocky, r) * r); // circular speed
  const rock = { x: 3000 + r, y: 3000, vx: 0, vy: v };
  let ticks = 0;
  while (Math.hypot(rock.x - 3000, rock.y - 3000) > rocky.radius && ticks < TICK_RATE * 120) {
    stepBallistic(rock, [rocky]);
    ticks++;
  }
  assert.ok(ticks < TICK_RATE * 120, 'reached the surface');
  assert.ok(ticks > TICK_RATE * 2, 'but only after orbiting for a while');
});

test('orbital decay is relative to the planet: a rock travelling with it is not slowed down', () => {
  const p = orbitingBody(0, 4000, 4000, 1500, 9000, 150, 1.2);
  setPose(p, 0);
  const rock = { x: p.x + p.range * 0.9, y: p.y, vx: p.vx, vy: p.vy };
  stepBallistic(rock, [p]);
  const gained = Math.hypot(rock.vx - p.vx, rock.vy - p.vy);
  assert.ok(gained <= pullAt(p, p.range * 0.9) * TICK_DT + 1e-9, 'only gravity changed its velocity, not drag');
});

test('describeOrbit tells stable orbits from crashes and escapes', () => {
  const out = { state: '', periapsis: 0, apoapsis: 0 };
  const r = 280;
  const v = Math.sqrt(rocky.gm / r); // Kepler circular speed
  describeOrbit(3000 + r, 3000, 0, v, rocky, 46, out);
  assert.equal(out.state, OrbitState.STABLE);
  assert.ok(Math.abs(out.periapsis - r) < 1e-3 && Math.abs(out.apoapsis - r) < 1e-3);
  describeOrbit(3000 + r, 3000, 0, v * 0.4, rocky, 46, out);
  assert.equal(out.state, OrbitState.IMPACT);
  describeOrbit(3000 + r, 3000, 0, v * 1.5, rocky, 46, out);
  assert.equal(out.state, OrbitState.ESCAPE);
  // Relative to a moving planet, the same relative motion gives the same answer.
  const mover = orbitingBody(0, 4000, 4000, 1500, 9000, 160, 1);
  setPose(mover, 4321);
  describeOrbit(mover.x + r, mover.y, mover.vx, mover.vy + v, mover, 46, out);
  assert.equal(out.state, OrbitState.STABLE);
});
