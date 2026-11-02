# Blasteroid.io

A retro multiplayer space shooter for the browser. Classic Asteroids vector
graphics and physics, rebuilt as an .io game: two teams battle across a living
solar system for outposts, in four ship classes, with aliens, endless play and
a ship that grows stronger the longer you survive.

```sh
npm install
npm start            # http://localhost:3000/play
```

Requires Node.js 20 or newer. The only runtime dependency is
[`ws`](https://github.com/websockets/ws).

## Playing

| Action | Mouse + keyboard | Classic keys | Touch |
| --- | --- | --- | --- |
| Aim / turn | move the mouse | `←` `→` | drag left side |
| Main engine (along the nose) | right click | `↑` | drag left side |
| Thrusters: up, left, down, right on screen | `W` `A` `S` `D` | | |
| Fire | left click or `Space` | `Space` | hold right side |
| Retro brake | `Q` | `↓` | `BRAKE` button |
| Boost | `Shift` | `Shift` | drag the stick far |
| Class ability | `E` | `E` | ability button |
| Kinetic blast | `P` | `P` | `BLAST` button |
| Lock / release orbit | `L` | `L` | `LOCK` button |
| Trajectory planner on / off | `T` | `T` | |
| Upgrade a stat | `1`–`8` or click the panel | | tap the panel |
| Choose a weapon (level 10) | `Z` `X` `C` or click | | tap a card |
| Mute / netgraph | `M` / `F3` | | |
| Hide from bots and aliens (testing) | `I` | | |

- **Flight**: your ship drifts. With no thruster firing it slows to a coast
  speed of about 40% of cruise within a second and then holds it; inside
  gravity wells there is no drag at all, so orbits and slingshots behave like
  real ones. `W` `A` `S` `D` push up, left, down and right on screen whichever
  way the ship faces, so you can aim with the mouse and fly independently
  (the menu has a setting to make them forward, left, back and right of the
  ship instead). The main engine and boost push along the nose. Thrusters
  cannot push you past cruise speed (boost goes faster), but gravity can: dive
  past a planet to slingshot.
- **Fuel**: every thruster burns fuel. A full tank lasts about 23 seconds of
  main engine (12 boosting); side thrusters and the brake burn less. Land
  gently on a planet to refuel (a full tank in about 2 seconds), hover in your
  team's own outpost, or grab a fuel cell: amber canisters that float in open
  space and drop from destroyed ships and large asteroids. On an empty tank
  you cannot boost and the thrusters run at 20%: enough to limp to a planet,
  not to climb out of a deep well. Abilities and the blast run on energy, not
  fuel.

- **Teams**: you join the smaller of two teams, *Helios* (orange) and
  *Polaris* (blue). Your shots pass through teammates and blasts never shove
  them. Teammates show on your minimap. A round goes to the first team to
  1000 points (or the leader after 12 minutes; a tie goes to sudden death):
  points come from holding outposts and destroying enemies, and every pilot
  on the winning team earns a 300-point bonus. After a 10-second intermission
  the outposts reset and the next round starts; ships and levels carry on.
  Set `TEAMS=0` for a free-for-all.
- **Score** comes from asteroids (smaller is worth more), aliens, other
  pilots and the orbs they drop, capturing and holding outposts, healing
  teammates, plus a trickle for staying alive and active.
- **Levels** (up to 40) each grant an upgrade point for one of eight stats:
  hull, repair, engines, handling, damage, velocity, reload and energy.
  Veterans also see a little further.
- **At level 10** pick a weapon: *Twin* (parallel shots), *Scatter*
  (three-way spread) or *Cannon* (slow, heavy, long range).
- **Power-ups**: Shield, Rapid fire, Repair and Overdrive (unlimited boost).
- **The solar system**: a star sits at the centre of the arena, orbited by a
  small, dense core world on the inner orbit and a rocky world and a gas giant
  sharing the outer orbit on opposite sides. Every body has a gravity well,
  drawn as a glowing field: the haze follows the strength of the pull,
  contour rings mark where it doubles, and ripples fall inwards. A body's
  mass comes from its size × density, so the small core pulls hardest near
  its surface (sometimes harder than your engines; the HUD shows the pull as
  a share of your thrust). Each planet carries a belt of orbiting rocks.
- **Orbits**: inside a well the readout above your hull bar shows where your
  coasting path leads (stable orbit, touchdown, crash, escape), with altitude,
  periapsis, apoapsis and the pull as a share of your thrust. When the path
  ends on a surface it is drawn ahead of your ship, yellow for a gentle
  touchdown and red for a crash, with a countdown. Press `T` for the full
  trajectory planner, which always draws the path in a well (green for a
  stable orbit, white for an escape). Press `L` to lock into a circular orbit
  at your current altitude and ride it hands-free while you fight; any
  thruster, the brake, a blast, `L` again or a collision releases you. Land
  gently on a planet and you ride along with it (and refuel); crash fast and
  it hurts. Touching the star destroys a ship outright, shields or not, in a
  fireball. Bodies block shots, so you can hide behind them.
- **Kinetic blast** (`P`): a cone of force from your nose that shoves rocks,
  ships and saucers away from you and kicks you backwards. It knocks belt
  rocks off their orbits into a planet, out of the well, or into an enemy,
  who is then hit by *you*; shoving a pilot into a planet or the star counts
  as your kill too. It costs energy and recharges in just over a second (the
  ring beside your hull bar). Ramming a belt rock knocks it loose as well.
- **Aliens**: saucers spray shots, hunters lead their aim and go after
  leaders. Every few minutes a **Mothership** arrives with radial barrages
  and hunter escorts; destroying it pays out big.
- **Dying** drops part of your score as orbs and two fuel cells, and credits
  your killer, including if you are knocked into a rock (or the star) shortly
  after a fight or disconnect mid-fight. On the death screen you can switch
  ship class before flying again. A new ship is protected for 3 seconds, or
  until it fires, blasts or uses its ability.
- **Kill streaks**: kills within 4 seconds of each other chain into double,
  triple and multi kills, and 3, 5, 8 and 12 kills without dying are announced
  to everyone (killing spree, rampage, unstoppable, godlike), as is the pilot
  who ends a streak.

### Ship classes

Pick a class on the menu (or the death screen). Every class levels up and
chooses weapons the same way; they differ in hull, handling and one ability on
`E`, which costs energy (shared with boost and the blast) and then recharges.

| Class | Role | Hull | Speed | Damage | Ability |
| --- | --- | --- | --- | --- | --- |
| **Fighter** | dogfighter | 100% | 100% | 100% | *Afterburner*: an instant burst of speed towards the thrusters you hold (forward by default), past the cruise limit. Dodge, chase or escape. |
| **Breaker** | rammer | 160%, big and heavy | 92% | 80%, slower fire | *Ram Drive*: a 1.2 s charge that lifts the speed limit to 1.8×. Shatters any asteroid it ploughs into, rams enemies for heavy damage and takes almost none. Breakers also shrug off half of normal rock damage. |
| **Medic** | support | 90% | 106% | 65% | *Repair Pulse*: heals every teammate around you at once. Medic shots repair teammates they hit, and teammates near a Medic regenerate. Healing pays score. |
| **Graviton** | controller | 120% | 90% | 85% | *Singularity*: a 4-second gravity well ahead of the nose (a reticle shows where it will form) that drags enemies (never teammates) and loose rocks in, rips belt rocks off their orbits and crushes whatever reaches its core. Pull defenders off an outpost, pile enemies up for your team, or drag them into the star. |

### Terrain objectives

- **Outposts**: each planet carries one on its night side (planets are tidally
  locked, so it always faces away from the star and rides along with its
  planet). Hold its zone with more pilots than the enemy to capture it (8 s
  alone, faster with up to three); both teams in the zone freeze it, and an
  empty zone drifts back to its owner. A held outpost scores 2 team points a
  second and grants its whole team a perk: the **Forge** on the dense core
  world (+15% weapon damage), the **Refinery** on the gas giant (+50% energy
  recharge) and the **Shipyard** on the rocky world (respawn landed on the
  outpost). Your team's outposts also refuel you while you are in their zone.
  Getting there means flying into a gravity well, so orbits, locks and
  landings all matter.
- **Solar flares**: every minute or two the star erupts in a wedge, announced
  6 seconds ahead with a countdown and a pulsing outline. Anything caught in
  the open is scorched (about 90 hull); planets cast safe shadows, drawn as
  dark cones, and the HUD tells you whether you are exposed or sheltered.
  Outposts are always in their planet's shadow.
- **Nebulae**: violet clouds in the open space beyond the planets' orbits.
  Inside one you are invisible to enemies further than about 320 units away:
  the server never sends your position to their clients and bots lose track of
  you. Firing, blasting or using your ability gives you away for 1.5 seconds.

## Development

```sh
npm run dev               # restart the server on file changes
npm test                  # unit + integration tests (node:test)
npm run bench -- 60       # server cost per tick and snapshot size for 60 players
TEAMS=0 npm run bench     # the same in free-for-all
npm run lag -- 80 20      # play through 80 ms each way + 20 ms jitter at :3001/play
```

[`docs/MECHANICS.md`](docs/MECHANICS.md) describes every mechanic in detail,
with its numbers and where they live in the code, plus the netcode, known
limitations and open design questions.

There is no build step: the browser loads the ES modules in `client/` and
`shared/` directly (with `modulepreload` hints). Press `F3` in game to see
ping, jitter, interpolation delay, bandwidth and prediction health.

### Layout

```
server.js              entry point (npm start)
shared/                code the server and browser both run
  constants.js         tick rate, world size, wire enums
  math.js              torus math, swept collisions, seeded RNG
  stats.js             levels, upgrades, weapons, ship classes, derived ship stats
  gravity.js           star and planets on rails, gravity, surfaces, orbits, singularity fields
  terrain.js           outposts on night sides, flare shadows, nebulae (geometry)
  physics.js           deterministic ship step (thrusters, orbit lock, blast), used for prediction
  protocol.js          binary encoders/decoders for every message
server/
  index.js             HTTP + WebSocket server (startServer)
  config.js            environment configuration
  http/static.js       allow-listed static files, cached and compressed in production
  net/                 rooms, sessions, per-client replication
  game/                the simulation: Game, entities, spatial grid, systems, bots
    teams.js           team assignment, team scores and rounds
    objectives.js      outposts and perks, solar flares, nebula stealth
    abilities.js       kinetic blast, class abilities, singularities
client/                browser game: prediction, interpolation, rendering, HUD, audio, input
public/                landing page (/), game page (/play), static assets
test/                  node:test suites
scripts/               benchmark and lag proxy
docs/MECHANICS.md      mechanics and netcode reference
```

## How the netcode works

**Authoritative server, fixed timestep.** Each room simulates at 60 Hz. Clients
send only inputs, as a button bitmask plus aim angle (12 bytes per command), and
never positions, so there is nothing to spoof. Each ship banks at most 16 input
commands, refilled one per tick. That absorbs network jitter, but flooding
commands can never move a ship faster than real time.

**Client-side prediction.** Your ship runs the same `stepShip()` as the
server, so input feels instant: thrusters, brake, coasting drag, fuel burn and
refuelling on a planet, orbit lock, the blast's recoil, the Fighter's
afterburner and the Breaker's ram drive are all predicted, and every ability's
effect and sound play the moment you press the key. Team perks that change your ship (the Refinery's energy recharge) reach
your client in the stats block and are folded into the same derivation. Snapshots carry your ship's exact state
after the last input the server applied. The client rewinds to that state and
replays the inputs that are still unacknowledged. With no outside influence
the replay lands exactly where you already were, so there is no visual
correction at all. Collisions and knockback produce small corrections, which
are blended out over about 90 ms instead of snapping.

**Interpolation and time bases.** Other ships and aliens are drawn slightly in
the past, interpolated between snapshots, with a delay that adapts to measured
jitter (about 60–130 ms). Asteroids, pickups and projectiles move in straight
lines, so they are extrapolated to the *present*, the moment your current
input reaches the server. That keeps your shots and the rocks they hit
consistent on screen. Your own shots appear the instant you fire. They are
predicted and later matched to the server's projectiles by input sequence
number. Other players' shots carry their exact age in ticks, so they leave
the muzzle where their shooter is drawn and then catch up to the present.

**Moving planets, exactly predicted.** The star and planets ride fixed
circular orbits ("on rails"), so a body's position is an exact function of
time. Clients receive the orbits once, in the welcome message, and compute
every body themselves: moving planets cost no bandwidth at all. Gravity,
landing, bouncing and the orbit lock all live in the shared ship physics.
What makes moving bodies predictable is *command time*: the server runs your
input command `n` at world tick `n + offset`, with every body posed for that
tick, and tells you the offset in each snapshot. Your client poses its own
copies for the same tick, so near a moving planet the replay still lands
exactly where you already were, even when jitter makes your commands arrive
in bursts. The offset is set when you spawn and only re-anchored if it drifts
far from world time (one tiny correction near a planet). Gravity math uses
only operations that IEEE 754 makes bit-identical in every browser.

**Singularities, predicted exactly.** A Graviton's singularity is a
temporary gravity field. The server snaps its position to the wire format and
starts it on the next command tick, and every snapshot lists the fields in
view with their lifetimes, so an enemy's client includes the pull in its
prediction for exactly the commands the server applies it to. (The first
snapshot after one appears is a correction, like any knockback.)

**Hidden means never sent.** Nebula stealth is enforced in replication: an
enemy hidden in a nebula is treated as out of view, so a modified client has
nothing to reveal. The match state (scores, outposts, the coming flare) is
sent only when it changes.

Belt rocks ride exact circular orbits around their moving planet, so each one
is sent once as orbit parameters and drawn analytically. Rocks knocked loose
(by a blast, a ram or a split) fall freely and are streamed every snapshot
while inside a well; orbital decay, relative to the planet they circle, makes
them spiral in and crash, so they never pile up. Other pilots inside a well
are drawn carried along with its planet, so a ship parked on a moving world
sits on its surface on everyone's screen.

**Bandwidth.** A compact binary protocol runs over raw WebSockets with
compression off for latency. Positions are 16-bit, and your own ship is sent
at full precision. Snapshots go out at 30 Hz with per-client interest
management: only entities in your view are sent. Ships and aliens are
streamed every snapshot. Predictable entities are sent once and then only
when their motion changes, with removals carrying a reason so clients play
the right effect. Ships a client already knows get a compact motion-only
record; their owner, level and weapon are re-sent only when they change.

## Performance

`npm run bench` runs a full room of bots and encodes a snapshot for every
player, as if each were connected. Measured on the development container in
the 8192² solar-system arena, in team mode, with bots playing the outposts,
using every class ability, blasts and thrusters:

| Players | Simulation per tick | Snapshots per round | CPU (one core) | Snapshot size | Per-client downstream |
| --- | --- | --- | --- | --- | --- |
| 40 | 0.42 ms | 0.57 ms | 4.2% | 317 B | 9.3 KiB/s |
| 80 | 0.69 ms | 1.77 ms | 9.5% | 593 B | 17.4 KiB/s |
| 160 | 1.43 ms | 5.71 ms | 26% | 1021 B | 29.9 KiB/s |
| 320 | 3.16 ms | 18.3 ms | 74% | 1826 B | 53.5 KiB/s |

Objectives concentrate the fighting: in team mode a pilot typically has about
nine ships on screen, against two in a free-for-all, and ships are streamed
every snapshot, so snapshots are larger than in free-for-all (`TEAMS=0`:
about 125 B at 40 players). Pilots also gather on planets and at outposts to
refuel, which is why the crowded 320-player room costs more than it used to.
Rooms hold 40 humans by default.

**Room size and lag.** Players only receive what is on their screen, so
per-player bandwidth depends on how crowded the arena is, not on how many
people are in the room. Growing the arena with the player count keeps it flat.
Measured in free-for-all (`TEAMS=0`), with a 4× larger arena:

| Arena | Players | CPU (one core) | Per-client downstream |
| --- | --- | --- | --- |
| 8192² | 40 | 3.8% | 3.6 KiB/s |
| 16384² | 160 | 11% | 3.4 KiB/s |
| 8192² | 80 | 8.1% | 5.1 KiB/s |
| 16384² | 320 | 25% | 4.5 KiB/s |

In team mode the objectives pull everyone to the planets whatever the arena's
size, so a larger arena helps less there.

Room size adds no latency until a room's work per tick approaches the
16.7 ms tick budget. Before that, ping and the ~70 ms interpolation buffer
dominate what players feel. Cramming more players into the same arena costs
roughly quadratically, because everyone sees more. The arena size is
`WORLD_SIZE` in `shared/constants.js` (the solar system is laid out from the
centre and needs at least 8192²); positions are 16-bit, which stays precise to
about a quarter unit up to a 16384² arena.

Collision checks and interest queries use a uniform spatial grid, so cost grows
with local density rather than with the square of the entity count. Rooms are
independent and stateless across processes. Scale up by running more rooms per
process (they open automatically when one fills) and more processes behind a
load balancer.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | | `production` serves assets from memory with brotli/gzip and ETags |
| `MAX_PLAYERS` | `40` | Humans per room before another room opens |
| `BOTS` | `10` | Bots fill each room up to this many players (`0` disables) |
| `TEAMS` | `1` | Two teams fighting over outposts in rounds; `0` for a free-for-all |
| `MAX_CONNECTIONS_PER_IP` | `8` | Simultaneous sockets per address |
| `TRUST_PROXY` | | `1` to take client IPs from `X-Forwarded-For` (only behind your own proxy) |
| `ALLOWED_ORIGINS` | | Comma-separated WebSocket origins; empty allows any |
| `DEV_TOOLS` | on unless `NODE_ENV=production` | Testing aids such as stealth (`I`); set `1` or `0` to force |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |

Bots use the same input pipeline as humans and look like normal players, so
small rooms stay lively. Set `BOTS=0` to turn them off. Most are beatable
rookies and a few are aces (`BOT.skillTiers` in `server/game/tuning.js`);
rookies aim and lead worse, react slower, pick fewer fights and shoot in
bursts. In team games bots keep the teams even, pick a mix of classes,
capture and defend outposts, hide behind planets from flares, heal teammates
and use their abilities.

Stealth (`I`) hides you from bots and aliens so you can test things
undisturbed. They stop targeting you, but stray shots and rocks can still hit.
It's a development aid, so production servers ignore it unless `DEV_TOOLS=1`.

## Deploying

- Run `npm start` with `NODE_ENV=production`. Hosts that default to
  `node server.js` or `npm start` (for example Elastic Beanstalk) work as is.
- The load balancer or proxy must allow WebSocket upgrades on `/ws`.
- `GET /healthz` returns JSON with per-room tick times and player counts, for
  health checks and monitoring.
- `SIGTERM` shuts down gracefully: clients are told the server is restarting
  and reconnect automatically.

## Extending

- **Balance**: player-facing numbers (stats, weapons, levels) live in
  `shared/stats.js`, everything else in `server/game/tuning.js`.
- **The solar system**: the star, planet sizes and densities, orbital periods,
  belts and crash damage are in `PLANETS` (`server/game/tuning.js`); the
  gravity law (strength, range, fade, landing and crash speeds) is in
  `GRAVITY` (`shared/gravity.js`).
- **Flight and abilities**: cruise and boost speeds, thruster strengths,
  coasting drag, the brake and the blast's cost, cooldown and recoil are in
  `BASE` (`shared/stats.js`); the blast's push is `BLAST` in
  `server/game/tuning.js`, its cone in `shared/constants.js`.
- **Fuel**: tank size, burn rates, refuelling on a planet and reserve power
  are in `BASE` (`shared/stats.js`); fuel cells and outpost refuelling are
  `FUEL` in `server/game/tuning.js`.
- **Ship classes**: hulls, handling and abilities are in `CLASSES` and
  `SINGULARITY` (`shared/stats.js`); what abilities do to others is in
  `ABILITY` (`server/game/tuning.js`). A new class needs an entry there, a
  hull in `traceHull` (`client/renderer.js`) and, if its ability moves the
  ship, a branch in `stepShip` so it is predicted.
- **Teams and objectives**: `ROUND`, `OUTPOST`, `FLARE` and `NEBULA` in
  `server/game/tuning.js`; outposts and nebulae are generated in
  `server/game/objectives.js`.
- **New weapon**: add an entry to `WEAPONS` in `shared/stats.js` (muzzles,
  multipliers) and list it in `WEAPON_CHOICES`. Prediction picks it up
  automatically.
- **New entity type**: add it to `EntityType`, give it a record layout in
  `shared/protocol.js`, a class in `server/game/entities.js`, a system under
  `server/game/`, and drawing in `client/renderer.js`.
- Gameplay changes that affect movement belong in `shared/physics.js` so the
  client keeps predicting exactly what the server does. Bump
  `PROTOCOL_VERSION` when the wire format changes, so outdated clients are
  asked to refresh.
