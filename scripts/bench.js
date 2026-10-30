#!/usr/bin/env node
/**
 * Server performance benchmark: runs a room full of bots as fast as possible
 * and reports simulation cost per tick plus snapshot encoding cost and size,
 * as if every bot were a connected client.
 *
 *   npm run bench            # 60 players
 *   npm run bench -- 120     # 120 players
 */
import { SNAPSHOT_INTERVAL, TICK_MS, TICK_RATE } from '../shared/constants.js';
import { BinaryWriter, SnapshotWriter } from '../shared/protocol.js';
import { Game } from '../server/game/Game.js';
import { buildSnapshot } from '../server/net/replication.js';
import { Session } from '../server/net/Session.js';

const players = Number(process.argv[2] ?? 60);
const seconds = Number(process.argv[3] ?? 60);
const fakeSocket = { readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() {} };

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function report(label, samples) {
  const sorted = Float64Array.from(samples).sort();
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const f = (n) => n.toFixed(3).padStart(7);
  console.log(
    `${label.padEnd(22)} avg ${f(avg)}  p50 ${f(percentile(sorted, 0.5))}  p95 ${f(percentile(sorted, 0.95))}  p99 ${f(percentile(sorted, 0.99))}  max ${f(sorted.at(-1))}`,
  );
  return avg;
}

const game = new Game({ seed: 1234, botTarget: players });
console.log(`Warming up ${players} bots...`);
for (let i = 0; i < TICK_RATE * 20; i++) game.step();

// One session per bot, as if each were a human receiving snapshots.
const sessions = [...game.players.values()].map((player) => {
  const s = new Session(fakeSocket, 'bench');
  s.player = player;
  return s;
});
const writer = new SnapshotWriter(new BinaryWriter(64 * 1024));

const tickMs = [];
const snapshotMs = [];
let snapshotBytes = 0;
let snapshotCount = 0;
let maxEntities = 0;
const ticks = TICK_RATE * seconds;
for (let i = 0; i < ticks; i++) {
  let t0 = performance.now();
  game.step();
  game.clearOutbox();
  tickMs.push(performance.now() - t0);
  if (game.tick % SNAPSHOT_INTERVAL === 0) {
    t0 = performance.now();
    for (const s of sessions) {
      const bytes = buildSnapshot(game, s, writer, null);
      snapshotBytes += bytes.length;
      snapshotCount++;
    }
    snapshotMs.push(performance.now() - t0);
  }
  maxEntities = Math.max(maxEntities, game.lists.reduce((n, list) => n + list.length, 0));
}

console.log(`\n${players} players, ${seconds}s simulated, up to ${maxEntities} entities`);
const sim = report('simulation ms/tick', tickMs);
const rep = report(`snapshots ms/${sessions.length} cl`, snapshotMs);
const perTick = sim + rep / SNAPSHOT_INTERVAL;
const bytesPerSnapshot = snapshotBytes / snapshotCount;
console.log(`average snapshot       ${bytesPerSnapshot.toFixed(0)} bytes (${((bytesPerSnapshot * TICK_RATE) / SNAPSHOT_INTERVAL / 1024).toFixed(1)} KiB/s per client)`);
console.log(`budget used            ${((perTick / TICK_MS) * 100).toFixed(1)}% of one core per room`);
