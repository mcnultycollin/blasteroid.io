import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { Button, KickReason, PROTOCOL_VERSION } from '../shared/constants.js';
import {
  BinaryReader,
  BinaryWriter,
  ServerMsg,
  encodeInput,
  encodeJoin,
  encodePing,
  readEntity,
  readSnapshot,
  readWelcome,
} from '../shared/protocol.js';
import { startServer } from '../server/index.js';

let app;
let base;

before(async () => {
  process.env.LOG_LEVEL = 'silent';
  app = await startServer({ port: 0, host: '127.0.0.1', botTarget: 0, production: false });
  base = `127.0.0.1:${app.port}`;
});

after(async () => {
  await app.close();
});

/** Minimal protocol client that records decoded messages. */
class TestClient {
  constructor() {
    this.writer = new BinaryWriter(64);
    this.messages = [];
    this.selves = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocket(`ws://${base}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data) => this.receive(data));
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      this.notify();
    });
    this.opened = new Promise((resolve) => this.ws.on('open', resolve));
  }

  receive(data) {
    const r = new BinaryReader(data);
    const type = r.u8();
    const msg = { type };
    if (type === ServerMsg.WELCOME) Object.assign(msg, readWelcome(r));
    if (type === ServerMsg.JOINED) msg.playerId = r.u16();
    if (type === ServerMsg.KICK) msg.reason = r.u8();
    if (type === ServerMsg.SNAPSHOT) {
      readSnapshot(r, {
        begin: () => {},
        self: (s) => this.selves.push({ ...s }),
        stats: () => {},
        spectate: () => (msg.spectating = true),
        remove: () => {},
        entity: (t, id, reader) => readEntity(t, reader, {}),
        event: () => {},
        end: () => {},
      });
    }
    this.messages.push(msg);
    this.notify();
  }

  notify() {
    for (const w of this.waiters.splice(0)) w();
  }

  async waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = predicate(this);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  send(bytes) {
    this.ws.send(bytes);
  }

  close() {
    this.ws.close();
  }
}

test('welcome, join, spawn, and inputs move the ship', async () => {
  const c = new TestClient();
  await c.opened;
  const welcome = await c.waitFor(() => c.messages.find((m) => m.type === ServerMsg.WELCOME));
  assert.equal(welcome.version, PROTOCOL_VERSION);
  await c.waitFor(() => c.messages.find((m) => m.spectating), 2000);

  // Regression: input before joining used to crash the server.
  c.send(encodeInput(c.writer, 1, Button.THRUST, 0));
  c.send(encodeJoin(c.writer, 'Integration'));
  const joined = await c.waitFor(() => c.messages.find((m) => m.type === ServerMsg.JOINED));
  assert.ok(joined.playerId > 0);
  const first = await c.waitFor(() => c.selves[0]);

  let seq = 1;
  for (let i = 0; i < 40; i++) {
    c.send(encodeInput(c.writer, ++seq, Button.THRUST, 0));
    await new Promise((r) => setTimeout(r, 5));
  }
  const moved = await c.waitFor(() => c.selves.find((s) => s.ackSeq === seq));
  assert.notEqual(moved.x, first.x);
  c.close();
});

test('malformed messages do not take the server down', async () => {
  const c = new TestClient();
  await c.opened;
  c.send(new Uint8Array([2, 0])); // truncated input
  c.send(new Uint8Array([99, 1, 2, 3])); // unknown type
  c.send(new Uint8Array([]));
  c.send(encodePing(c.writer, 123));
  await c.waitFor(() => c.messages.find((m) => m.type === ServerMsg.PONG));
  const health = await fetch(`http://${base}/healthz`).then((r) => r.json());
  assert.equal(health.status, 'ok');
  c.close();
});

test('text frames are rejected and an outdated client is told to refresh', async () => {
  const text = new TestClient();
  await text.opened;
  text.ws.send('hello');
  await text.waitFor(() => text.closed);
  assert.equal(text.messages.find((m) => m.type === ServerMsg.KICK)?.reason, KickReason.ABUSE);

  const old = new TestClient();
  await old.opened;
  old.send(new BinaryWriter().u8(1).u8(PROTOCOL_VERSION + 1).str('Old').finish());
  await old.waitFor(() => old.closed);
  assert.equal(old.messages.find((m) => m.type === ServerMsg.KICK)?.reason, KickReason.OUTDATED);
});

test('static files are served from the allow-list only', async () => {
  const get = (path, init) => fetch(`http://${base}${path}`, init);
  for (const path of ['/', '/play', '/demo', '/static/game.css', '/client/main.js', '/shared/protocol.js']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.match((await get('/client/main.js')).headers.get('content-type'), /javascript/);
  for (const path of ['/server.js', '/server/index.js', '/package.json', '/%2e%2e/server.js', '/static/../server.js']) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.equal((await get('/', { method: 'POST' })).status, 405);
  const etag = (await get('/play')).headers.get('etag');
  assert.equal((await get('/play', { headers: { 'If-None-Match': etag } })).status, 304);
});

test('production mode serves compressed, cached assets', async () => {
  const prod = await startServer({ port: 0, host: '127.0.0.1', botTarget: 0, production: true });
  try {
    const res = await fetch(`http://127.0.0.1:${prod.port}/client/main.js`, { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.ok((await res.text()).includes('GameClient'), 'body decodes correctly');
  } finally {
    await prod.close();
  }
});
