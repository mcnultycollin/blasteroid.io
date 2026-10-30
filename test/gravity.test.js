import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICK_RATE } from '../shared/constants.js';
import {
  GRAVITY,
  applyGravity,
  collidePlanets,
  createPlanet,
  gravityAt,
  orbitAngularSpeed,
  orbitState,
  pullAt,
  stepBallistic,
} from '../shared/gravity.js';

const rocky = createPlanet(0, 3000, 3000, 160, 1, 'Rocky');

test('mass comes from size and density: a small dense planet out-pulls a big light one at the surface', () => {
  const giant = createPlanet(0, 0, 0, 240, 0.5, 'Giant');
  const dense = createPlanet(1, 0, 0, 85, 3.5, 'Dense');
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

test('applyGravity pulls towards the planet only within range, across the world seam too', () => {
  const near = { x: 3000 + 300, y: 3000, vx: 0, vy: 0 };
  assert.ok(applyGravity(near, [rocky]));
  assert.ok(near.vx < 0 && Math.abs(near.vy) < 1e-12);
  const far = { x: 3000 + rocky.range + 1, y: 3000, vx: 0, vy: 0 };
  assert.equal(applyGravity(far, [rocky]), false);
  assert.equal(far.vx, 0);
  const edgePlanet = createPlanet(0, 10, 500, 100, 1, 'Edge');
  const acrossSeam = { x: 6144 - 150, y: 500, vx: 0, vy: 0 };
  applyGravity(acrossSeam, [edgePlanet]);
  assert.ok(acrossSeam.vx > 0, 'pulled the short way, across the wrap');
  const out = { x: 0, y: 0 };
  assert.equal(gravityAt(3300, 3000, [rocky], out), rocky);
  assert.ok(out.x < 0);
  assert.equal(gravityAt(9, 9, [rocky], out), null);
});

test('surface contact: gentle touchdowns settle, fast impacts bounce and report their speed', () => {
  const soft = { x: 3000 + 160 + 15, y: 3000, vx: -30, vy: 0 };
  const softImpact = collidePlanets(soft, 16, [rocky]);
  assert.ok(softImpact > 0 && softImpact < GRAVITY.landingSpeed);
  assert.equal(soft.vx, 0, 'landed');
  assert.ok(Math.hypot(soft.x - 3000, soft.y - 3000) >= 160 + 16 - 1e-9, 'pushed out of the surface');
  const hard = { x: 3000 + 160 + 10, y: 3000, vx: -400, vy: 0 };
  assert.equal(collidePlanets(hard, 16, [rocky]), 400);
  assert.ok(Math.abs(hard.vx - 400 * GRAVITY.bounce) < 1e-9, 'bounced');
});

test('circular orbits keep their radius and match the pull', () => {
  const r = 260;
  const orbit = { planet: 0, radius: r, phase: 1, epoch: 100, dir: -1, omega: orbitAngularSpeed(rocky, r) };
  const s = { x: 0, y: 0, vx: 0, vy: 0 };
  for (const tick of [100, 137.5, 5000]) {
    orbitState(rocky, orbit, tick, s);
    assert.ok(Math.abs(Math.hypot(s.x - 3000, s.y - 3000) - r) < 1e-6);
    const speed = Math.hypot(s.vx, s.vy);
    assert.ok(Math.abs((speed * speed) / r - pullAt(rocky, r)) < 1e-6, 'v²/r equals the pull');
  }
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
