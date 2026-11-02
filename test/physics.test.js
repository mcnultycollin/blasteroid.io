import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUTTON_MASK, BodyKind, Button, TICK_DT, TICK_RATE, WORLD_SIZE } from '../shared/constants.js';
import { applyGravity, poseBodies, pullAt, setPose } from '../shared/gravity.js';
import { createRng } from '../shared/math.js';
import { LOCK_CLEARANCE, StepResult, computeShots, copyShipState, createShipState, stepShip } from '../shared/physics.js';
import { dqAngle, qAngle } from '../shared/protocol.js';
import { CLASSES, STAT_COUNT, ShipClass, Stat, Weapon, deriveStats } from '../shared/stats.js';
import { fixedBody, orbitingBody } from './helpers.js';

const levels = new Uint8Array(STAT_COUNT);
const st = deriveStats(levels, Weapon.BLASTER, false, false);
const speed = (s) => Math.hypot(s.vx, s.vy);

function freshShip(x = 1000, y = 1000) {
  const s = createShipState();
  s.x = x;
  s.y = y;
  s.energy = st.energyMax;
  s.fuel = st.fuelMax;
  return s;
}

/* Flight -------------------------------------------------------------------- */

test('engines off in open space: a fast ship slows to its coast speed, then holds it', () => {
  const s = freshShip();
  s.vx = 300;
  s.vy = -300;
  stepShip(s, 0, 0, st);
  assert.ok(speed(s) < Math.hypot(300, 300), 'slowing');
  for (let i = 0; i < TICK_RATE * 10; i++) stepShip(s, 0, 0, st);
  assert.ok(Math.abs(speed(s) - st.coastSpeed) < 1e-6, `coasting at ${speed(s).toFixed(1)}`);
  assert.ok(Math.abs(s.vx + s.vy) < 1e-9, 'without changing direction');
  const slow = freshShip();
  slow.vx = st.coastSpeed * 0.5;
  for (let i = 0; i < TICK_RATE * 5; i++) stepShip(slow, 0, 0, st);
  assert.equal(slow.vx, st.coastSpeed * 0.5, 'below the coast speed nothing slows it');
  const braking = freshShip();
  braking.vx = 400;
  stepShip(braking, Button.BRAKE, 0, st);
  assert.ok(braking.vx < 400 - st.brakeAccel * TICK_DT + 1e-9, 'the brake works on top');
});

test('inside a gravity well there is no coasting drag: only gravity changes the motion', () => {
  const planet = fixedBody(0, 3000, 3000, 140, 1);
  const s = freshShip(3000 + 260, 3000);
  s.vy = 600; // far above the coast speed
  const manual = { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
  for (let i = 0; i < 30; i++) {
    stepShip(s, 0, 0, st, [planet]);
    applyGravity(manual, [planet]);
    manual.x += manual.vx * TICK_DT;
    manual.y += manual.vy * TICK_DT;
  }
  assert.equal(s.vx, manual.vx);
  assert.equal(s.vy, manual.vy);
});

test('thrusters push up to cruise speed and no further; boost goes faster', () => {
  const s = freshShip();
  for (let i = 0; i < TICK_RATE * 5; i++) stepShip(s, Button.THRUST, 0, st);
  assert.ok(Math.abs(s.vx - st.maxSpeed) < 1e-9 && Math.abs(s.vy) < 1e-9, `capped at cruise speed (${s.vx})`);
  for (let i = 0; i < 40; i++) stepShip(s, Button.BOOST, 0, st);
  assert.ok(s.vx > st.maxSpeed * 1.2 && s.vx <= st.boostSpeed + 1e-9, 'boost raises the cap');
  const boosted = s.vx;
  for (let i = 0; i < TICK_RATE; i++) stepShip(s, Button.THRUST, 0, st);
  assert.ok(Math.abs(s.vx - boosted) < 1e-9, 'thrusting after a boost keeps the speed instead of braking to cruise');
});

test('at full speed the thrusters still steer: the heading changes, the speed does not grow', () => {
  const s = freshShip();
  s.vx = st.maxSpeed;
  for (let i = 0; i < TICK_RATE; i++) stepShip(s, Button.STRAFE_RIGHT, 0, st);
  assert.ok(s.vy > 100, 'pushed towards the ship’s right (+y when facing +x)');
  assert.ok(speed(s) <= st.maxSpeed + 1e-9);
});

test('screen-direction thrusters push up, down, left and right whatever the heading', () => {
  const k = st.thrust * st.moveThrust * TICK_DT;
  for (const angle of [0, 1.1, 2.9, -2]) {
    const push = (buttons) => {
      const s = freshShip();
      s.angle = angle;
      stepShip(s, buttons, 0, st);
      return [s.vx, s.vy];
    };
    const [ux, uy] = push(Button.MOVE_UP);
    assert.ok(Math.abs(ux) < 1e-9 && Math.abs(uy + k) < 1e-9, 'up is up on screen (-y)');
    const [rx, ry] = push(Button.MOVE_RIGHT);
    assert.ok(Math.abs(rx - k) < 1e-9 && Math.abs(ry) < 1e-9, 'right is right');
    const [dx, dy] = push(Button.MOVE_DOWN | Button.MOVE_LEFT);
    assert.ok(Math.abs(dx + k / Math.SQRT2) < 1e-9 && Math.abs(dy - k / Math.SQRT2) < 1e-9, 'diagonals are no stronger');
    const [nx, ny] = push(Button.MOVE_UP | Button.MOVE_DOWN);
    assert.ok(nx === 0 && ny === 0, 'opposites cancel');
  }
});

test('ship-frame thrusters (W, S, A, D in ship mode) push relative to the nose', () => {
  const angle = 0.7;
  const push = (buttons) => {
    const s = freshShip();
    s.angle = angle;
    stepShip(s, buttons, 0, st);
    return [s.vx / TICK_DT, s.vy / TICK_DT];
  };
  const [fx, fy] = push(Button.THRUST);
  assert.ok(Math.abs(fx - Math.cos(angle) * st.thrust) < 1e-6 && Math.abs(fy - Math.sin(angle) * st.thrust) < 1e-6);
  const [bx, by] = push(Button.BACK);
  assert.ok(Math.abs(bx + Math.cos(angle) * st.thrust * st.backThrust) < 1e-6);
  assert.ok(Math.abs(by + Math.sin(angle) * st.thrust * st.backThrust) < 1e-6);
  const [rx, ry] = push(Button.STRAFE_RIGHT);
  assert.ok(Math.abs(rx + Math.sin(angle) * st.thrust * st.strafeThrust) < 1e-6);
  assert.ok(Math.abs(ry - Math.cos(angle) * st.thrust * st.strafeThrust) < 1e-6);
  const [lx, ly] = push(Button.STRAFE_LEFT);
  assert.ok(Math.abs(lx + rx) < 1e-6 && Math.abs(ly + ry) < 1e-6, 'left mirrors right');
  const [cx, cy] = push(Button.THRUST | Button.STRAFE_RIGHT);
  assert.ok(Math.abs(cx - (fx + rx)) < 1e-6 && Math.abs(cy - (fy + ry)) < 1e-6, 'thrusters combine');
  const s = freshShip();
  s.angle = angle;
  assert.ok(stepShip(s, Button.STRAFE_LEFT, 0, st) & StepResult.THRUST, 'lateral thrust is reported for effects');
});

test('the retro brake stops a drifting ship and never pushes it backwards', () => {
  const s = freshShip();
  s.vx = 300;
  s.vy = -200;
  let ticks = 0;
  while (speed(s) > 0 && ticks < TICK_RATE * 5) {
    assert.ok(stepShip(s, Button.BRAKE, 0, st) & StepResult.BRAKE);
    ticks++;
  }
  assert.equal(speed(s), 0);
  assert.ok(ticks <= Math.ceil(Math.hypot(300, 200) / (st.brakeAccel * TICK_DT)) + 1);
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

/* Weapons and the kinetic blast ------------------------------------------- */

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
  assert.ok(Math.abs(out[0].x - (1000 + st.nose)) < 1e-9);
  assert.ok(Math.abs(out[0].vx - (100 + st.bulletSpeed)) < 1e-9);
  assert.equal(computeShots(s, Weapon.TWIN, st, out), 2);
  assert.ok(out[0].y < s.y && out[1].y > s.y, 'twin muzzles sit either side of the nose');
  assert.equal(computeShots(s, Weapon.SCATTER, st, out), 3);
});

test('the kinetic blast costs energy, has a cooldown and kicks the ship backwards', () => {
  const s = freshShip();
  s.angle = Math.PI / 2;
  assert.ok(stepShip(s, Button.BLAST, 0, st) & StepResult.BLAST);
  assert.equal(s.energy, st.energyMax - st.blastCost);
  assert.ok(Math.abs(s.vy + st.blastRecoil) < 1e-9, 'recoil opposite the nose');
  let blasts = 1;
  for (let i = 0; i < st.blastInterval * 3; i++) if (stepShip(s, Button.BLAST, 0, st) & StepResult.BLAST) blasts++;
  assert.equal(blasts, 4, 'one blast per interval while held');
  const drained = freshShip();
  drained.energy = st.blastCost - st.energyRegen - 1; // energy recharges before the blast is checked
  assert.equal(stepShip(drained, Button.BLAST, 0, st) & StepResult.BLAST, 0, 'not without the energy');
});

/* Orbit lock ------------------------------------------------------------------ */

const lockPlanet = () => orbitingBody(0, 4000, 4000, 1600, 15000, 140, 1.2);

function inOrbit(planet, tick, r) {
  setPose(planet, tick);
  const s = freshShip(planet.x + r, planet.y);
  const v = Math.sqrt(pullAt(planet, r) * r);
  s.vx = planet.vx;
  s.vy = planet.vy + v;
  return s;
}

test('L locks into a circular orbit that follows the moving planet exactly', () => {
  const planet = lockPlanet();
  const posed = [];
  const s = inOrbit(planet, 100, 300);
  const result = stepShip(s, Button.LOCK, 0, st, poseBodies([planet], 101, posed), 101);
  assert.ok(result & StepResult.LOCKED);
  assert.equal(s.lockBody, 0);
  assert.equal(s.lockDir, 1, 'keeps its direction around the planet');
  for (let tick = 102; tick < 102 + TICK_RATE * 10; tick++) {
    stepShip(s, 0, 0, st, poseBodies([planet], tick, posed), tick);
    const p = posed[0];
    assert.ok(Math.abs(Math.hypot(s.x - p.x, s.y - p.y) - s.lockRadius) < 1e-6, 'exactly on the locked orbit');
  }
  const p = posed[0];
  const relSpeed = Math.hypot(s.vx - p.vx, s.vy - p.vy);
  assert.ok(Math.abs(relSpeed - s.lockOmega * s.lockRadius) < 1e-6, 'moving at orbital speed relative to the planet');
});

test('the lock releases on L, on any thruster, brake or blast, and fails outside every well', () => {
  const planet = lockPlanet();
  const posed = [];
  for (const breaker of [Button.LOCK, Button.THRUST, Button.BACK, Button.STRAFE_LEFT, Button.BRAKE, Button.BLAST]) {
    const s = inOrbit(planet, 0, 300);
    stepShip(s, Button.LOCK, 0, st, poseBodies([planet], 1, posed), 1);
    assert.equal(s.lockBody, 0);
    assert.ok(stepShip(s, breaker, 0, st, poseBodies([planet], 2, posed), 2) & StepResult.UNLOCKED, `released by ${breaker}`);
    assert.equal(s.lockBody, -1);
  }
  const far = freshShip(100, 100);
  assert.ok(stepShip(far, Button.LOCK, 0, st, poseBodies([planet], 1, posed), 1) & StepResult.LOCK_FAILED);
  assert.equal(far.lockBody, -1);
});

test('locking too close to the surface lifts the ship to a safe altitude', () => {
  const star = fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR);
  const s = freshShip(4000 + 200 + st.radius + 2, 4000);
  stepShip(s, Button.LOCK, 0, st, [star], 0);
  assert.equal(s.lockRadius, 200 + st.radius + LOCK_CLEARANCE);
  assert.ok(Math.abs(Math.hypot(s.x - 4000, s.y - 4000) - s.lockRadius) < 1e-9);
});

/* Prediction ------------------------------------------------------------------ */

function randomCommands(seed, count) {
  const rng = createRng(seed);
  const commands = [];
  for (let i = 0; i < count; i++) {
    // Mostly coasting with bursts of input; every button shows up, the lock toggle now and then.
    let buttons = rng() < 0.4 ? 0 : Math.floor(rng() * (BUTTON_MASK + 1)) & ~(Button.LOCK | Button.ABILITY);
    if (rng() < 0.02) buttons |= Button.LOCK;
    if (rng() < 0.01) buttons |= Button.ABILITY;
    commands.push({ buttons, aim: dqAngle(qAngle(rng() * Math.PI * 2)) });
  }
  return commands;
}

test('prediction replay from an acknowledged state reproduces the authority exactly', () => {
  const commands = randomCommands(7, 600);
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

test('moving planets, landings and orbit locks are predicted exactly at command time', () => {
  // The server runs command `seq` at tick seq + offset with bodies posed for
  // that tick; the client does the same with its own copies.
  const star = fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR);
  const planet = orbitingBody(1, 4000, 4000, 1400, 9000, 140, 2, 0.3);
  const bodies = [star, planet];
  const offset = 5000;
  const commands = randomCommands(99, 2400);
  const posed = [];
  setPose(planet, offset);
  const server = freshShip(planet.x + 200, planet.y);
  server.vx = planet.vx;
  server.vy = planet.vy;
  const client = copyShipState({}, server);
  const history = [];
  let impacts = 0;
  let locks = 0;
  commands.forEach((c, seq) => {
    const tick = seq + offset;
    const result = stepShip(server, c.buttons, c.aim, st, poseBodies(bodies, tick, posed), tick);
    if (result & StepResult.IMPACT) impacts++;
    if (result & StepResult.LOCKED) locks++;
    history.push(copyShipState({}, server));
    stepShip(client, c.buttons, c.aim, st, poseBodies(bodies, tick, posed), tick);
  });
  assert.ok(impacts > 0, 'the random walk touched a surface');
  assert.ok(locks > 0, 'and locked into orbit');
  for (const ack of [400, 1100, 2000]) {
    const replay = copyShipState({}, history[ack]);
    for (let seq = ack + 1; seq < commands.length; seq++) {
      stepShip(replay, commands[seq].buttons, commands[seq].aim, st, poseBodies(bodies, seq + offset, posed), seq + offset);
    }
    assert.deepEqual(replay, client, `replay from ack ${ack} matches`);
  }
});

test('an unpowered ship falls onto a moving planet and rides along on its surface', () => {
  const planet = orbitingBody(0, 4000, 4000, 1400, 9000, 140, 1);
  const posed = [];
  setPose(planet, 0);
  const s = freshShip(planet.x + 260, planet.y);
  s.vx = planet.vx;
  s.vy = planet.vy;
  let tick = 0;
  for (; tick < TICK_RATE * 8; tick++) stepShip(s, 0, 0, st, poseBodies([planet], tick, posed), tick);
  const height = () => Math.hypot(s.x - posed[0].x, s.y - posed[0].y) - 140;
  assert.ok(height() < st.radius + 1, `resting on the surface (height ${height().toFixed(2)})`);
  const start = { x: posed[0].x, y: posed[0].y };
  for (const end = tick + TICK_RATE * 5; tick < end; tick++) stepShip(s, 0, 0, st, poseBodies([planet], tick, posed), tick);
  assert.ok(Math.hypot(posed[0].x - start.x, posed[0].y - start.y) > 200, 'the planet travelled on');
  assert.ok(height() < st.radius + 1, 'and the ship stayed on it');
  assert.ok(Math.hypot(s.vx - posed[0].vx, s.vy - posed[0].vy) < 15, 'moving with it');
});

/* Muzzles and fuel ---------------------------------------------------------------- */

test('every class fires from the prow of its own hull', () => {
  for (let c = 0; c < CLASSES.length; c++) {
    const cst = deriveStats(levels, Weapon.BLASTER, false, false, {}, c);
    const s = freshShip();
    const out = [];
    computeShots(s, Weapon.BLASTER, cst, out);
    assert.equal(out[0].x, 1000 + CLASSES[c].nose, CLASSES[c].name);
    assert.ok(CLASSES[c].nose >= CLASSES[c].radius, `${CLASSES[c].name}: outside the hull's body`);
  }
});

test('thrusters burn integer fuel; coasting and turning are free', () => {
  const burn = (buttons) => {
    const s = freshShip();
    stepShip(s, buttons, 0, st);
    return st.fuelMax - s.fuel;
  };
  assert.equal(burn(0), 0);
  assert.equal(burn(Button.LEFT | Button.FIRE), 0, 'turning and firing cost no fuel');
  assert.equal(burn(Button.THRUST), st.fuelBurnMain);
  assert.equal(burn(Button.MOVE_UP | Button.MOVE_LEFT), st.fuelBurnMain, 'screen thrusters cost like the main engine');
  assert.equal(burn(Button.BOOST), st.fuelBurnBoost);
  assert.equal(burn(Button.STRAFE_LEFT | Button.BACK), st.fuelBurnThruster);
  assert.equal(burn(Button.BRAKE), st.fuelBurnBrake);
  assert.equal(burn(Button.THRUST | Button.STRAFE_RIGHT | Button.BRAKE), st.fuelBurnMain + st.fuelBurnThruster + st.fuelBurnBrake);
  let ticks = 0;
  const s = freshShip();
  while (s.fuel > 0) {
    stepShip(s, Button.THRUST, 0, st);
    ticks++;
  }
  assert.equal(ticks, Math.ceil(st.fuelMax / st.fuelBurnMain), 'the tank lasts as long as it should');
  assert.ok(st.fuelMax / st.fuelBurnMain / TICK_RATE > 15, 'over 15 s of main engine');
});

test('an empty tank leaves weak reserve thrusters and no boost', () => {
  const s = freshShip();
  s.fuel = 0;
  stepShip(s, Button.THRUST, 0, st);
  assert.ok(Math.abs(s.vx - st.thrust * st.reservePower * TICK_DT) < 1e-9, 'reserve power');
  const b = freshShip();
  b.fuel = 0;
  assert.equal(stepShip(b, Button.BOOST, 0, st) & StepResult.BOOST, 0, 'no boost without fuel');
  assert.equal(b.energy, st.energyMax, 'and no energy spent on it');
  const r = freshShip();
  r.fuel = 0;
  r.vx = 150; // below the coast speed, so only the brake slows it
  stepShip(r, Button.BRAKE, 0, st);
  assert.ok(Math.abs(r.vx - (150 - st.brakeAccel * st.reservePower * TICK_DT)) < 1e-9, 'the brake runs on reserve too');
});

test('resting on a planet refuels; the star does not', () => {
  const planet = fixedBody(0, 3000, 3000, 140, 1);
  const s = freshShip(3000 + 140 + st.radius + 1, 3000);
  s.fuel = 100;
  let result = 0;
  for (let i = 0; i < 10; i++) result = stepShip(s, 0, 0, st, [planet]);
  assert.ok(result & StepResult.REFUEL, 'reported for the HUD');
  assert.ok(s.fuel >= 100 + st.fuelRefuel * 5, `refuelled to ${s.fuel}`);
  for (let i = 0; i < TICK_RATE * 10; i++) stepShip(s, 0, 0, st, [planet]);
  assert.equal(s.fuel, st.fuelMax, 'up to a full tank');
  const star = fixedBody(0, 3000, 3000, 200, 0.64, BodyKind.STAR);
  const burning = freshShip(3000 + 200 + st.radius + 1, 3000);
  burning.fuel = 100;
  for (let i = 0; i < 10; i++) stepShip(burning, 0, 0, st, [star]);
  assert.equal(burning.fuel, 100);
});

test('the Breaker’s ram drive burns its own fuel-free charge', () => {
  const bst = deriveStats(levels, Weapon.BLASTER, false, false, {}, ShipClass.BREAKER);
  const s = freshShip();
  s.fuel = 500;
  stepShip(s, Button.ABILITY, 0, bst);
  for (let i = 0; i < 20; i++) stepShip(s, 0, 0, bst);
  assert.equal(s.fuel, 500);
  assert.ok(s.vx > bst.maxSpeed, 'still charging');
});

test('engine upgrades and heavier classes carry bigger tanks', () => {
  const upgraded = Uint8Array.from(levels);
  upgraded[Stat.ENGINE] = 5;
  assert.ok(deriveStats(upgraded, Weapon.BLASTER, false, false).fuelMax > st.fuelMax);
  assert.ok(deriveStats(levels, Weapon.BLASTER, false, false, {}, ShipClass.BREAKER).fuelMax > st.fuelMax);
});
