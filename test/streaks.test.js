import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_ID } from '../shared/protocol.js';
import { MULTI_WINDOW_MS, STREAK_NAMES, StreakTracker } from '../client/streaks.js';

test('streaks count kills since the last death; multi-kills need quick succession', () => {
  const t = new StreakTracker();
  assert.deepEqual(t.record(1, 2, 0), { streak: 1, multi: 1, ended: 0 });
  assert.deepEqual(t.record(1, 3, 1000), { streak: 2, multi: 2, ended: 0 });
  assert.deepEqual(t.record(1, 4, 1000 + MULTI_WINDOW_MS + 1), { streak: 3, multi: 1, ended: 0 });
  assert.ok(STREAK_NAMES.has(3), 'three in a row is worth a call-out');
  assert.deepEqual(t.record(5, 1, 9000), { streak: 1, multi: 1, ended: 3 }, 'dying ends the streak');
  assert.deepEqual(t.record(5, 1, 9500).ended, 0);
});

test('deaths without a pilot killer still end streaks, and suicides count for nothing', () => {
  const t = new StreakTracker();
  t.record(1, 2, 0);
  t.record(1, 3, 10);
  assert.deepEqual(t.record(NO_ID, 1, 20), { streak: 0, multi: 0, ended: 2 });
  assert.deepEqual(t.record(4, 4, 30), { streak: 0, multi: 0, ended: 0 });
  t.record(6, 7, 40);
  t.forget(6);
  assert.equal(t.record(6, 8, 50).streak, 1, 'forgotten players start over');
  t.record(6, 9, 60);
  t.clear();
  assert.equal(t.record(6, 10, 70).streak, 1, 'a new connection starts every streak afresh');
});
