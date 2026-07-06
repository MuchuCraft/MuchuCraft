// netproxy.test.js — integration tests for the WS<->TCP proxy with a stub
// session store and a fake in-process Minecraft TCP endpoint. Needs NO real
// Minecraft server and NO network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import { createNetProxy } from '../src/netproxy.js';

// ---------------------------------------------------------------- MC bytes

/** Minecraft VarInt writer. */
function varInt(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function mcString(s) {
  const utf8 = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(utf8.length), utf8]);
}

function frame(...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([varInt(payload.length), payload]);
}

function handshake(nextState) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(25565, 0);
  return frame(varInt(0x00), varInt(774), mcString('mc.example.com'), portBuf, varInt(nextState));
}

function loginStream(name) {
  return Buffer.concat([handshake(2), frame(varInt(0x00), mcString(name), Buffer.alloc(16, 0x42))]);
}

// ----------------------------------------------------------------- harness

const SESSION_TOKEN = 'stub-session-token';
const SESSION = { userId: 7, username: 'Notch', address: 'Wa11etAddressXYZ9876' };

function startFakeMc() {
  const mc = { connections: [], server: null, port: 0 };
  mc.server = net.createServer((sock) => {
    const conn = {
      sock,
      chunks: [],
      closed: false,
      get bytes() { return Buffer.concat(this.chunks); },
    };
    sock.on('data', (c) => conn.chunks.push(c));
    sock.on('close', () => { conn.closed = true; });
    sock.on('error', () => {});
    mc.connections.push(conn);
  });
  return new Promise((resolve) => {
    mc.server.listen(0, '127.0.0.1', () => {
      mc.port = mc.server.address().port;
      resolve(mc);
    });
  });
}

async function startGateway(mcPort, opts = {}) {
  const gw = { logins: [], welcomes: [] };
  const proxy = createNetProxy({
    env: { mcHost: '127.0.0.1', mcPort, mcVersion: '1.21.11', rconPort: 1, rconPassword: 'unused' },
    sessionLookup: (token) => (token === SESSION_TOKEN ? { ...SESSION } : null),
    markLogin: (userId) => {
      gw.logins.push(userId);
      return { firstLogin: gw.logins.length === 1 };
    },
    rcon: { sendWelcome: (...args) => gw.welcomes.push(args) }, // stub: no real RCON
    rconDelayMs: 20,
    ...opts,
  });
  const app = express();
  app.use('/api/vm/net', proxy.router);
  gw.server = http.createServer(app);
  proxy.handleUpgrade(gw.server);
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  gw.port = gw.server.address().port;
  gw.base = `http://127.0.0.1:${gw.port}/api/vm/net`;
  gw.wsBase = `ws://127.0.0.1:${gw.port}/api/vm/net`;
  return gw;
}

async function withStack(t, fn, opts = {}) {
  const mc = await startFakeMc();
  const gw = await startGateway(mc.port, opts);
  gw.wsClients = [];
  // Upgraded WS sockets are not covered by closeAllConnections(), so they
  // must be terminated BEFORE server.close() or teardown hangs forever.
  t.after(async () => {
    for (const ws of gw.wsClients) ws.terminate();
    for (const conn of mc.connections) conn.sock.destroy();
    gw.server.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => gw.server.close(resolve)),
      new Promise((resolve) => mc.server.close(resolve)),
    ]);
  });
  await fn({ mc, gw });
}

function postConnect(gw, { token, body = { host: 'mc.example.com', port: 25565 } } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${gw.base}/connect`, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** Open a WS against the gateway; tracked so teardown can terminate it. */
function openWs(gw, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}${pathAndQuery}`);
    gw.wsClients?.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the next WS message as {data:Buffer, isBinary}. */
function nextMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs);
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data: Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary });
    });
  });
}

function waitClose(ws, timeoutMs = 2000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws close')), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// -------------------------------------------------------------- HTTP layer

test('GET /connect is an unauthenticated 200 health probe', async (t) => {
  await withStack(t, async ({ gw }) => {
    const res = await fetch(`${gw.base}/connect`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, 200);
    assert.equal(typeof body.description, 'string');
    assert.equal(typeof body.time, 'number');
  });
});

test('OPTIONS preflight allows Authorization and Content-Type', async (t) => {
  await withStack(t, async ({ gw }) => {
    const res = await fetch(`${gw.base}/connect`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://elsewhere.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const allowed = res.headers.get('access-control-allow-headers').toLowerCase();
    assert.match(allowed, /authorization/);
    assert.match(allowed, /content-type/);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });
});

test('POST /connect without a token -> 403 JSON error', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, {});
    // SPEC E2E case 3: "no/garbage Bearer on /connect -> 403"
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(mc.connections.length, 0, 'must not dial the MC server');
  });
});

test('POST /connect with a bad token -> 403 JSON error, no dial', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: 'garbage-token' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'You are not allowed to connect to this server');
    assert.equal(mc.connections.length, 0, 'must not dial the MC server');
  });
});

test('POST /connect without host/port -> 400', async (t) => {
  await withStack(t, async ({ gw }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN, body: {} });
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  });
});

// -------------------------------------------------------------- happy path

test('happy path: connect -> WS -> sniffed login -> piped both ways', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    // 1. POST /connect (requested destination differs; proxy must ignore it)
    const res = await postConnect(gw, {
      token: SESSION_TOKEN,
      body: { host: 'evil.example.com', port: 31337 },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.token, /^[0-9a-f]{64}$/, 'fresh 32-byte hex connection token');
    // NOTES.md: remote is the socket.address() OBJECT, not a string
    assert.equal(typeof body.remote, 'object');
    assert.equal(typeof body.remote.address, 'string');
    assert.equal(typeof body.remote.family, 'string');
    assert.equal(typeof body.remote.port, 'number');
    await waitFor(() => mc.connections.length === 1, 'dial of OUR mc host despite evil request');
    const conn = mc.connections[0];

    // 2. WS attach + stream handshake/login split across two frames
    const ws = await openWs(gw, `/socket?token=${body.token}`);
    const stream = loginStream('Notch');
    ws.send(stream.subarray(0, 11), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 30)); // force real split
    assert.equal(conn.bytes.length, 0, 'nothing forwarded before the verdict');
    ws.send(stream.subarray(11), { binary: true });

    // 3. all buffered bytes reach the fake MC server byte-for-byte
    await waitFor(() => conn.bytes.length >= stream.length, 'login bytes at MC');
    assert.deepEqual(conn.bytes, stream);

    // 4. server -> client bytes come back as binary WS frames
    const fromServer = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const echoPromise = nextMessage(ws);
    conn.sock.write(fromServer);
    const echoed = await echoPromise;
    assert.equal(echoed.isBinary, true);
    assert.deepEqual(echoed.data, fromServer);

    // 5. post-verdict client bytes are piped straight through
    const more = Buffer.from([1, 2, 3, 4, 5]);
    ws.send(more, { binary: true });
    await waitFor(
      () => conn.bytes.length >= stream.length + more.length,
      'piped follow-up bytes',
    );
    assert.deepEqual(conn.bytes.subarray(stream.length), more);

    // 6. latency ping rides the DATA socket: ping:<id> -> exactly pong:<id>
    const pongPromise = nextMessage(ws);
    ws.send('ping:1234');
    const pong = await pongPromise;
    assert.equal(pong.isBinary, false);
    assert.equal(pong.data.toString(), 'pong:1234');

    // 7. markLogin + delayed rcon welcome with short wallet address
    assert.deepEqual(gw.logins, [SESSION.userId]);
    await waitFor(() => gw.welcomes.length === 1, 'rcon welcome');
    assert.deepEqual(gw.welcomes[0], ['Notch', 'Wa11…9876', true]);

    // 8. closing the WS destroys the TCP leg
    ws.close();
    await waitFor(() => conn.closed, 'MC socket closed after WS close');
  });
});

test('status ping (nextState 1) pipes without username enforcement', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    const ws = await openWs(gw, `/socket?token=${token}`);
    const stream = Buffer.concat([handshake(1), frame(varInt(0x00))]); // handshake + Status Request
    ws.send(stream, { binary: true });
    await waitFor(() => mc.connections[0]?.bytes.length >= stream.length, 'status bytes at MC');
    assert.deepEqual(mc.connections[0].bytes, stream);
    assert.equal(gw.logins.length, 0, 'status must not markLogin');
    assert.equal(gw.welcomes.length, 0, 'status must not welcome');
  });
});

// ------------------------------------------------------------- enforcement

test('username mismatch -> proxy-shutdown frame, both ends killed, no bytes leak', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    const ws = await openWs(gw, `/socket?token=${token}`);
    const shutdownPromise = nextMessage(ws);
    ws.send(loginStream('Impostor'), { binary: true });
    const msg = await shutdownPromise;
    assert.equal(msg.isBinary, false);
    assert.equal(msg.data.toString(), 'proxy-shutdown:username does not match your wallet session');
    await waitClose(ws);
    await waitFor(() => mc.connections[0].closed, 'MC socket destroyed');
    assert.equal(mc.connections[0].bytes.length, 0, 'no impostor bytes reach the MC server');
    assert.equal(gw.logins.length, 0, 'markLogin must not fire');
    assert.equal(gw.welcomes.length, 0, 'rcon welcome must not fire');
  });
});

test('garbage handshake bytes -> proxy-shutdown, nothing forwarded', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    const ws = await openWs(gw, `/socket?token=${token}`);
    const shutdownPromise = nextMessage(ws);
    ws.send(Buffer.alloc(8, 0xff), { binary: true }); // malformed VarInt
    const msg = await shutdownPromise;
    assert.equal(msg.isBinary, false);
    assert.match(msg.data.toString(), /^proxy-shutdown:/);
    await waitClose(ws);
    assert.equal(mc.connections[0].bytes.length, 0);
  });
});

test('sniff timeout with no login -> proxy-shutdown + close', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    const ws = await openWs(gw, `/socket?token=${token}`);
    const msg = await nextMessage(ws); // send nothing; wait for the timeout
    assert.equal(msg.isBinary, false);
    assert.match(msg.data.toString(), /^proxy-shutdown:/);
    await waitClose(ws);
    await waitFor(() => mc.connections[0].closed, 'MC socket destroyed');
  }, { sniffTimeoutMs: 60 });
});

// ------------------------------------------------------------ token rules

test('connection token is single-use: second WS is closed with no frame', async (t) => {
  await withStack(t, async ({ gw }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    const ws1 = await openWs(gw, `/socket?token=${token}`);

    const ws2 = await openWs(gw, `/socket?token=${token}`);
    const messages = [];
    ws2.on('message', (data) => messages.push(data.toString()));
    await waitClose(ws2);
    assert.deepEqual(messages, [], 'reference behavior: close immediately, no frame');

    // first claimant still works
    const pongPromise = nextMessage(ws1);
    ws1.send('ping:ok');
    assert.equal((await pongPromise).data.toString(), 'pong:ok');
  });
});

test('unknown connection token -> immediate close, no frame', async (t) => {
  await withStack(t, async ({ gw }) => {
    const ws = await openWs(gw, `/socket?token=${'0'.repeat(64)}`);
    const messages = [];
    ws.on('message', (data) => messages.push(data.toString()));
    await waitClose(ws);
    assert.deepEqual(messages, []);
  });
});

test('missing token query param -> immediate close', async (t) => {
  await withStack(t, async ({ gw }) => {
    const ws = await openWs(gw, `/socket`);
    await waitClose(ws);
  });
});

test('unclaimed connection token expires and its TCP leg is destroyed', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    await waitFor(() => mc.connections[0]?.closed, 'pending dial reaped after TTL');
    const ws = await openWs(gw, `/socket?token=${token}`);
    await waitClose(ws); // expired token behaves like an unknown one
  }, { claimTtlMs: 50 });
});

test('each POST /connect mints a distinct token', async (t) => {
  await withStack(t, async ({ gw }) => {
    const a = await (await postConnect(gw, { token: SESSION_TOKEN })).json();
    const b = await (await postConnect(gw, { token: SESSION_TOKEN })).json();
    assert.match(a.token, /^[0-9a-f]{64}$/);
    assert.match(b.token, /^[0-9a-f]{64}$/);
    assert.notEqual(a.token, b.token);
  });
});

// ------------------------------------------------------------------- misc

test('WS /api/vm/net/ping answers ping:<id> with pong:<id>', async (t) => {
  await withStack(t, async ({ gw }) => {
    const ws = await openWs(gw, `/ping`);
    const pongPromise = nextMessage(ws);
    ws.send('ping:abc-123');
    const msg = await pongPromise;
    assert.equal(msg.isBinary, false);
    assert.equal(msg.data.toString(), 'pong:abc-123');
  });
});

test('TCP close from the MC side -> proxy-shutdown then WS close', async (t) => {
  await withStack(t, async ({ gw, mc }) => {
    const res = await postConnect(gw, { token: SESSION_TOKEN });
    const { token } = await res.json();
    const ws = await openWs(gw, `/socket?token=${token}`);
    ws.send(loginStream('Notch'), { binary: true });
    await waitFor(() => mc.connections[0]?.bytes.length > 0, 'login piped');
    const shutdownPromise = nextMessage(ws);
    mc.connections[0].sock.destroy(); // MC drops the connection
    const msg = await shutdownPromise;
    assert.equal(msg.isBinary, false);
    assert.match(msg.data.toString(), /^proxy-shutdown:/);
    await waitClose(ws);
  });
});

test('POST /connect when the MC server is down -> 5xx JSON error', async (t) => {
  // no fake MC here: dial a port that nothing listens on
  const gw = await startGateway(1); // port 1: always refused on loopback
  t.after(async () => {
    gw.server.closeAllConnections?.();
    await new Promise((resolve) => gw.server.close(resolve));
  });
  const res = await postConnect(gw, { token: SESSION_TOKEN });
  assert.ok(res.status === 502 || res.status === 504, `got ${res.status}`);
  assert.equal(typeof (await res.json()).error, 'string');
});
