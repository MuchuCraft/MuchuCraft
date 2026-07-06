// token-bridge.test.js — bridge-client against an in-process HTTP stub
// (loopback only, no real plugin): Bearer auth header, typed errors, timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeClient, BridgeError } from '../src/token/bridge-client.js';

const TOKEN = 'stub-bridge-token';

function stubBridge(t, { hang = false } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (hang) return; // never respond — client must time out
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (req.url === '/health') return send(200, { ok: true, economy: 'EssentialsX' });
    if (req.url === '/balances') {
      return send(200, { balances: { Alice: '12.34', Bob: '0.5' } });
    }
    if (req.url.startsWith('/balance')) {
      const player = new URL(req.url, 'http://x').searchParams.get('player');
      if (player === 'Ghost') return send(404, { error: 'player has never joined' });
      return send(200, { player, balance: '123.45' });
    }
    if (req.url === '/debit') {
      const { amount } = JSON.parse(body);
      if (amount === '999999') return send(409, { error: 'insufficient' });
      return send(200, { ok: true, newBalance: '75' });
    }
    if (req.url === '/credit') return send(200, { ok: true, newBalance: '100' });
    send(400, { error: 'bad request' });
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return new Promise((resolve) => {
    server.on('listening', () => {
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, seen });
    });
  });
}

test('sends Bearer BRIDGE_TOKEN and speaks the documented endpoints', async (t) => {
  const { baseUrl, seen } = await stubBridge(t);
  const bridge = createBridgeClient({ baseUrl, token: TOKEN });
  assert.deepEqual(await bridge.health(), { ok: true, economy: 'EssentialsX' });
  assert.equal(await bridge.balance('Alice B'), '123.45');
  assert.deepEqual(await bridge.debit({ player: 'Alice', amount: '25', ref: 'withdraw:1' }),
    { ok: true, newBalance: '75' });
  assert.deepEqual(await bridge.credit({ player: 'Alice', amount: '25', ref: 'withdraw:1:refund' }),
    { ok: true, newBalance: '100' });
  assert.deepEqual(await bridge.balances(['Alice', 'Bob', 'Ghost']), { Alice: '12.34', Bob: '0.5' });
  for (const r of seen) assert.equal(r.auth, `Bearer ${TOKEN}`);
  assert.equal(seen[1].url, '/balance?player=Alice%20B', 'player name URL-encoded');
  assert.deepEqual(JSON.parse(seen[2].body), { player: 'Alice', amount: '25', ref: 'withdraw:1' });
});

test('typed errors: 409 insufficient, 404 not-found, 401 unauthorized', async (t) => {
  const { baseUrl } = await stubBridge(t);
  const bridge = createBridgeClient({ baseUrl, token: TOKEN });
  await assert.rejects(
    () => bridge.debit({ player: 'Alice', amount: '999999', ref: 'x' }),
    (err) => err instanceof BridgeError && err.code === 'INSUFFICIENT' && err.status === 409,
  );
  await assert.rejects(
    () => bridge.balance('Ghost'),
    (err) => err instanceof BridgeError && err.code === 'NOT_FOUND' && !err.retryable,
  );
  const badAuth = createBridgeClient({ baseUrl, token: 'wrong' });
  await assert.rejects(
    () => badAuth.health(),
    (err) => err instanceof BridgeError && err.code === 'UNAUTHORIZED',
  );
});

test('network refusal and timeouts surface as retryable UNAVAILABLE', async (t) => {
  // connection refused
  const dead = createBridgeClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 500 });
  await assert.rejects(
    () => dead.health(),
    (err) => err instanceof BridgeError && err.code === 'UNAVAILABLE' && err.retryable === true,
  );
  // hung server: the 2s-default timeout (here 150ms) aborts the request
  const { baseUrl } = await stubBridge(t, { hang: true });
  const slow = createBridgeClient({ baseUrl, token: TOKEN, timeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(
    () => slow.balance('Alice'),
    (err) => err instanceof BridgeError && err.code === 'UNAVAILABLE' && err.retryable === true,
  );
  assert.ok(Date.now() - started < 2_000, 'aborted by the client timeout, not the test runner');
});
