import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BodyKind, Button, NO_TEAM, Perk, TICK_DT, TICK_RATE } from '../shared/constants.js';
import { createField, fieldsAt, poseBodies } from '../shared/gravity.js';
import { StepResult, createShipState, stepShip } from '../shared/physics.js';
import { Ability, CLASSES, SINGULARITY, STAT_COUNT, ShipClass, Weapon, deriveStats } from '../shared/stats.js';
import { exposedToFlare, nebulaAt, nightSide } from '../shared/terrain.js';
import { fixedBody, orbitingBody } from './helpers.js';

const levels = new Uint8Array(STAT_COUNT);
const statsFor = (shipClass, perks = 0) => deriveStats(levels, Weapon.BLASTER, false, false, {}, shipClass, perks);
const speed = (s) => Math.hypot(s.vx, s.vy);

function ship(st, x = 1000, y = 1000) {
  const s = createShipState();
  s.x = x;
  s.y = y;
  s.energy = st.energyMax;
  return s;
}

/* Classes and perks ---------------------------------------------------------- */

test('each class has its own hull, handling and ability; the Fighter is the original ship', () => {
  const fighter = statsFor(ShipClass.FIGHTER);
  const original = deriveStats(levels, Weapon.BLASTER, false, false);
  for (const key of ['maxHp', 'thrust', 'maxSpeed', 'turnRate', 'damage', 'fireInterval', 'radius']) {
    assert.equal(fighter[key], original[key], `fighter ${key} unchanged`);
  }
  const breaker = statsFor(ShipClass.BREAKER);
  const medic = statsFor(ShipClass.MEDIC);
  const graviton = statsFor(ShipClass.GRAVITON);
  assert.ok(breaker.maxHp > fighter.maxHp && breaker.radius > fighter.radius && breaker.mass > fighter.mass, 'the Breaker is big and heavy');
  assert.ok(breaker.rushSpeed > breaker.maxSpeed * 1.5, 'its ram drive lifts the speed limit');
  assert.ok(medic.damage < fighter.damage && medic.regen > fighter.regen, 'the Medic trades firepower for repairs');
  assert.ok(graviton.maxHp > fighter.maxHp && graviton.maxSpeed < fighter.maxSpeed);
  assert.deepEqual([fighter, breaker, medic, graviton].map((st) => st.ability), [Ability.DASH, Ability.RAM, Ability.PULSE, Ability.SINGULARITY]);
  assert.equal(statsFor(99).shipClass, ShipClass.FIGHTER, 'unknown classes fall back to the Fighter');
  for (const c of CLASSES) assert.ok(c.ability.cost <= 600 && c.ability.cooldown > 0, `${c.name} ability is affordable`);
});

test('team perks: the Forge adds damage, the Refinery speeds up recharge in whole units', () => {
  const plain = statsFor(ShipClass.FIGHTER);
  const forged = statsFor(ShipClass.FIGHTER, Perk.FORGE);
  const refined = statsFor(ShipClass.FIGHTER, Perk.REFINERY);
  assert.ok(Math.abs(forged.damage / plain.damage - 1.15) < 1e-9);
  assert.equal(refined.energyRegen, Math.round(plain.energyRegen * 1.5));
  assert.ok(Number.isInteger(refined.energyRegen), 'energy stays integer, so it is predicted exactly');
  assert.equal(statsFor(ShipClass.FIGHTER, Perk.SHIPYARD).damage, plain.damage, 'the Shipyard changes no stats');
});

/* Abilities in the shared ship physics --------------------------------------- */

test('the afterburner kicks the ship towards its held thrusters, past the cruise limit', () => {
  const st = statsFor(ShipClass.FIGHTER);
  const s = ship(st);
  s.vx = st.maxSpeed; // already at cruise speed, heading +x
  const result = stepShip(s, Button.ABILITY | Button.STRAFE_RIGHT, 0, st);
  assert.ok(result & StepResult.ABILITY);
  assert.ok(Math.abs(s.vy - (st.abilityImpulse + st.thrust * st.strafeThrust * TICK_DT)) < 0.01, 'kicked to the right');
  assert.ok(speed(s) > st.maxSpeed + 100);
  assert.equal(s.energy, st.energyMax - st.abilityCost);
  assert.equal(s.abilityCooldown, st.abilityCooldown);
  const plain = ship(st);
  stepShip(plain, Button.ABILITY, 0, st);
  assert.ok(Math.abs(plain.vx - st.abilityImpulse) < 1e-6, 'forward when no thruster is held');
  assert.equal(stepShip(plain, Button.ABILITY, 0, st) & StepResult.ABILITY, 0, 'then it recharges');
});

test('the ram drive charges forward on its own and lifts the speed limit while it lasts', () => {
  const st = statsFor(ShipClass.BREAKER);
  const s = ship(st);
  stepShip(s, Button.ABILITY, 0, st);
  assert.ok(s.vx >= st.abilityImpulse);
  for (let i = 1; i < st.abilityDuration; i++) stepShip(s, 0, 0, st); // no input: the drive keeps burning
  assert.ok(s.vx > st.maxSpeed * 1.2 && s.vx <= st.rushSpeed + 1e-6, `rushing at ${s.vx.toFixed(0)}`);
  stepShip(s, 0, 0, st);
  assert.equal(s.abilityTime, 0, 'the charge lasts exactly its duration');
  const v = s.vx;
  stepShip(s, Button.THRUST, 0, st);
  assert.ok(Math.abs(s.vx - v) < 1e-9, 'thrusting afterwards keeps the speed but adds none');
});

test('repair pulse and singularity cost energy and report the ability without moving the ship', () => {
  for (const shipClass of [ShipClass.MEDIC, ShipClass.GRAVITON]) {
    const st = statsFor(shipClass);
    const s = ship(st);
    assert.ok(stepShip(s, Button.ABILITY, 0, st) & StepResult.ABILITY);
    assert.equal(speed(s), 0);
    const broke = ship(st);
    broke.energy = st.abilityCost - st.energyRegen - 1;
    assert.equal(stepShip(broke, Button.ABILITY, 0, st) & StepResult.ABILITY, 0, 'not without the energy');
  }
});

test('singularities pull enemies only, while they last, and yank them out of orbit locks', () => {
  const st = statsFor(ShipClass.FIGHTER);
  const field = createField(1, 1300, 1000, SINGULARITY.gm, SINGULARITY.range, SINGULARITY.core, 100, 100 + SINGULARITY.life, 0, 77);
  const acting = [];
  assert.equal(fieldsAt([field], 99, 1, 5, acting).length, 0, 'not before it is born');
  assert.equal(fieldsAt([field], 100, 1, 5, acting).length, 1, 'enemies feel it');
  assert.equal(fieldsAt([field], 100, 0, 5, acting).length, 0, 'teammates do not');
  assert.equal(fieldsAt([field], 100 + SINGULARITY.life, 1, 5, acting).length, 0, 'gone when it expires');
  assert.equal(fieldsAt([field], 150, NO_TEAM, 77, acting).length, 0, 'free-for-all: never its owner');
  assert.equal(fieldsAt([field], 150, NO_TEAM, 78, acting).length, 1, 'but everyone else');

  const s = ship(st);
  stepShip(s, 0, 0, st, [], 120, fieldsAt([field], 120, 1, 5, acting));
  assert.ok(s.vx > 0, 'pulled towards the core');

  const planet = orbitingBody(0, 4000, 4000, 1400, 9000, 140, 1.2);
  const posed = [];
  poseBodies([planet], 0, posed);
  const orbiter = ship(st, posed[0].x + 300, posed[0].y);
  stepShip(orbiter, Button.LOCK, 0, st, poseBodies([planet], 1, posed), 1);
  assert.equal(orbiter.lockBody, 0);
  const nearby = createField(2, orbiter.x + 100, orbiter.y, SINGULARITY.gm, SINGULARITY.range, SINGULARITY.core, 0, 1000, 0, 9);
  const result = stepShip(orbiter, 0, 0, st, poseBodies([planet], 2, posed), 2, [nearby]);
  assert.ok(result & StepResult.UNLOCKED, 'dragged out of the lock');
});

/* Terrain geometry --------------------------------------------------------------- */

test('outposts sit on the night side, facing away from the star', () => {
  const star = fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR);
  const planet = fixedBody(1, 5000, 4000, 140, 1);
  const p = nightSide(star, planet, 0, {});
  assert.deepEqual([p.x, p.y, p.nx, p.ny], [5140, 4000, 1, 0]);
  const high = nightSide(star, planet, 60, {});
  assert.equal(high.x, 5200);
});

test('flares scorch their wedge, except in the shadows planets cast', () => {
  const star = fixedBody(0, 4000, 4000, 200, 0.64, BodyKind.STAR);
  const planet = fixedBody(1, 5000, 4000, 140, 1);
  const bodies = [star, planet];
  const flare = { angle: 0, halfWidth: 0.5 };
  assert.equal(exposedToFlare(bodies, flare, 4600, 4000, 3600), true, 'between the star and the planet');
  assert.equal(exposedToFlare(bodies, flare, 5400, 4000, 3600), false, 'behind the planet');
  assert.equal(exposedToFlare(bodies, flare, 5400, 4300, 3600), true, 'beside the shadow');
  assert.equal(exposedToFlare(bodies, flare, 4000, 4900, 3600), false, 'outside the wedge');
  assert.equal(exposedToFlare(bodies, flare, 7900, 4000, 3600), false, 'beyond its reach');
  assert.equal(exposedToFlare(bodies, flare, 4000 + 140 + 1000 - 145, 4000, 3600), true, 'on the day side of the planet');
});

test('nebulae contain what is inside them, across the seam too', () => {
  const nebulae = [{ x: 10, y: 10, radius: 300 }];
  assert.ok(nebulaAt(nebulae, 8100, 50), 'wraps');
  assert.equal(nebulaAt(nebulae, 500, 500), null);
});

test('class abilities fire on schedule and the singularity spot is ahead of the nose', () => {
  const st = statsFor(ShipClass.GRAVITON);
  const s = ship(st);
  let uses = 0;
  for (let i = 0; i < st.abilityCooldown * 2 + 2; i++) if (stepShip(s, Button.ABILITY, 0, st) & StepResult.ABILITY) uses++;
  assert.equal(uses, 3, 'once per cooldown while held');
  assert.ok(SINGULARITY.distance < SINGULARITY.range, 'deployed within its own reach');
  assert.ok(SINGULARITY.life > TICK_RATE, 'lasts a few seconds');
});
