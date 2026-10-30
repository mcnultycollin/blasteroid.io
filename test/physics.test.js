import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Button, SHIP_NOSE, TICK_RATE, WORLD_SIZE } from '../shared/constants.js';
import { createRng } from '../shared/math.js';
import { StepResult, computeShots, copyShipState, createShipState, stepShip } from '../shared/physics.js';
import { dqAngle, qAngle } from '../shared/protocol.js';
import { STAT_COUNT, Stat, Weapon, deriveStats } from '../shared/stats.js';

const levels = new Uint8Array(STAT_COUNT);
const st = deriveStats(levels, Weapon.BLASTER, false, false);

function freshShip() {
  const s = createShipState();
  s.x = 1000;
  s.y = 1000;
  s.energy = st.energyMax;
  return s;
}

test('thrust accelerates along the heading and drag caps speed', () => {
  const s = freshShip();
  for (let i = 0; i < TICK_RATE * 10; i++) stepShip(s, Button.THRUST, 0, st);
  assert.ok(s.vx > 0 && Math.abs(s.vy) < 1e-9);
  const terminal = st.thrust / 1.2; // thrust / drag
  assert.ok(Math.abs(s.vx - terminal) / terminal < 0.02, `speed ${s.vx} near terminal ${terminal}`);
});

test('aim turns towards the target at the turn rate, never overshooting', () => {
  const s = freshShip();
  stepShip(s, Button.AIM, Math.PI / 2, st);
  assert.ok(Math.abs(s.angle - st.turnRate / TICK_RATE) < 1e-12);
  for (let i = 0; i < TICK_RATE; i++) stepShip(s, Button.AIM, Math.PI / 2, st);
  assert.ok(Math.abs(s.angle - Math.PI / 2) < 1e-12);
});

test('position wraps around the world', () => {
  const s = freshShip();
  s.x = WORLD_SIZE - 1;
  s.vx = 600;
  stepShip(s, 0, 0, st);
  assert.ok(s.x >= 0 && s.x < 20);
});

test('boost drains integer energy, locks when empty and unlocks at 25%', () => {
  const s = freshShip();
  let ticks = 0;
  while (!s.boostLock) {
    assert.ok(stepShip(s, Button.BOOST, 0, st) & StepResult.BOOST);
    ticks++;
  }
  assert.equal(ticks, st.energyMax / st.boostDrain);
  assert.equal(s.energy, 0);
  assert.equal(stepShip(s, Button.BOOST, 0, st) & StepResult.BOOST, 0, 'locked out');
  while (s.boostLock) stepShip(s, Button.BOOST, 0, st);
  assert.ok(s.energy >= st.boostUnlock && Number.isInteger(s.energy));
});

test('fire respects the integer cooldown', () => {
  const s = freshShip();
  const shots = [];
  for (let i = 0; i < st.fireInterval * 5; i++) {
    if (stepShip(s, Button.FIRE, 0, st) & StepResult.FIRED) shots.push(i);
  }
  assert.equal(shots.length, 5);
  assert.equal(shots[1] - shots[0], st.fireInterval);
});

test('rapid fire and reload upgrades shorten the interval', () => {
  const upgraded = Uint8Array.from(levels);
  upgraded[Stat.RELOAD] = 7;
  const fast = deriveStats(upgraded, Weapon.BLASTER, true, false);
  assert.ok(fast.fireInterval < st.fireInterval / 2);
  assert.ok(fast.fireInterval >= 3);
});

test('computeShots places projectiles at the muzzle with inherited velocity', () => {
  const s = freshShip();
  s.vx = 100;
  const out = [];
  assert.equal(computeShots(s, Weapon.BLASTER, st, out), 1);
  assert.ok(Math.abs(out[0].x - (1000 + SHIP_NOSE)) < 1e-9);
  assert.ok(Math.abs(out[0].vx - (100 + st.bulletSpeed)) < 1e-9);
  assert.equal(computeShots(s, Weapon.TWIN, st, out), 2);
  assert.ok(out[0].y < s.y && out[1].y > s.y, 'twin muzzles sit either side of the nose');
  assert.equal(computeShots(s, Weapon.SCATTER, st, out), 3);
});

test('prediction replay from an acknowledged state reproduces the authority exactly', () => {
  // The server and client run the same commands; the client rewinds to the
  // server's state at an acknowledged command and replays the rest.
  const rng = createRng(7);
  const commands = [];
  for (let i = 0; i < 600; i++) {
    const buttons = Math.floor(rng() * 128);
    commands.push({ buttons, aim: dqAngle(qAngle(rng() * Math.PI * 2)) });
  }
  const server = freshShip();
  const client = freshShip();
  const history = [];
  for (const c of commands) {
    stepShip(server, c.buttons, c.aim, st);
    history.push(copyShipState({}, server));
    stepShip(client, c.buttons, c.aim, st);
  }
  for (const ack of [0, 99, 333, 598]) {
    const replay = copyShipState({}, history[ack]);
    for (let i = ack + 1; i < commands.length; i++) stepShip(replay, commands[i].buttons, commands[i].aim, st);
    assert.deepEqual(replay, client, `replay from ack ${ack} matches`);
  }
});
