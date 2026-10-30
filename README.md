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

**Bandwidth.** A compact binary protocol runs over raw WebSockets with
compression off for latency. Positions are 16-bit, and your own ship is sent
at full precision. Snapshots go out at 30 Hz with per-client interest
management: only entities in your view are sent. Ships and aliens are
streamed every snapshot. Predictable entities are sent once and then only
when their motion changes, with removals carrying a reason so clients play
the right effect.

## Performance

`npm run bench` runs a full room of bots and encodes a snapshot for every
player, as if each were connected. Measured on the development container:

| Players | Simulation per tick | Snapshots per round | CPU (one core) | Snapshot size | Per-client downstream |
| --- | --- | --- | --- | --- | --- |
| 20 | 0.08 ms | 0.13 ms | 0.9% | 94 B | 2.8 KiB/s |
| 40 | 0.18 ms | 0.42 ms | 2.4% | 129 B | 3.8 KiB/s |
| 80 | 0.35 ms | 1.27 ms | 5.9% | 190 B | 5.6 KiB/s |

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
