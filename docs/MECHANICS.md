# Blasteroid.io mechanics reference

Where the game stands after the flight, fuel and polish round (protocol
version 5). Every number below is the value in the code at the time of
writing, with the constant that holds it, so this document doubles as a
tuning map. Section 13 lists what changed in this round, section 14 the open
design questions, and section 15 where to turn each knob.

**Conventions.** Distances are world units (u). The arena is an 8192 × 8192
torus (`WORLD_SIZE`): leaving one edge enters the opposite one. Ships are
15–21 u in radius and the base view is 1920 × 1080 u. The simulation runs at
60 ticks per second (`TICK_RATE`), so durations in code are ticks (the
`seconds()` helper converts). Speeds are u/s and accelerations u/s². Screen
y grows downwards; angles are radians, 0 pointing right. "Fighter, base"
means a Fighter with no upgrades: other classes scale from it (section 2.6).

**Where numbers live.**

| File | Holds |
| --- | --- |
| `shared/constants.js` | tick rate, world size, wire enums, buttons, blast cone, objective geometry |
| `shared/stats.js` | `BASE` flight, fuel and energy numbers; levels, upgrades, weapons, `CLASSES`, `SINGULARITY`; `deriveStats()` |
| `shared/gravity.js` | `GRAVITY` (the gravity law, landing and crash speeds), bodies on rails, orbits |
| `shared/physics.js` | `stepShip()`: the one ship step the server and client both run |
| `server/game/tuning.js` | everything server-only: planets, asteroids, aliens, blast push, abilities' effects, fuel cells, teams, outposts, flares, nebulae, rewards, bots |

---

## 1. The simulation

The server is authoritative: clients send only inputs (a button bitmask and
an aim angle per tick) and never positions. Each room is a `Game`
(`server/game/Game.js`) that advances in fixed 60 Hz steps:

1. pose the star and planets for the tick (`updateBodies`);
2. expire singularities and list the active ones (`updateFields`);
3. spawn waiting players, run the bots;
4. apply queued input commands, one physics step each (`processShipInputs`);
5. ship timers: spawn protection, power-ups, hull regeneration, idle
   despawn, survival score, replicated flags (`updateShips`);
6. Medic auras, aliens, asteroids, projectiles, pickups;
7. rebuild the spatial grid (128 u cells), then collisions: projectiles,
   ship contacts and pickups, aliens, singularity effects;
8. objectives (outposts, refuelling, flares, nebulae) and the round;
9. top up asteroids, belts, aliens, pickups and bots; sweep the dead.

Everything that moves the player's own ship lives in `shared/physics.js`,
which the browser runs too (client-side prediction). That module is written
to be deterministic: energy and fuel are integers, nothing is random or
reads the clock, and the star and planets move "on rails" (their position is
an exact function of the tick). The rest of this document flags which
mechanics are predicted (instant on screen) and which are server-only
(visible about one round trip later).

---

## 2. Flight model

### 2.1 One physics step

`stepShip(state, buttons, aim, stats, bodies, tick, fields)` runs these
stages in order:

1. **Rotate** towards the aim angle at the turn rate (mouse: the `AIM` bit),
   or with the rotate keys.
2. **Orbit lock toggle** if `LOCK` is pressed (section 5.2).
3. **Energy**: boost drains it, otherwise it recharges (section 7.1). Boost
   also needs fuel.
4. **Plan thrust** from the held buttons (section 2.2), scaled by *power*:
   1 normally, `reservePower` (0.2) on an empty tank.
5. **Burn fuel** for every thruster fired (section 3.1).
6. **Blast** and **ability** activation (energy and cooldowns).
7. **Break the orbit lock** on any thruster, the brake, a blast, a dash, a
   ram charge, or an enemy singularity's pull.
8. If still locked: place the ship on its orbit and stop here (no other
   motion applies).
9. Otherwise: apply thrust under the soft speed cap (2.3), then blast
   recoil, afterburner kick, ram charge, retro brake.
10. **Gravity** from every body and enemy singularity in range (section 4.5).
11. **Coasting drag** if no thruster fired (2.4).
12. **Hard speed cap**, then move: position += velocity × dt
    (semi-implicit Euler: velocity first, then position).
13. **Surfaces**: push out of any body, land or bounce, record the impact
    (4.6); **refuel** while resting on a planet (3.3).
14. **Fire** if the weapon is off cooldown.

It returns a `StepResult` bitmask (`FIRED`, `THRUST`, `BOOST`, `BRAKE`,
`IMPACT`, `BLAST`, `LOCKED`, `UNLOCKED`, `LOCK_FAILED`, `ABILITY`,
`REFUEL`); the server turns those into projectiles, blasts, ability effects
and crash damage, the client into predicted sounds and effects.

### 2.2 Thrusters

Two families of thrusters can fire at once; their vectors add.

| Thruster | Button bits | Default keys | Fighter, base | Direction | Fuel per tick |
| --- | --- | --- | --- | --- | --- |
| Main engine | `THRUST` | right mouse, `↑`, touch stick | 680 u/s² | along the nose | 3 |
| Boost | `BOOST` | `Shift`, touch stick pushed far | 1292 u/s² (1.9 × thrust; 2.3 × with Overdrive) | along the nose, replaces the main engine | 6 instead of 3 |
| Screen thrusters | `MOVE_UP` `MOVE_DOWN` `MOVE_LEFT` `MOVE_RIGHT` | `W` `S` `A` `D` (screen mode, the default) | 578 u/s² (0.85 ×), diagonals normalised | up, down, left, right on screen | 3, shared with the main engine |
| Reverse | `BACK` | `S` in ship mode | 408 u/s² (0.6 ×) | backwards | 2 for any reverse or lateral |
| Lateral | `STRAFE_LEFT` `STRAFE_RIGHT` | `A` / `D` in ship mode | 510 u/s² (0.75 ×) | sideways | (included above) |
| Retro brake | `BRAKE` | `Q`, `↓`, touch `BRAKE` | 612 u/s² (0.9 ×) | against the motion; never reverses it | 2 |

**W/A/S/D modes** (`client/input.js`, a menu setting stored in
`localStorage` under `blasteroid.thrusters`):

- *Screen* (default): `W` `A` `S` `D` send the `MOVE_*` bits, which push in
  fixed screen directions whatever way the ship faces. Aiming and flying are
  independent, like a twin-stick shooter.
- *Ship*: `W` `A` `S` `D` send `THRUST`, `STRAFE_LEFT`, `BACK`,
  `STRAFE_RIGHT`, which push relative to the nose and turn with the ship
  (the original, more demanding scheme).

The physics supports both at once; the setting only changes which bits the
keys send. The keyboard keeps a set of held key codes and re-maps them every
tick, so switching modes mid-flight never leaves a stale thruster on.

Rendering: screen thrusters draw a flame on the side opposite the push and
puff exhaust that way; ship-frame thrusters draw on the hull's own sides.

### 2.3 Speed limits

- **Soft cap**: thrusters cannot raise the speed above the ship's *cruise*
  speed (`maxSpeed`, 480 u/s for a base Fighter), its *boost* speed (816)
  while boosting, or 1.8 × cruise during a ram drive. If a thrust step would
  leave the ship both faster than the cap and faster than before, the
  velocity is rescaled to max(cap, previous speed). Thrust can therefore
  always steer, and a ship already above the cap keeps its speed while it
  thrusts.
- **Uncapped**: gravity, the afterburner, the ram charge, blast recoil,
  knockback and collisions are not limited by the soft cap, so a dive past a
  planet (a slingshot) can carry a ship well past cruise.
- **Hard cap**: `MAX_SPEED` = 1600 u/s, a safety net for stacked impulses.

### 2.4 Coasting drag

With no thruster firing, a ship faster than its **coast speed**
(`BASE.coastSpeed` = 0.42 × cruise: 202 u/s for a base Fighter) slows
exponentially towards it at `BASE.coastDrag` = 0.8 per second, then holds
that speed. Below coast speed there is no drag at all: the ship drifts
Newtonian-style.

| | From cruise (480) | From boost (816) |
| --- | --- | --- |
| Time to within 5% of coast speed | 1.0 s | 1.7 s |

**No drag in gravity wells.** The drag is scaled by `openSpace = 1 − pull /
GRAVITY.edgeAccel`, where `pull` is the magnitude of this tick's gravity
(planets plus singularities). Where the pull is at least `edgeAccel` (54.4
u/s², true inside about 87% of every well's range) there is no drag, so
orbits, slingshots and orbit locks behave exactly as before; the drag fades
in over the well's outer edge and is full strength in open space.

Notes:

- The brake does not count as a thruster, so drag still applies while
  braking.
- Holding any thruster suspends the drag. Combined with the soft cap, that
  means a pilot can hold a slingshot speed above cruise for as long as they
  keep burning fuel; letting go bleeds it off within a second or two. This is
  deliberate ("fuel buys momentum"), but see section 14.

### 2.5 Turning and aiming

Turn rate is 4.4 rad/s for a base Fighter (+8% per Handling level, times the
class multiplier). With the mouse the ship turns towards the cursor at that
rate (`AIM` bit plus a quantised aim angle); the arrow keys rotate directly.
Moving the mouse switches to aiming, pressing a rotate key switches back.

### 2.6 Classes in flight (base, no upgrades)

| Class | Hull radius | Muzzle (`nose`) | Thrust | Cruise | Boost | Coast | Brake | Turn (rad/s) | Tank | Main engine endurance | Boost endurance | Mass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fighter | 16 | 21 | 680 | 480 | 816 | 202 | 612 | 4.40 | 4200 | 23.3 s | 11.7 s | 1 |
| Breaker | 21 | 25 | 646 | 442 | 751 | 185 | 581 | 3.43 | 5250 | 29.2 s | 14.6 s | 3 |
| Medic | 15 | 20 | 714 | 509 | 865 | 214 | 643 | 4.75 | 4620 | 25.7 s | 12.8 s | 0.9 |
| Graviton | 18 | 24 | 612 | 432 | 734 | 181 | 551 | 4.05 | 4200 | 23.3 s | 11.7 s | 1.5 |

Each Engines level adds 6% to thrust, cruise speed and tank size: a
Fighter with Engines 7 has 966 u/s² of thrust, a 682 u/s cruise speed and a
5964 tank. Mass matters for collisions and how far blasts shove a ship
(section 6).

---

## 3. Fuel

### 3.1 Tank and burn

Fuel is an integer in the predicted ship state, so prediction stays exact.
Tanks: `BASE.fuelMax` = 4200 × (1 + 0.06 × Engines) × the class's `fuel`
multiplier (Fighter 1, Breaker 1.25, Medic 1.1, Graviton 1).

Burn per tick, by group (`burnFuel` in `shared/physics.js`):

| Group | Per tick | Per second |
| --- | --- | --- |
| Boost (instead of the main engine) | 6 | 360 |
| Main engine and/or screen thrusters | 3 | 180 |
| Any reverse or lateral thruster | 2 | 120 |
| Retro brake | 2 | 120 |

So holding `W` and `D` in screen mode costs 3 per tick, not 6, and a full
base tank gives about 23 s of continuous main engine or 12 s of boost.
Abilities and the blast cost energy, not fuel. The ram drive's forward burn
is free.

### 3.2 Running dry

At zero fuel, thrusters and the brake run at `reservePower` (20%: 136 u/s²
for a base Fighter) and boost is unavailable. That is enough to drift to a
planet and land, and to climb out of the outer part of a well, but not out
of the inner part of the star's or the core world's well (their pull near
the surface is 488 and up to 1157 u/s²). Running dry is a real hazard
rather than a soft inconvenience.

### 3.3 Refuelling

| Source | Rate | Predicted? | Where |
| --- | --- | --- | --- |
| Resting on a planet (contact at ≤ 60 u/s, any planet but the star) | 30 per tick: a base tank in 2.3 s | yes, in `stepShip` | `BASE.fuelRefuel` |
| Your team's own outpost zone (190 u radius; hovering is enough) | 20 per tick: a base tank in 3.5 s | no | `FUEL.outpostRefuel`, `refuelCrew` in `objectives.js` |
| Fuel cell | +1400 (a third of a base tank) | no | `FUEL.cell`, `collectPickup` in `combat.js` |
| Respawning | full tank | — | `spawnShip` |

Fuel cells (amber canisters on screen):

- 5 + 1 per 5 ships are kept floating in open space, placed away from
  gravity wells (`FUEL.worldCellsBase`, `shipsPerWorldCell`, topped up every
  4 s together with power-ups);
- every destroyed ship drops 2 (`FUEL.shipDrop`);
- a large asteroid that does not drop a power-up drops one 20% of the time
  (`FUEL.rockDropChance`);
- each lasts 90 s (`FUEL.cellLife`).

With 40 bots about 23 cells are alive at once; with 320, about 41 (they get
collected rather than piling up).

### 3.4 What the pilot sees

An amber fuel bar sits under the energy bar, blinking below 20%, labelled
`FUEL`, `REFUELLING` (while landed or in an outpost) or `NO FUEL`. A notice
fires once when the tank drops below 20% and again when it runs dry, with
the ways to refuel. Server-only refuels (cells, outposts) arrive in the next
snapshot's self block and are folded in by reconciliation, so the bar jumps
up about one round trip after the pickup; burn and landing refuels are
instant.

### 3.5 Bots and fuel

Bots head off to refuel below 22% (`REFUEL_BELOW`) and stay until 90%
(`REFUEL_UNTIL`), unless an enemy is within 350 u. They prefer a fuel cell
in reach, then their own outposts, then the planet whose surface pull they
can best handle, approaching to land at ≤ 45 u/s. Section 11 has measured
figures.

---

## 4. Gravity and the solar system

### 4.1 The law

A body of radius *r* and density ρ gets (`createBody` in
`shared/gravity.js`):

- *GM* = `G` × ρ × r³, so mass grows with the cube of the size and a small,
  dense world can out-pull a big, light one near its surface;
- surface pull = *GM* / r² = `G` × ρ × r;
- range = √(*GM* / `edgeAccel`): the distance where the inverse-square pull
  would fall to `edgeAccel`. Beyond it the body has no effect at all.

The pull at distance *d* is *GM* / max(d, r)², multiplied from 80% of the
range (`fadeStart`) outwards by a smoothstep that reaches zero at the range,
so nothing kinks or pops at a well's edge.

`G` = 3.81 and `edgeAccel` = 54.375 (both raised 1.5 × this round). Raising
the two together strengthens every pull by 1.5 × while leaving every range,
and so the solar system's layout, unchanged. To make wells bigger or smaller
without changing their strength, change `edgeAccel` alone.

### 4.2 The bodies

| Body | Radius | Density | Surface pull | Range | Notes |
| --- | --- | --- | --- | --- | --- |
| Star | 200 | 0.64 | 488 | 599 | fixed at the arena's centre; touching it is death |
| Core world | 70–92 | 2.5–3.3 | 667–1157 | 245–424 | small and dense: can out-pull a base engine (680), never a boost |
| Rocky world | 120–160 | 0.8–1.05 | 366–640 | 311–549 | |
| Gas giant | 200–235 | 0.4–0.58 | 305–519 | 474–726 | huge and light |

Sizes and densities are drawn from these ranges per room
(`PLANETS.types`). The HUD shows the current pull as a share of your thrust.

### 4.3 Layout and motion

The star is fixed at the centre. The core world takes the inner orbit at
star range + core range + 90 u (`PLANETS.wellGap`), with a 150 s period; the
rocky world and gas giant share the outer orbit on opposite sides (period
260 s), placed so no two wells ever overlap. Across seeds the inner orbit is
about 950–1040 u from the star and the outer about 1880–2070 u, so planets
travel at roughly 40–50 u/s: slow next to a ship, but enough that a landed
ship visibly rides along.

Each body follows a fixed circular orbit, so its position and velocity are
an exact function of the tick (`setPose`). Clients receive the orbits once,
in the welcome message, and compute every pose themselves: moving planets
cost no bandwidth. `poseBodies` poses copies for any tick, which is how the
server steps each ship at its own command time (section 12.2).

### 4.4 Belts and loose rocks

Each planet keeps a belt of asteroids on exact circular orbits (1/28 mass
unit per unit of range, between 45 u above the surface and 80% of the range).
Belt rocks are sent once as orbit parameters and drawn analytically. A blast,
a ram, a split or a singularity knocks a rock loose: it then falls freely
under gravity (`stepBallistic`) with a small orbital decay relative to its
planet (`GRAVITY.wellDecay`, 0.12 per second), so loose rocks spiral in and
crash rather than piling up. Loose rocks inside a well are streamed every
snapshot; in open space they move in straight lines and are sent once.

### 4.5 How gravity acts on a ship

Each tick, every body and enemy singularity in range adds its acceleration ×
dt to the ship's velocity (`applyGravity`); pulls from overlapping fields
sum. Position then integrates from the new velocity. Gravity uses only `+ -
* /` and `sqrt`, which IEEE 754 makes bit-identical in every engine, so the
client's prediction matches the server's exactly.

### 4.6 Surfaces, landing and crashing

`collideBodies` pushes a ship out of any body and works in the body's moving
frame:

- contact slower than `GRAVITY.landingSpeed` (60 u/s) is a **landing**: the
  ship settles (no bounce) and 25% of its sideways slide is removed each
  tick (`surfaceGrip`), so it comes to rest and rides along with the planet;
- faster contact **bounces** with restitution 0.45;
- impacts above `GRAVITY.crashSpeed` (120 u/s) **damage** the hull: 0.22
  per u/s above 120 (`PLANETS.crashDamage`), with a 0.3 s cooldown. A
  300 u/s crash costs 40 hull; a base Fighter has 100.

### 4.7 The star

Touching the star destroys a ship outright (`touchBody` in `ships.js`):
shields and spawn protection don't help. The kill is credited to whoever
last damaged or shoved the victim within 6 s (`REWARD.assistWindow`), so
blasting or dragging an enemy into the star is a kill. Saucers, hunters and
motherships that touch it are destroyed too.

On screen: your own contact plays predicted sparks and a sizzle at once; the
death message then triggers a supernova (two expanding heat rings and bursts
of flame and embers) and heavier screen shake. Other pilots' star deaths get
the same fireball where their ship is drawn.

### 4.8 Bodies block shots

The star and planets stop projectiles (swept test against each body), so
planets are cover. Your own shots hitting a body are predicted (bodies move
on rails) and vanish on impact immediately.

---

## 5. Orbits, the orbit lock and the trajectory preview

### 5.1 Orbit readout

`describeOrbit` classifies free flight around the body pulling hardest with
the two-body (Kepler) solution: from position and velocity relative to the
body it computes orbital energy and angular momentum, hence periapsis and
apoapsis, and calls the orbit `STABLE` (clear of the surface, inside the
range), `IMPACT` or `ESCAPE`. In the fade zone, where the pull is no longer
pure inverse-square, it uses an effective *GM* matching the pull felt at the
ship's distance, so a circular orbit there still reads as one.

While inside a well, the HUD readout above the status bars shows the
predicted outcome (stable orbit, descending, touchdown in N s, crash in N s,
burn-up for the star, escaping, landed, locked), altitude, periapsis and
apoapsis, the pull as a share of your thrust, and the lock hint.

### 5.2 Orbit lock (`L`)

`lockOrbit` picks the body pulling hardest and locks the ship into a
circular orbit around it:

- radius: the current distance, raised to at least surface + hull radius +
  30 u (`LOCK_CLEARANCE`);
- direction: the sense of the ship's current motion around the body
  (sign of its angular momentum relative to the body);
- angular speed √(pull(r) / r), which is exact for the faded pull too.

While locked, the ship's position is a pure function of the tick
(`followLock`), riding along with the planet. The lock breaks on `L` again,
any thruster, the brake, a blast, an afterburner or ram charge, an enemy
singularity's pull, any collision, or any outside push (blast, knockback).
`L` outside every well fails with a notice.

### 5.3 Trajectory preview

`FlightPath` (`client/flightpath.js`) coasts a copy of the predicted ship
300 ticks (5 s) ahead with the same `stepShip()` and no input, posing every
body for each future tick, and keeps every third point. Points are stored
relative to the dominant body as it is drawn now, so an orbit looks like an
orbit even though the planet is moving.

When it is computed and shown:

- computed only if a well (or singularity) is within 3 s of flight at the
  current speed (`WELL_LOOKAHEAD_S`); otherwise it is cleared, which also
  saves the 300-step simulation per frame in open space;
- drawn only if the path ends on a surface (yellow touchdown or red crash,
  with a countdown in the readout), while orbit-locked, or with the
  trajectory planner on (`T`), which always draws it in a well (green
  stable, white escape).

The Graviton additionally gets a reticle 230 u ahead of its nose where its
singularity would form: solid when the ability is ready, dashed while
recharging.

---

## 6. Weapons and combat

### 6.1 Weapons

Base projectile (`BASE`): 12 damage, 860 u/s, 900 u range (1.05 s), one shot
every 14 ticks (4.3 per second). Shots spawn at the class's muzzle (`nose`:
where its hull's prow ends) plus the weapon's lateral offsets, and inherit
the ship's velocity.

| Weapon | Damage | Speed | Range | Interval | Projectiles |
| --- | --- | --- | --- | --- | --- |
| Blaster | 1 × | 1 × | 1 × | 1 × | one |
| Twin (level 10) | 0.75 × each | 1 × | 1 × | 1 × | two, 6 u either side |
| Scatter (level 10) | 0.62 × each | 0.95 × | 0.72 × | 1.1 × | three, ±0.2 rad |
| Cannon (level 10) | 2.9 × | 0.74 × | 1.15 × | 2.2 × | one, radius 7 |

Class multipliers (damage, fire rate) and upgrades stack on top (section 8).

### 6.2 Hits

Projectiles are tested along their path over the last tick (swept circle),
so fast shots cannot tunnel through small targets. Teammates are skipped (no
friendly fire), except that a Medic's shots heal teammates for 1.4 × their
damage. A hit pushes a ship by 2.5 u/s per point of damage
(`SHIP.hitKnockback`) and breaks its orbit lock.

Damage pipeline (`damageShip` in `combat.js`): spawn protection blocks it,
a Shield power-up absorbs it, the rest comes off the hull. Hull regenerates
after 4 s without damage (`SHIP.regenDelay`), at 2 hp/s base (+1.5 per Repair
level, times the class multiplier).

**Spawn protection** lasts 3 s (`SHIP.spawnInvuln`) and ends the moment the
ship fires, blasts or uses its ability.

### 6.3 Kinetic blast (`P`)

A cone from the nose: 380 u to the target's surface (`BLAST_RANGE`), ±0.6
rad (`BLAST_HALF_ANGLE`), widened by each target's size. Everything inside
except teammates is shoved straight away from the ship by 520 u/s at point
blank, falling linearly to 30% at the edge (`BLAST`), times:

- rocks: 1, 0.75, 0.5 by size (small to large); belt rocks are knocked off
  their orbits;
- ships: 0.7 / √mass (a Breaker budges about 58% as much as a Fighter); the
  blaster becomes their last attacker, so a shove into a planet or the star
  is a kill;
- aliens: 0.5; motherships don't budge.

It costs 160 energy, recharges in 72 ticks (1.2 s), and kicks the blaster
back by 70 u/s. A shoved rock that hits a ship within 4 s
(`BLAST.creditWindow`) credits the shover.

### 6.4 Collisions

Contacts exchange momentum by mass (`bounce` in `ships.js`) and break orbit
locks. Damage scales with the closing speed: *impact* = clamp(closing /
250, 0.4, 2), with a 0.3 s cooldown per ship.

| Contact | Damage |
| --- | --- |
| Ship → rock | 12 × impact to the rock (Breakers 2 ×); the rock deals 8 / 15 / 26 × impact (by size) back (Breakers take half) |
| Ship ↔ enemy ship | 6 × impact each way; teammates only bounce |
| Ram drive → enemy ship | 34 × impact; the rammer takes a quarter of what it would normally |
| Ram drive → rock | 220 (shatters any rock); the rammer takes nothing |
| Ship ↔ alien | 12 × impact to the alien; the alien's contact damage × impact to the ship |

### 6.5 Kills and rewards

A kill credits the attacker, or whoever damaged the victim within the last
6 s when a rock, planet, the star or a disconnect finishes the job. The
killer earns 100 + 30% of the victim's score; 30% of the victim's score is
scattered as orbs (about 40 each, at most 16) along with 2 fuel cells; an
enemy kill adds 10 team points. Respawning takes 1.2 s.

### 6.6 Kill streaks (client-side)

`client/streaks.js` derives streaks from the kill feed every client already
receives, so they cost no server state or bandwidth:

- your kills within 4 s of each other announce DOUBLE KILL, TRIPLE KILL,
  then MULTI KILL;
- 3, 5, 8 and 12 kills without dying (KILLING SPREE, RAMPAGE, UNSTOPPABLE,
  GODLIKE) go into everyone's kill feed, and get a banner for the pilot on
  the streak;
- ending a streak of 3 or more is announced too.

They are cosmetic: no score bonus, and a client only counts kills it saw
(a streak started before you joined is not credited).

---

## 7. Energy, ship classes and abilities

### 7.1 Energy

Integer, shared by boost, the blast and the class ability. Base capacity 600
(+100 per Energy level), recharging 4 per tick (+1 per two Energy levels;
× 1.5 with the Refinery perk) whenever the ship isn't boosting. Boost drains
10 per tick, so a full base bar is 1 s of boost; once it runs dry, boost
unlocks again at 25%. Overdrive makes boost free.

| Use | Energy | Cooldown |
| --- | --- | --- |
| Kinetic blast | 160 | 1.2 s |
| Afterburner (Fighter) | 120 | 3.5 s |
| Ram drive (Breaker) | 200 | 7 s |
| Repair pulse (Medic) | 220 | 9 s |
| Singularity (Graviton) | 260 | 12 s |

### 7.2 Classes

Multipliers over the base stats (`CLASSES` in `shared/stats.js`):

| Class | Hull | Regen | Thrust | Speed | Turn | Damage | Fire rate | Fuel | Mass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fighter | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| Breaker | 1.6 | 1.2 | 0.95 | 0.92 | 0.78 | 0.8 | 0.8 | 1.25 | 3 |
| Medic | 0.9 | 2 | 1.05 | 1.06 | 1.08 | 0.65 | 1.1 | 1.1 | 0.9 |
| Graviton | 1.2 | 1 | 0.9 | 0.9 | 0.92 | 0.85 | 0.9 | 1 | 1.5 |

Abilities that move the ship are simulated in `stepShip`, so they are
predicted; their effect on others is resolved on the server
(`server/game/abilities.js`).

- **Afterburner** (Fighter): an instant 420 u/s kick towards the held
  thrusters (screen direction first, then ship-frame thrusters, forward if
  none), not limited by the cruise cap.
- **Ram drive** (Breaker): a 380 u/s kick along the nose, then 1.2 s in
  which the engine burns on its own (fuel-free) with the speed cap raised to
  1.8 × cruise. While ramming the Breaker counts as mass 8, shatters rocks,
  hits enemies for heavy damage and takes almost none (6.4). Breakers also
  take half of normal rock damage.
- **Repair pulse** (Medic): heals every teammate within 430 u by 38 and the
  Medic by 20. Teammates within 330 u of a Medic regenerate 5 hp/s even right
  after taking damage, and Medic shots heal teammates. Healing pays 0.5 score
  per hit point.
- **Singularity** (Graviton): a temporary gravity field 230 u ahead of the
  nose for 4 s. It pulls 400 u/s² at 120 u (*GM* = 5.76 million), reaches
  470 u, and its pull is capped inside the 40 u core, which crushes enemy
  ships (0.5 per tick), rocks (1.2) and aliens (1). It pulls enemies only
  (in free-for-all, everyone but its owner) plus all rocks and aliens, rips
  belt rocks off their orbits, and breaks enemies' orbit locks. At most 8
  exist at once. The server snaps its position to the wire grid and starts
  it on the next command tick, and snapshots list fields with their
  lifetimes, so enemies' clients predict its pull exactly (the first
  snapshot after one appears is a correction, like any knockback).

---

## 8. Progression

- **Score** comes from asteroids (12 / 8 / 5 by size, smallest most),
  aliens, kills, orbs, capturing (120) and holding (2/s) outposts, healing,
  a round win (+300 to every winner), and 1 per second alive while active.
- **Levels**: reaching level *L* takes 50 × (*L* − 1)² total score, up to 40.
  Each level grants a point for one of eight stats, each up to 7 levels (39
  points for 56 slots): Hull +30 hp, Repair +1.5 hp/s, Engines +6% thrust,
  speed and tank, Handling +8% turn, Damage +14%, Velocity +6% projectile
  speed and +2.5% range, Reload −6% interval, Energy +100 capacity and +1
  recharge per two levels. Veterans see up to 20% further at level 40.
- **Level 10** unlocks a weapon choice (Twin, Scatter, Cannon).
- **Power-ups** (from large asteroids and aliens, plus 4 + 1 per 5 ships
  floating in the world): Shield (absorbs 80 damage, 20 s), Rapid fire
  (interval × 0.55, 10 s), Repair (half the hull at once), Overdrive (free,
  stronger boost, 10 s).

---

## 9. Teams, rounds and objectives

### 9.1 Teams

Two teams, Helios (orange) and Polaris (blue). New players join the smaller
team (ties go to the one with fewer humans); bots keep the teams even and
the bigger team retires its weakest bot first. Shots pass through
teammates, blasts never shove them, singularities never pull them.
`TEAMS=0` runs a free-for-all.

### 9.2 Rounds

First team to 1000 points wins (`ROUND.winScore`), or the leader after 12
minutes; a tie at the buzzer becomes sudden death. Team points: 10 per enemy
destroyed, 2 per second per held outpost. Every pilot on the winning team
gets 300 score, then a 10 s intermission resets the outposts. Ships, levels
and score carry over.

### 9.3 Outposts

One per planet, on its night side: planets are tidally locked, so the
outpost always faces away from the star and is always in its planet's flare
shadow. The capture zone is a 190 u circle (`OUTPOST_RADIUS`) centred on the
surface point.

- Progress runs from −1 (Helios) to +1 (Polaris). One team alone in the zone
  pushes it towards their end at 1 / 8 s per pilot, up to 3 pilots
  (`OUTPOST.captureTime`, `maxCrew`): one pilot takes a neutral outpost in
  8 s, three in 2.7 s, and flipping an enemy outpost takes twice as long.
- Both teams present: contested, frozen. Empty: drifts back towards its
  owner (or neutral) over 20 s.
- Ownership changes at ±1 and is lost when progress crosses the middle.
- Rewards: 120 score to each capturing pilot, 2 score per second to pilots
  holding their own outpost, 2 team points per second, refuelling at 20 per
  tick for the owning team in the zone, and a team perk:
  - **Forge** (core world): +15% weapon damage;
  - **Refinery** (gas giant): +50% energy recharge;
  - **Shipyard** (rocky world): the team respawns landed on the outpost.

Perks change stats the client predicts (damage, energy recharge), so they
travel in the stats block and are folded into `deriveStats()` on both sides.

### 9.4 Spawning

Without a Shipyard, a team spawns near its home: diagonally opposite
corners of the solar system (2048 u from the star on both axes), in open
space, away from wells and enemies, facing the star. With one, it spawns
landed on that outpost, moving with its planet. Free-for-all spawns anywhere
open.

### 9.5 Solar flares

The first flare comes after 70 s, then every 75–110 s, announced 6 s ahead
with a countdown and a pulsing wedge. It burns for 1.5 s in a wedge 0.42–0.62
rad either side of a random direction, out to 3600 u, dealing 1 damage per
tick (90 over the burn) to every ship and alien in the open. Planets shade
everything behind them as seen from the star (with a 6 u margin), drawn as
dark cones; the HUD tells you whether you are exposed or sheltered.

### 9.6 Nebulae

Five violet clouds, 280–420 u in radius, 2950–3750 u from the star (open
space beyond the planets' orbits). A pilot inside one is invisible to
enemies further than 320 u: the server doesn't send their position to those
clients and bots lose track of them. Firing, blasting or using an ability
reveals them for 1.5 s.

---

## 10. The rest of the world

- **Asteroids**: three sizes (radius 18 / 36 / 62, 10 / 24 / 48 hp) that
  split in two when destroyed; the open field is kept at 640 mass units + 4
  per ship, spawning out of sight (≥ 1300 u from any ship). Large rocks drop
  a power-up 4% of the time, else a fuel cell 20% of the time.
- **Aliens**: saucers (60 hp, sloppy aim) and hunters (34 hp, lead their
  shots, prefer high scorers); 3 + 1 per 4 ships, at most 10. A mothership
  (2400 hp, radial barrages, hunter escorts) arrives after 150 s and then
  every 300 s with at least 4 ships in the room. Aliens feel gravity and
  steer clear of bodies.
- **Pickups**: score orbs (45 s), power-ups (60 s), fuel cells (90 s),
  collected slightly before visual contact.

---

## 11. Bots

Bots are ordinary players whose commands come from a `BotBrain`
(`server/game/bots.js`) instead of a socket, so they exercise exactly the
same physics, weapons, abilities and upgrades.

- **Skill**: 65% rookies (skill 0.05–0.35), 25% regulars (0.35–0.65), 10%
  aces (0.65–0.9). Skill sets aim wobble, reaction time, target leading,
  aggression range and trigger discipline. Regulars and aces fly with screen
  thrusters (strafing while they aim) and use the blast; rookies turn, burn
  and brake.
- **Classes**: 40% Fighter, 20% each of the others.
- **Modes**: wander, farm rocks, fight, flee, loot, objective (capture and
  defend outposts), heal (Medics) and refuel. They think every 6 ticks;
  abilities are considered on think ticks.
- **Flight**: they keep clear of planets by 70 u + 140 u × (surface pull ÷
  their thrust) + half their closing speed, and of the star by 220 u + 0.6 ×
  their closing speed, boosting away when a body out-pulls them or they close
  fast; they land gently on the planet they chose to refuel on; their
  steering deadband widens as fuel runs low, so they coast more.
- **Measured** (14 bots, 6 minutes): average fuel about 65%, empty about 2%
  of the time, 1–2 planet crashes.

---

## 12. Netcode

### 12.1 Transport and messages

A binary protocol (`shared/protocol.js`, big-endian `DataView`) over raw
WebSockets, compression off for latency. Clients send `JOIN`, `INPUT`,
`UPGRADE`, `WEAPON`, `PING` (and `STEALTH` with dev tools); the server sends
`WELCOME` (version, features, the bodies' orbits, outposts and nebulae, all
once), `JOINED`, `SNAPSHOT`, `ROSTER` / `ROSTER_REMOVE`, `LEADERBOARD`,
`KILL`, `DEATH`, `PONG`, `ANNOUNCE` and `KICK`. A client with a different
`PROTOCOL_VERSION` is asked to refresh.

### 12.2 Inputs and command time

One `INPUT` per tick: 12 bytes (u8 type, u32 sequence number, u8 count,
u32 button bits, u16 quantised aim). Buttons are 17 bits (`BUTTON_MASK`),
masked on arrival.

The server queues commands per player and applies each as exactly one
`stepShip`. A ship banks at most 16 commands (`SHIP.maxCredits`), refilled
one per tick: that absorbs jitter, but flooding commands can never move a
ship faster than real time.

**Command time.** Command *n* runs at world tick *n* + `timeOffset`, with
the bodies posed (and singularities filtered) for that tick, and every
snapshot tells the client the offset. Its prediction poses its own copies
for the same tick, so near a moving planet the replay lands exactly where
the ship already was, even when commands arrive in bursts. The offset is
anchored by each life's first command and re-anchored only when command
time drifts more than 12 ticks from world time, or stays more than 3 ticks
off for a second (`SHIP.timeSlack`, `timeSoftSlack`, `timeDriftLimit`):
one tiny correction near a planet.

### 12.3 Prediction and reconciliation

The client (`client/prediction.js`) steps its own ship with every command
it sends and keeps up to 180 unacknowledged commands (3 s). Each snapshot
carries the ship's exact state after the last command the server applied
(full float64 precision), plus that command's sequence number. The client
first applies the stats block (new upgrades, power-ups or perks change the
derived stats), then rewinds to the server state and replays the
unacknowledged commands at their command ticks. With no outside influence
the replay lands exactly where the ship already was: no correction at all.
Collisions, knockback, blasts, server-side refuels and a singularity's first
tick produce corrections, blended out with a 90 ms time constant; anything
over 160 u snaps.

### 12.4 Interpolation and time bases

- **Ships and aliens** are drawn in the past, interpolated between
  snapshots, at *render time* = newest tick − (snapshot interval + measured
  jitter (≤ 6) + 1) ticks: 3–9 ticks, 50–150 ms. They coast at most 8 ticks
  past the newest sample before freezing.
- **Predictable entities** (asteroids, projectiles, pickups) are
  extrapolated to the *present*: the tick at which your current command
  reaches the server. Your shots and the rocks they hit therefore agree on
  screen.
- **Your own ship** is predicted at the present.
- **Carry with body**: a remote ship inside a well is drawn shifted by its
  planet's motion between render time and the present (ramping in over the
  outer 30% of the well), so a pilot parked on a moving world sits on its
  surface on everyone's screen.

### 12.5 Projectiles on screen

- **Your shots** appear the instant you fire, as predicted "ghosts" at the
  muzzle, and are matched to the server's projectiles by (fire sequence,
  muzzle index). A ghost also carries the ship's current smoothing offset,
  decaying in step with it, so it leaves the muzzle where the ship is drawn
  even mid-correction. Unconfirmed ghosts expire after 45 ticks.
- **Other pilots' shots**: a projectile fired within the last snapshot
  interval carries its exact age (0–6 ticks, in the flags byte), so the
  client knows the tick it left the muzzle. It is drawn from the shooter's
  drawn muzzle (including the shooter's carry-with-body shift) and converges
  onto the present over 12 ticks.
- Measured after the fix: other pilots' shots start a median 0.5 u (90th
  percentile 2 u) sideways of the shooter's drawn nose.

### 12.6 Interest management and stealth

Each client receives only what is within its view (1920 × 1080, scaled by
level, plus a 260 u margin). Ships and aliens are streamed every snapshot;
known ships get a compact motion-only record (`SHIP_MOTION`) with their
owner, level and weapon re-sent only when they change. Asteroids, projectiles
and pickups move predictably, so they are sent once and again only when
their motion changes; removals carry a reason (left view, destroyed, hit,
collected, expired) so the client plays the right effect. Nebula stealth is
enforced here: a hidden enemy is treated as out of view, so a modified client
has nothing to reveal. The match state is sent only when it changes.

### 12.7 Snapshot layout

```
u8   SNAPSHOT
u32  tick
u8   flags: SELF, STATS, SPECTATE, WORLD
[STATS]     score, kills, level, points, 8 stat levels, weapon, weapon choice,
            power-up timers, spawn tick, class, perks (only when changed;
            before SELF so prediction re-derives stats before replaying)
[SELF]      ack sequence, ship id, x, y, vx, vy, angle (float64), energy, fuel,
            fire / boost-lock / blast / ability timers, hull, shield, flags,
            time offset, orbit lock (+ its orbit when locked): 67 bytes, 96 locked
[SPECTATE]  camera target while not playing
[WORLD]     round phase and end, winner, team scores, outposts (owner,
            progress, contested), the coming flare (only when changed)
removals    u16 count × { u16 id, u8 reason, [u16 collector] }
entities    u16 count × { u8 type, u16 id, payload }  (positions u16, velocities i16 in 1/16 u/s)
events      this player's feedback: score, hits, damage taken, heals
effects     nearby blasts, pulses, dashes, rams, singularities
```

### 12.8 Determinism rules

Anything that moves a ship must live in `shared/physics.js` and follow its
rules: integers for energy, fuel and timers; no randomness or clock reads;
bodies posed from the tick; only IEEE-exact arithmetic in gravity (`cos` and
`sin` appear only in body poses and orbit locks, where a last-bit difference
between browsers is far below anything visible). Server-only effects (damage,
refuels from cells and outposts, pushes) reach the client through
reconciliation.

### 12.9 Performance

`npm run bench` (team mode, 8192² arena, bots using every mechanic):

| Players | Simulation per tick | Snapshots per round | CPU (one core) | Snapshot | Downstream per client |
| --- | --- | --- | --- | --- | --- |
| 40 | 0.42 ms | 0.57 ms | 4.2% | 317 B | 9.3 KiB/s |
| 80 | 0.69 ms | 1.77 ms | 9.5% | 593 B | 17.4 KiB/s |
| 160 | 1.43 ms | 5.71 ms | 26% | 1021 B | 29.9 KiB/s |
| 320 | 3.16 ms | 18.3 ms | 74% | 1826 B | 53.5 KiB/s |

Free-for-all at 40 players: 124 B and 3.6 KiB/s. Upstream is one 12-byte
input per tick (about 1 KiB/s with WebSocket framing). Rooms default to 40
humans.

---

## 13. What changed in this round

| Request | What was done |
| --- | --- |
| Bullets firing off-centre | Four causes fixed. (1) Every class fired from one fixed muzzle distance, so shots from bigger or smaller hulls started inside or ahead of the prow: each class now has its own `nose`. (2) Other pilots' fresh shots assumed they were one tick old: snapshots now carry the exact age. (3) Ships riding a planet are drawn shifted with it, but their shots were not: shots now start from the shifted muzzle. (4) Your own shots ignored the prediction smoothing offset: ghosts now carry it. Blast effects also use the class muzzle. |
| Destroyed by the star, with a fiery animation | Star contact kills outright (shields and spawn protection don't help) and is credited to whoever shoved you; supernova effect for every pilot's star death. Saucers die there too. |
| Too much continuous velocity | Coasting drag in open space down to 42% of cruise in about a second; no drag in gravity wells (2.4). |
| Stronger planet gravity | `G` and `edgeAccel` × 1.5 (stronger pull, same well sizes); the densest worlds' density ranges trimmed so only the core world can out-pull a base engine and none out-pulls a boost. Bots' planet avoidance scales with each body's pull. |
| What are the trajectory lines for? | They preview where your ship goes if you let go of the controls. Now drawn only when that path ends on a surface (touchdown or crash, with a countdown), while orbit-locked, or with the trajectory planner on (`T`); only computed near a well. The orbit readout stays. The Graviton gets a deploy reticle. |
| Fuel limit | Integer fuel with per-thruster burn, reserve power, predicted planet refuelling, outpost refuelling, fuel cells, HUD bar and warnings, bot fuel management (section 3). |
| W/A/S/D thrust in screen directions | New `MOVE_*` buttons push in screen directions whatever the heading; the default. The old ship-relative scheme is a menu toggle, so either can be dropped later without touching the physics (14.1). |
| More game-like and fun | Kill streaks and multi-kills; spawn protection also ends on blasting or using an ability (no more invulnerable shoving); fuel cells as wreck loot; Graviton reticle; fuel-aware bots. |
| Professional standards | Protocol v5; `stepShip` split into named stages; 151 tests (new: fuel, star death, outposts refuelling, screen thrusters, coasting, per-class muzzles, streaks, fade-zone orbits); a latency harness confirmed corrections only come from outside influences; benchmarks re-run; fixed a reconcile ordering bug (stats are now applied before the self block). |

---

## 14. Open questions and suggestions

1. **W/A/S/D: screen or ship directions?** Both work and are one setting
   apart (`ThrusterMode` in `client/input.js`). Screen mode is easier and
   frees the mouse for aiming (twin-stick feel); ship mode is the classic
   challenge and makes the nose matter for movement. Keeping both costs four
   button bits and the menu toggle. Removing ship mode means dropping its
   key table and the setting; removing screen mode means dropping the
   `MOVE_*` bits from `planThrust`, `burnFuel` and `afterburner`. Playtest
   with fresh players before deciding.
2. **Coasting feel**: `BASE.coastSpeed` (0.42) and `BASE.coastDrag` (0.8/s)
   set how much speed survives letting go and how quickly. Higher coast
   speed is closer to pure drift; higher drag snaps to it faster.
3. **Momentum while thrusting**: holding any thruster suspends drag, so a
   slingshot speed can be kept indefinitely for fuel. If that feels like an
   exploit, apply drag above cruise speed even while thrusting.
4. **Fuel economy**: 23 s of main engine per tank, refuelling in 2.3 s on any
   planet. If fuel never feels scarce, lower `fuelMax` or `fuelRefuel`, or
   restrict refuelling to outposts and cells; if empty tanks feel punishing,
   raise `reservePower`. Fuel cells on the minimap would make scavenging
   more deliberate.
5. **Star deaths land one round trip late**: your ship visibly bounces off
   the star until the server's death message arrives. Hiding the ship on a
   predicted star contact (and restoring it if no death follows) would make
   it instant.
6. **Server-only refuels** (cells, outposts) show up a round trip late. They
   could be predicted like landing refuels if cell positions were part of
   prediction; low priority.
7. **Gravity strength**: the core world can out-pull a base engine near its
   surface, so landing there on low fuel is a commitment. If that feels
   unfair, cap the core's density range below 680 / (3.81 × 92) ≈ 1.94 for
   the biggest core, or give the HUD a "too deep to climb out" warning based
   on fuel and pull.
8. **Kill streaks are cosmetic** and client-derived. Making them
   server-side would allow score bonuses or a bounty on a player's head.
9. **Crowding cost**: refuelling and objectives gather pilots, so crowded
   rooms send bigger snapshots (320 players: 1.8 KB, 74% of a core). Rooms
   hold 40 humans by default, so this only matters if rooms grow.
10. **Browser tests**: the Playwright checks used this round (muzzles, star
    death, thrusters, trajectory, lag runs) are ad hoc scripts; adding a
    headless smoke test to CI would guard the client.

---

## 15. Tuning map

| To change | Constant | File |
| --- | --- | --- |
| Thrust, cruise and boost speed, thruster strengths, brake | `BASE.thrust`, `maxSpeed`, `boostSpeed`, `backThrust`, `strafeThrust`, `moveThrust`, `brake` | `shared/stats.js` |
| Coasting drag | `BASE.coastSpeed`, `BASE.coastDrag` | `shared/stats.js` |
| Tank size, burn rates, landed refuel, reserve power | `BASE.fuelMax`, `fuelBurn*`, `fuelRefuel`, `reservePower` | `shared/stats.js` |
| Fuel cells, outpost refuelling | `FUEL` | `server/game/tuning.js` |
| Energy, boost drain, blast cost / cooldown / recoil | `BASE.energy*`, `boostDrain`, `blast*` | `shared/stats.js` |
| Class multipliers, hull size, muzzle, abilities | `CLASSES`, `SINGULARITY` | `shared/stats.js` |
| What abilities do to others | `ABILITY` | `server/game/tuning.js` |
| Gravity strength and well size | `GRAVITY.G`, `GRAVITY.edgeAccel`, `fadeStart` | `shared/gravity.js` |
| Landing, bounce, crash speeds | `GRAVITY.landingSpeed`, `crashSpeed`, `bounce`, `surfaceGrip` | `shared/gravity.js` |
| Planet sizes, densities, orbits, belts, crash damage | `PLANETS` | `server/game/tuning.js` |
| Blast push | `BLAST` (cone: `BLAST_RANGE`, `BLAST_HALF_ANGLE` in `shared/constants.js`) | `server/game/tuning.js` |
| Weapons | `WEAPONS`, `WEAPON_CHOICES` | `shared/stats.js` |
| Levels and upgrades | `scoreForLevel`, `deriveStats` | `shared/stats.js` |
| Rounds, outposts, flares, nebulae | `ROUND`, `OUTPOST`, `FLARE`, `NEBULA` | `server/game/tuning.js` |
| Rewards, spawn protection, respawn | `REWARD`, `SHIP` | `server/game/tuning.js` |
| Bots | `BOT`; refuel thresholds `REFUEL_BELOW` / `REFUEL_UNTIL` | `server/game/tuning.js`, `server/game/bots.js` |
| Trajectory preview reach and gating | `HORIZON`; `WELL_LOOKAHEAD_S` | `client/flightpath.js`; `client/main.js` |
| Kill streak names and window | `STREAK_NAMES`, `MULTI_WINDOW_MS` | `client/streaks.js` |

Any change to `shared/` that affects movement is automatically predicted;
bump `PROTOCOL_VERSION` when the wire format changes.
