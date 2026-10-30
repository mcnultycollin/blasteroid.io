#!/usr/bin/env node
/**
 * Plays the game through artificial latency and jitter, so netcode changes can
 * be felt before players feel them. Delays every chunk of TCP data in both
 * directions while preserving byte order, exactly like a slow real link.
 *
 *   npm start                        # game server on :3000
 *   npm run lag -- 80 20             # proxy :3001 -> :3000, 80 ms each way + up to 20 ms jitter
 *   open http://localhost:3001/play  # press F3 in game for the netgraph
 *
 * Arguments: [oneWayMs=60] [jitterMs=15] [listenPort=3001] [targetPort=3000]
 */
import net from 'node:net';

const [oneWay = 60, jitter = 15, listenPort = 3001, targetPort = 3000] = process.argv.slice(2).map(Number);

/** Forwards `from` to `to` with delay; one FIFO and one timer per direction so data is never reordered. */
function delayedPipe(from, to) {
  const queue = [];
  let timer = null;
  let lastDue = 0;
  const flush = () => {
    timer = null;
    const now = Date.now();
    while (queue.length > 0 && queue[0].due <= now) {
      const { chunk } = queue.shift();
      if (!to.destroyed) to.write(chunk);
    }
    if (queue.length > 0) timer = setTimeout(flush, queue[0].due - now);
  };
  from.on('data', (chunk) => {
    lastDue = Math.max(lastDue, Date.now() + oneWay + Math.random() * jitter);
    queue.push({ due: lastDue, chunk });
    timer ??= setTimeout(flush, lastDue - Date.now());
  });
  from.on('close', () => setTimeout(() => to.destroy(), oneWay + jitter + 10));
  from.on('error', () => from.destroy());
}

net
  .createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    delayedPipe(client, upstream);
    delayedPipe(upstream, client);
  })
  .listen(listenPort, () => {
    console.log(
      `Lag proxy on http://localhost:${listenPort}/play -> :${targetPort} ` +
        `(${oneWay} ms each way, +0-${jitter} ms jitter, ~${2 * oneWay + jitter} ms ping)`,
    );
  });
