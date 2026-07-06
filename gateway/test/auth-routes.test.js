// auth-routes.test.js — boots createApp on an ephemeral port and drives the
// FULL auth flow over real HTTP with a tweetnacl fake wallet. No network
// beyond localhost, no Minecraft server, in-memory DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createApp } from '../src/index.js';
import { createDb } from '../src/db.js';

// Repo root, so the static dirs (gateway/public/{login,site}, client/dist)
// resolve to the real in-repo files regardless of the test runner's cwd.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const CONFIG = {
  port: 0,
  mcHost: '127.0.0.1',
  mcPort: 25565,
  mcVersion: '1.21.11',
  rconPort: 25575,
  rconPassword: 'test',
  sessionTtlHours: 24,
  siwsDomain: 'localhost:8080',
  siwsUri: 'http://localhost:8080/login/',
  dbPath: ':memory:',
  root: REPO_ROOT,
};

function makeWallet() {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    signMessage: (str) => nacl.sign.detached(Buffer.from(str, 'utf8'), kp.secretKey),
  };
}

function boot(t, { limits } = {}) {
  const db = createDb(':memory:');
  const { app } = createApp({ config: CONFIG, db, limits });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    db.close();
  });
  return new Promise((resolve) => {
    server.on('listening', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, db });
    });
  });
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}

test('full flow: nonce -> sign -> verify -> session -> username status', async (t) => {
  const { base } = await boot(t);
  const wallet = makeWallet();

  // 1. nonce (register mode for a fresh name)
  const nonceRes = await post(base, '/api/auth/nonce', { username: 'TestUser', address: wallet.address });
  assert.equal(nonceRes.status, 200);
  assert.equal(nonceRes.body.mode, 'register');
  assert.match(nonceRes.body.nonce, /^[0-9a-f]{32}$/);
  assert.ok(nonceRes.body.expiresAt > Date.now());
  assert.ok(nonceRes.body.message.includes(wallet.address));
  assert.ok(nonceRes.body.message.includes('as "TestUser"'));
  assert.ok(nonceRes.body.message.startsWith('localhost:8080 wants you to sign in with your Solana account:'));

  // 2-3. sign the exact message, verify (signature as number array, like the launcher)
  const sig = wallet.signMessage(nonceRes.body.message);
  const verifyRes = await post(base, '/api/auth/verify', {
    nonce: nonceRes.body.nonce,
    address: wallet.address,
    signature: Array.from(sig),
  });
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.username, 'TestUser');
  assert.equal(verifyRes.body.address, wallet.address);
  assert.match(verifyRes.body.token, /^[0-9a-f]{64}$/);
  assert.ok(verifyRes.body.expiresAt > Date.now());
  assert.equal(
    verifyRes.body.playUrl,
    `/?ip=127.0.0.1:25565&version=1.21.11&username=TestUser&token=${verifyRes.body.token}&autoConnect=true&lockConnect=true`,
  );

  // 4. session resume with Bearer token
  const auth = { authorization: `Bearer ${verifyRes.body.token}` };
  const sessionRes = await get(base, '/api/auth/session', auth);
  assert.equal(sessionRes.status, 200);
  assert.equal(sessionRes.body.username, 'TestUser');
  assert.equal(sessionRes.body.address, wallet.address);

  // no/garbage bearer -> 401
  assert.equal((await get(base, '/api/auth/session')).status, 401);
  assert.equal((await get(base, '/api/auth/session', { authorization: 'Bearer nope' })).status, 401);

  // 5. username availability
  assert.deepEqual((await get(base, '/api/auth/username/TestUser')).body, { status: 'taken', registered: true });
  assert.deepEqual((await get(base, '/api/auth/username/testuser')).body, { status: 'taken', registered: true });
  assert.deepEqual((await get(base, '/api/auth/username/TestUser', auth)).body, { status: 'yours', registered: true });
  assert.deepEqual((await get(base, '/api/auth/username/SomebodyElse')).body, { status: 'available', registered: false });

  // second nonce for the SAME wallet is login mode
  const again = await post(base, '/api/auth/nonce', { username: 'TestUser', address: wallet.address });
  assert.equal(again.status, 200);
  assert.equal(again.body.mode, 'login');
});

test('409 when the username belongs to a different wallet (no nonce issued)', async (t) => {
  const { base } = await boot(t);
  const owner = makeWallet();
  const intruder = makeWallet();

  const n = await post(base, '/api/auth/nonce', { username: 'Duke', address: owner.address });
  const v = await post(base, '/api/auth/verify', {
    nonce: n.body.nonce,
    address: owner.address,
    signature: Array.from(owner.signMessage(n.body.message)),
  });
  assert.equal(v.status, 200);

  const res = await post(base, '/api/auth/nonce', { username: 'Duke', address: intruder.address });
  assert.equal(res.status, 409);
  assert.ok(res.body.error);

  // case-insensitive: dUKE is the same name
  const res2 = await post(base, '/api/auth/nonce', { username: 'dUKE', address: intruder.address });
  assert.equal(res2.status, 409);
});

test('replayed nonce is rejected with 4xx', async (t) => {
  const { base } = await boot(t);
  const wallet = makeWallet();

  const n = await post(base, '/api/auth/nonce', { username: 'Replay', address: wallet.address });
  const sig = Array.from(wallet.signMessage(n.body.message));
  const first = await post(base, '/api/auth/verify', { nonce: n.body.nonce, address: wallet.address, signature: sig });
  assert.equal(first.status, 200);

  const replay = await post(base, '/api/auth/verify', { nonce: n.body.nonce, address: wallet.address, signature: sig });
  assert.ok(replay.status >= 400 && replay.status < 500, `expected 4xx, got ${replay.status}`);
  assert.ok(replay.body.error);
});

test('bad signature is rejected AND burns the nonce (single use on failure too)', async (t) => {
  const { base } = await boot(t);
  const wallet = makeWallet();
  const evil = makeWallet();

  const n = await post(base, '/api/auth/nonce', { username: 'Sigma', address: wallet.address });
  const bad = await post(base, '/api/auth/verify', {
    nonce: n.body.nonce,
    address: wallet.address,
    signature: Array.from(evil.signMessage(n.body.message)), // wrong key
  });
  assert.equal(bad.status, 401);

  // Even the RIGHT signature cannot reuse the burned nonce.
  const retry = await post(base, '/api/auth/verify', {
    nonce: n.body.nonce,
    address: wallet.address,
    signature: Array.from(wallet.signMessage(n.body.message)),
  });
  assert.equal(retry.status, 400);
});

test('validation: bad usernames and addresses -> 400', async (t) => {
  // raise the strict limit: this test sends >10 nonce requests
  const { base } = await boot(t, { limits: { strict: 100 } });
  const wallet = makeWallet();

  for (const username of ['ab', 'toolongusername_17', 'sp ace', 'bad-dash', 'наб', '', undefined]) {
    const res = await post(base, '/api/auth/nonce', { username, address: wallet.address });
    assert.equal(res.status, 400, `username ${JSON.stringify(username)} should 400`);
    assert.ok(res.body.error);
  }
  for (const address of ['', 'short', '0OIl+/=', 'a'.repeat(50), undefined]) {
    const res = await post(base, '/api/auth/nonce', { username: 'GoodName', address });
    assert.equal(res.status, 400, `address ${JSON.stringify(address)} should 400`);
  }
  // verify with missing fields
  assert.equal((await post(base, '/api/auth/verify', {})).status, 400);
  // username lookup with invalid name
  assert.equal((await get(base, '/api/auth/username/a')).status, 400);
});

test('rate limit: fixed window returns 429 over the per-IP limit', async (t) => {
  // Fresh app with small limits so the test is fast and cannot bleed into others.
  const { base } = await boot(t, { limits: { strict: 3, relaxed: 5 } });
  const wallet = makeWallet();

  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await post(base, '/api/auth/nonce', { username: `User${i}`, address: wallet.address });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);
  assert.equal(statuses[4], 429);

  // nonce+verify share the strict bucket: verify is also blocked now.
  const v = await post(base, '/api/auth/verify', { nonce: 'x', address: wallet.address, signature: [1] });
  assert.equal(v.status, 429);

  // relaxed bucket is independent and has its own limit
  const relaxed = [];
  for (let i = 0; i < 7; i++) {
    relaxed.push((await get(base, '/api/auth/username/FreeName')).status);
  }
  assert.deepEqual(relaxed.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(relaxed[5], 429);
});

test('default rate limits: 11th strict request in a minute is 429', async (t) => {
  const { base } = await boot(t); // default limits: 10 strict
  const wallet = makeWallet();
  let last = null;
  for (let i = 0; i < 11; i++) {
    last = await post(base, '/api/auth/nonce', { username: `Bulk${i}`, address: wallet.address });
    if (i < 10) assert.equal(last.status, 200, `request ${i + 1} should pass`);
  }
  assert.equal(last.status, 429);
});

test('static plumbing: healthz, merged config.json, bare-/ site vs game client', async (t) => {
  const { base } = await boot(t);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const hbody = await health.json();
  assert.equal(hbody.ok, true);
  assert.equal(typeof hbody.mc, 'boolean');
  assert.equal(health.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(health.headers.get('cross-origin-embedder-policy'), 'require-corp');

  const cfg = await (await fetch(`${base}/config.json`)).json();
  assert.equal(cfg.defaultProxy, '');
  assert.equal(cfg.allowAutoConnect, true);
  assert.equal(cfg.defaultHost, '127.0.0.1:25565');
  assert.deepEqual(cfg.promoteServers, [
    {
      ip: '127.0.0.1:25565',
      name: 'MuchuCraft',
      description: 'Wallet-verified survival — muchucraft',
      version: CONFIG.mcVersion, // from config, never hardcoded
    },
  ], 'promoteServers must replace the upstream mcraft.fun promos wholesale');

  // Bare / (no query) serves the marketing site — no redirect (SPEC-PHASE3 §3).
  const bare = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(bare.status, 200);
  assert.match(bare.headers.get('content-type') ?? '', /text\/html/);
  const siteHtml = await bare.text();
  assert.match(siteHtml, /PLAY NOW/, 'site hero must carry the PLAY NOW button');
  assert.match(siteHtml, /href="\/login\/"/, 'PLAY NOW must point at /login/');
  assert.match(siteHtml, /href="\/\?play=1"/, 'secondary CTA must open the game client');

  // Any client query param (incl. the site's ?play=1) falls through to the
  // game client dist, never the site and never a /login/ bounce.
  for (const qs of ['?play=1', '?ip=127.0.0.1:25565&token=x', '?singleplayer=1']) {
    const res = await fetch(`${base}/${qs}`, { redirect: 'manual' });
    assert.equal(res.status, 200, `GET /${qs} must serve the client dist`);
    const html = await res.text();
    assert.doesNotMatch(html, /PLAY NOW/, `GET /${qs} must not serve the site page`);
  }

  // Site assets are mounted under /site/*.
  const css = await fetch(`${base}/site/site.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
});
