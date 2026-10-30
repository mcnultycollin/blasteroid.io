# Blasteroid.io

A retro multiplayer space shooter for the browser. Classic Asteroids vector
graphics and physics, rebuilt as an .io game: a shared arena, PvP, aliens,
endless play, and a ship that grows stronger the longer you survive.

```sh
npm install
npm start            # http://localhost:3000/play
```

Requires Node.js 20 or newer. The only runtime dependency is
[`ws`](https://github.com/websockets/ws).

## Playing

| Action | Mouse + keyboard | Classic keys | Touch |
| --- | --- | --- | --- |
| Aim / turn | move the mouse | `A` `D` or arrows | drag left side |
| Thrust | right click or `W` | `W` / `↑` | drag left side |
| Fire | left click or `Space` | `Space` | hold right side |
| Brake | `S` | `S` / `↓` | |
| Boost | `Shift` | `Shift` | drag the stick far |
| Upgrade a stat | `1`–`8` or click the panel | | tap the panel |
| Choose a weapon (level 10) | `Z` `X` `C` or click | | tap a card |
| Mute / netgraph | `M` / `F3` | | |

- **Score** comes from asteroids (smaller is worth more), aliens, other
  pilots and the orbs they drop, plus a trickle for staying alive and active.
- **Levels** (up to 40) each grant an upgrade point for one of eight stats:
  hull, repair, engines, handling, damage, velocity, reload and energy.
  Veterans also see a little further.
- **At level 10** pick a weapon: *Twin* (parallel shots), *Scatter*
  (three-way spread) or *Cannon* (slow, heavy, long range).
- **Power-ups**: Shield, Rapid fire, Repair and Overdrive (unlimited boost).
- **Planets**: each has a gravity well, shown as a dashed ring, that tugs
  your ship and holds a belt of orbiting rocks. A planet's mass comes from
  its size × density, so small dense cores pull hardest near the surface
  (sometimes harder than your engines; the HUD shows the pull as a share of
  your thrust). Touch down gently to land; crash fast and it hurts. Planets
  also block shots, so you can hide behind them.
- **Aliens**: saucers spray shots, hunters lead their aim and go after
  leaders. Every few minutes a **Mothership** arrives with radial barrages
  and hunter escorts; destroying it pays out big.
- **Dying** drops part of your score as orbs and credits your killer, including
  if you are knocked into a rock shortly after a fight or disconnect mid-fight.

## Development

```sh
npm run dev               # restart the server on file changes
npm test                  # unit + integration tests (node:test)
npm run bench -- 60       # server cost per tick and snapshot size for 60 players
npm run lag -- 80 20      # play through 80 ms each way + 20 ms jitter at :3001/play
```

There is no build step: the browser loads the ES modules in `client/` and
`shared/` directly (with `modulepreload` hints). Press `F3` in game to see
ping, jitter, interpolation delay, bandwidth and prediction health.

### Layout

```
server.js              entry point (npm start)
shared/                code the server and browser both run
  constants.js         tick rate, world size, wire enums
  math.js              torus math, swept collisions, seeded RNG
  stats.js             levels, upgrades, weapons, derived ship stats
  physics.js           deterministic ship step, used for prediction
  protocol.js          binary encoders/decoders for every message
server/
  index.js             HTTP + WebSocket server (startServer)
  config.js            environment configuration
  http/static.js       allow-listed static files, cached and compressed in production
  net/                 rooms, sessions, per-client replication
  game/                the simulation: Game, entities, spatial grid, systems, bots
client/                browser game: prediction, interpolation, rendering, HUD, audio, input
public/                landing page (/), game page (/play), static assets
test/                  node:test suites
scripts/               benchmark and lag proxy
```

## How the netcode works

**Authoritative server, fixed timestep.** Each room simulates at 60 Hz. Clients
send only inputs, as a button bitmask plus aim angle (9 bytes per command), and
never positions, so there is nothing to spoof. Each ship banks at most 16 input
commands, refilled one per tick. That absorbs network jitter, but flooding
commands can never move a ship faster than real time.

**Client-side prediction.** Your ship runs the same `stepShip()` as the
server, so input feels instant. Snapshots carry your ship's exact state
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
number. Other players' shots leave their muzzle and then catch up to the
present.

**Gravity.** Planets never move, and every client receives them once. Gravity,
landing and bouncing all live in the shared ship physics, so your ship's
motion near a planet is predicted exactly, with no corrections. Gravity math
uses only operations that IEEE 754 makes bit-identical in every browser.
Belt rocks ride exact circular orbits, so each one is sent once as orbit
parameters and drawn analytically. Only rocks knocked loose inside a well are
streamed every snapshot; orbital decay makes them spiral in and crash, so they
never pile up.

**Bandwidth.** A compact binary protocol runs over raw WebSockets with
compression off for latency. Positions are 16-bit, and your own ship is sent
at full precision. Snapshots go out at 30 Hz with per-client interest
management: only entities in your view are sent. Ships and aliens are
streamed every snapshot. Predictable entities are sent once and then only
when their motion changes, with removals carrying a reason so clients play
the right effect.

## Performance

`npm run bench` runs a full room of bots and encodes a snapshot for every
player, as if each were connected. Measured on the development container,
with planets:

| Players | Simulation per tick | Snapshots per round | CPU (one core) | Snapshot size | Per-client downstream |
| --- | --- | --- | --- | --- | --- |
| 40 | 0.22 ms | 0.47 ms | 2.7% | 133 B | 3.9 KiB/s |
| 80 | 0.50 ms | 1.55 ms | 7.6% | 198 B | 5.8 KiB/s |
| 160 | 0.94 ms | 4.16 ms | 18% | 338 B | 9.9 KiB/s |
| 320 | 1.84 ms | 11.6 ms | 46% | 566 B | 16.6 KiB/s |

**Room size and lag.** Players only receive what is on their screen, so
per-player bandwidth depends on how crowded the arena is, not on how many
people are in the room. Growing the arena with the player count keeps it flat.
Measured with a 4× larger arena:

| Arena | Players | CPU (one core) | Per-client downstream |
| --- | --- | --- | --- |
| 6144² | 40 | 2.7% | 3.9 KiB/s |
| 12288² | 160 | 12% | 3.8 KiB/s |
| 6144² | 80 | 7.6% | 5.8 KiB/s |
| 12288² | 320 | 32% | 5.7 KiB/s |

Room size adds no latency until a room's work per tick approaches the
16.7 ms tick budget. Before that, ping and the ~70 ms interpolation buffer
dominate what players feel. Cramming more players into the same arena costs
roughly quadratically, because everyone sees more. The arena size is
`WORLD_SIZE` in `shared/constants.js`; positions are 16-bit, which stays
precise to about 0.2 units up to a 12288² arena.

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
| `MAX_CONNECTIONS_PER_IP` | `8` | Simultaneous sockets per address |
| `TRUST_PROXY` | | `1` to take client IPs from `X-Forwarded-For` (only behind your own proxy) |
| `ALLOWED_ORIGINS` | | Comma-separated WebSocket origins; empty allows any |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |

Bots use the same input pipeline as humans and look like normal players, so
small rooms stay lively. Set `BOTS=0` to turn them off.

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
- **Planets**: count, sizes, densities, belts and crash damage are in
  `PLANETS` (`server/game/tuning.js`); the gravity law (strength, range, fade,
  landing) is in `GRAVITY` (`shared/gravity.js`).
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
