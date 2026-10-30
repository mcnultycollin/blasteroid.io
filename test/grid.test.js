import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpatialGrid } from '../server/game/SpatialGrid.js';

const entity = (x, y, radius, mask = 1) => ({ x, y, radius, mask, dead: false, _q: 0 });

test('finds overlapping entities and filters by mask', () => {
  const grid = new SpatialGrid(1024, 64);
  const a = entity(100, 100, 10, 1);
  const b = entity(110, 100, 10, 2);
  const far = entity(600, 600, 10, 1);
  for (const e of [a, b, far]) grid.insert(e);
  assert.deepEqual(grid.query(100, 100, 20, 20, 1 | 2, []).sort((p, q) => p.x - q.x), [a, b]);
  assert.deepEqual(grid.query(100, 100, 20, 20, 2, []), [b]);
});

test('queries wrap across the world seam', () => {
  const grid = new SpatialGrid(1024, 64);
  const nearRightEdge = entity(1020, 500, 8);
  grid.insert(nearRightEdge);
  assert.deepEqual(grid.query(2, 500, 16, 16, 1, []), [nearRightEdge]);
  const straddling = entity(1, 1, 20); // spills into all four corners
  grid.insert(straddling);
  assert.ok(grid.query(1015, 1015, 10, 10, 1, []).includes(straddling));
});

test('large entities appear once per query and dead ones are skipped', () => {
  const grid = new SpatialGrid(1024, 64);
  const big = entity(500, 500, 150);
  const dead = entity(500, 500, 5);
  dead.dead = true;
  grid.insert(big);
  grid.insert(dead);
  assert.deepEqual(grid.query(500, 500, 300, 300, 1, []), [big]);
  grid.clear();
  assert.deepEqual(grid.query(500, 500, 300, 300, 1, []), []);
});

test('rejects a world size that is not a multiple of the cell size', () => {
  assert.throws(() => new SpatialGrid(1000, 64));
});
