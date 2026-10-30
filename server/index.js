/**
 * HTTP + WebSocket server. `startServer()` is used by the entry point and by
 * the integration tests (pass `port: 0` for a random free port).
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { createStaticHandler } from './http/static.js';
import { log } from './log.js';
import { RoomManager } from './net/RoomManager.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CLIENT_MESSAGE_BYTES = 512;

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function startServer(overrides = {}) {
  const options = { ...config, ...overrides };
  const rooms = new RoomManager(options);
  const serveStatic = await createStaticHandler({ root: ROOT, production: options.production });

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), ...rooms.stats() }));
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false, // compression costs latency and CPU; the protocol is already compact
    clientTracking: false,
  });
  const connectionsPerIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') return rejectUpgrade(socket, 404);
    if (options.allowedOrigins.length > 0 && !options.allowedOrigins.includes(req.headers.origin)) {
      return rejectUpgrade(socket, 403);
    }
    const ip = clientIp(req, options.trustProxy);
    if ((connectionsPerIp.get(ip) ?? 0) >= options.maxConnectionsPerIp) return rejectUpgrade(socket, 429);
    wss.handleUpgrade(req, socket, head, (ws) => {
      connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const n = (connectionsPerIp.get(ip) ?? 1) - 1;
        if (n > 0) connectionsPerIp.set(ip, n);
        else connectionsPerIp.delete(ip);
      });
      rooms.connect(ws, ip);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  rooms.start();
  const { port } = server.address();
  log.info(`Blasteroid.io listening on http://localhost:${port} (${options.production ? 'production' : 'development'})`);

  async function close() {
    rooms.shutdown();
    wss.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { port, server, rooms, close };
}
