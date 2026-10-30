import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TAU,
  angleDiff,
  createRng,
  interceptTime,
  normalizeAngle,
  segmentCircleHit,
  wrap,
  wrapDelta,
  wrapLerp,
} from '../shared/math.js';

test('wrap keeps coordinates inside [0, size)', () => {
  assert.equal(wrap(5, 100), 5);
  assert.equal(wrap(105, 100), 5);
  assert.equal(wrap(-5, 100), 95);
  assert.equal(wrap(-205, 100), 95);
  assert.equal(wrap(100, 100), 0);
  const tiny = wrap(-1e-17, 100);
  assert.ok(tiny >= 0 && tiny < 100, 'tiny negatives must not round up to size');
});

test('wrapDelta returns the shortest offset across the seam', () => {
  assert.equal(wrapDelta(10, 100), 10);
  assert.equal(wrapDelta(90, 100), -10);
  assert.equal(wrapDelta(-90, 100), 10);
  assert.equal(wrapDelta(250, 100), -50);
  assert.equal(wrapLerp(95, 5, 0.5, 100), 0);
});

test('angles normalise and diff along the shortest arc', () => {
  assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - 1.5 * Math.PI) < 1e-12);
  assert.ok(normalizeAngle(TAU) < TAU);
  assert.ok(Math.abs(angleDiff(0.1, TAU - 0.1) - 0.2) < 1e-12);
  assert.ok(Math.abs(angleDiff(TAU - 0.1, 0.1) + 0.2) < 1e-12);
});

test('segmentCircleHit finds the first contact, including across the seam', () => {
  // Moving right along y=0 towards a circle at x=50, r=10: contact at x=40.
  assert.ok(Math.abs(segmentCircleHit(0, 0, 100, 0, 50, 0, 10, 1000) - 0.4) < 1e-12);
  assert.equal(segmentCircleHit(0, 0, 100, 0, 50, 30, 10, 1000), -1, 'passes above');
  assert.equal(segmentCircleHit(0, 0, -100, 0, 50, 0, 10, 1000), -1, 'moving away');
  assert.equal(segmentCircleHit(48, 0, 1, 0, 50, 0, 10, 1000), 0, 'starts inside');
  // Across the wrap seam: from x=990 moving +20 hits a circle centred at x=5.
  assert.ok(segmentCircleHit(990, 0, 20, 0, 5, 0, 2, 1000) > 0);
  // A graze that falls between sampled endpoints is still caught.
  assert.ok(segmentCircleHit(0, 0, 40, 0, 20, 9, 10, 1000) > 0);
});

test('interceptTime leads a moving target', () => {
  const t = interceptTime(100, 0, 0, 50, 100); // target moving perpendicular
  assert.ok(t > 0);
  const hitX = 100;
  const hitY = 50 * t;
  assert.ok(Math.abs(Math.hypot(hitX, hitY) - 100 * t) < 1e-9);
  assert.equal(interceptTime(100, 0, 200, 0, 100), -1, 'target too fast to catch');
});

test('createRng is deterministic per seed', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const c = createRng(43);
  assert.notEqual(createRng(42)(), c());
});
