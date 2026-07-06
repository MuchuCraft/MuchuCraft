// skins.test.js — SPEC-PHASE3 §4 skins: validation, additive db migration
// idempotency, session skin field, POST /api/auth/skin, and the SkinsRestorer
// console command construction + apply-on-join wiring (stub rcon, no real
// RCON, no Minecraft server, no network beyond loopback).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from '../src/db.js';
import { createAuthRoutes, validateSkin } from '../src/auth-routes.js';
import { buildSkinCommand } from '../src/rcon.js';
import { createNetProxy } from '../src/netproxy.js';

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
  root: process.cwd(),
};

// ------------------------------------------------------------- validation

test('validateSkin accepts the two SPEC formats and trims', () => {
  assert.equal(validateSkin('name:Notch'), 'name:Notch');
  assert.equal(validateSkin('name:MHF_Steve'), 'name:MHF_Steve');
  assert.equal(validateSkin('name:abc'), 'name:abc'); // 3-char minimum
  assert.equal(validateSkin('name:A234567890123456'), 'name:A234567890123456'); // 16 max
  assert.equal(validateSkin('url:https://example.com/skin.png'), 'url:https://example.com/skin.png');
  assert.equal(validateSkin('url:https://example.com/a/b/skin.PNG'), 'url:https://example.com/a/b/skin.PNG');
  assert.equal(validateSkin('  name:Notch  '), 'name:Notch'); // trimmed
});

test('validateSkin rejects everything else', () => {
  // wrong / missing prefix
  assert.equal(validateSkin('Notch'), null);
  assert.equal(validateSkin('https://example.com/skin.png'), null);
  assert.equal(validateSkin('skin:Notch'), null);
  // bad names
  assert.equal(validateSkin('name:ab'), null); // too short
  assert.equal(validateSkin('name:A2345678901234567'), null); // 17 chars
  assert.equal(validateSkin('name:bad-name'), null);
  assert.equal(validateSkin('name:has space'), null);
  assert.equal(validateSkin('name:Notch x'), null); // trailing junk
  // bad urls
  assert.equal(validateSkin('url:http://example.com/skin.png'), null); // not https
  assert.equal(validateSkin('url:https://example.com/skin.jpg'), null); // not .png
  assert.equal(validateSkin('url:https://example.com/skin.png?x=1'), null); // must END in .png
  assert.equal(validateSkin('url:https://exa mple.com/skin.png'), null); // whitespace
  assert.equal(validateSkin('url:https://example.com/a\tb.png'), null); // control char
  assert.equal(validateSkin(`url:https://example.com/${'a'.repeat(300)}.png`), null); // >300
  assert.equal(validateSkin('url:https://'), null);
  assert.equal(validateSkin('url:notaurl.png'), null);
  // non-strings / empty
  assert.equal(validateSkin(''), null);
  assert.equal(validateSkin('   '), null);
  assert.equal(validateSkin(null), null);
  assert.equal(validateSkin(undefined), null);
  assert.equal(validateSkin(42), null);
  assert.equal(validateSkin({ skin: 'name:Notch' }), null);
});

// ------------------------------------------- console command construction

test('buildSkinCommand builds the verified SkinsRestorer console syntax', () => {
  // Verified against the shipped SkinsRestorer 15.12.4 jar:
  // `skin set <skinName-or-url> <selector>` (see rcon.js / docs/SKINS.md).
  assert.equal(buildSkinCommand('Alice', 'name:Notch'), 'skin set Notch Alice');
  assert.equal(
    buildSkinCommand('E2ETester', 'url:https://example.com/skin.png'),
    'skin set https://example.com/skin.png E2ETester',
  );
});

test('buildSkinCommand returns null for anything invalid (defense in depth)', () => {
  assert.equal(buildSkinCommand('Alice', null), null);
  assert.equal(buildSkinCommand('Alice', ''), null);
  assert.equal(buildSkinCommand('Alice', 'Notch'), null); // missing prefix
  assert.equal(buildSkinCommand('Alice', 'name:evil one'), null); // space -> extra arg
  assert.equal(buildSkinCommand('Alice', 'name:x; op Alice'), null);
  assert.equal(buildSkinCommand('Alice', 'url:http://example.com/skin.png'), null);
  assert.equal(buildSkinCommand('Alice', 'url:https://e.com/x.png stop'), null);
  assert.equal(buildSkinCommand('bad name', 'name:Notch'), null); // bad username
  assert.equal(buildSkinCommand('', 'name:Notch'), null);
  assert.equal(buildSkinCommand(undefined, 'name:Notch'), null);
});

// ----------------------------------------------------------- db migration

test('createDb adds users.skin and setUserSkin round-trips through getSessionInfo', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  const user = db.claimUsername('SkinUser', 'Addr1111111111111111111111111111');
  const { token } = db.createSession(user.id, 60_000);

  assert.equal(db.getSessionInfo(token).skin, null, 'fresh users have no skin');
  assert.equal(db.setUserSkin(user.id, 'name:Notch'), true);
  assert.equal(db.getSessionInfo(token).skin, 'name:Notch');
  assert.equal(db.setUserSkin(user.id, null), true, 'clearing works');
  assert.equal(db.getSessionInfo(token).skin, null);
  assert.equal(db.setUserSkin(9999, 'name:Notch'), false, 'unknown user changes nothing');
});

test('skin migration is additive and idempotent across reopens', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muchu-skins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');

  // Open #1 migrates, open #2 must be a clean no-op that preserves data.
  const db1 = createDb(file);
  const user = db1.claimUsername('Alice', 'Addr1111111111111111111111111111');
  db1.setUserSkin(user.id, 'url:https://example.com/skin.png');
  db1.close();

  const db2 = createDb(file);
  const again = db2.getUserByName('Alice');
  assert.equal(again.skin, 'url:https://example.com/skin.png', 'data survives re-migration');
  db2.close();

  // Exactly one skin column after repeated opens (ALTER did not stack).
  const raw = new DatabaseSync(file);
  const cols = raw.prepare('PRAGMA table_info(users)').all().filter((c) => c.name === 'skin');
  raw.close();
  assert.equal(cols.length, 1);
});

test('a pre-Phase3 users table (no skin column) is upgraded in place', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muchu-skins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'legacy.db');

  // Legacy schema exactly as SPEC.md defined it (no skin column).
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE,
    address TEXT NOT NULL, created_at INTEGER, last_login_at INTEGER)`);
  legacy.prepare('INSERT INTO users (username, address, created_at) VALUES (?, ?, ?)')
    .run('OldTimer', 'AddrOld111111111111111111111111', Date.now());
  legacy.close();

  const db = createDb(file);
  t.after(() => db.close());
  const user = db.getUserByName('OldTimer');
  assert.equal(user.skin, null, 'existing rows get skin NULL');
  assert.equal(db.setUserSkin(user.id, 'name:Notch'), true);
  assert.equal(db.getUserByName('OldTimer').skin, 'name:Notch');
});

// -------------------------------------------------------- /api/auth/skin

/** Auth router + in-memory db + stub rcon; session minted directly in db. */
function bootAuthApp(t) {
  const db = createDb(':memory:');
  const applied = [];
  const app = express();
  app.use(
    '/api/auth',
    createAuthRoutes({
      config: CONFIG,
      db,
      limits: { strict: 1000, relaxed: 1000 },
      rcon: { applySkin: (...args) => applied.push(args) }, // stub: no real RCON
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    db.close();
  });
  return new Promise((resolve) => {
    server.on('listening', () => {
      const user = db.claimUsername('E2ETester', 'Addr1111111111111111111111111111');
      const { token } = db.createSession(user.id, 60_000);
      resolve({ base: `http://127.0.0.1:${server.address().port}`, db, token, user, applied });
    });
  });
}

async function postSkin(base, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/auth/skin`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getSession(base, token) {
  const res = await fetch(`${base}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

test('POST /api/auth/skin requires a valid session', async (t) => {
  const { base, applied } = await bootAuthApp(t);
  const noToken = await postSkin(base, { skin: 'name:Notch' });
  assert.equal(noToken.status, 401);
  const badToken = await postSkin(base, { skin: 'name:Notch' }, 'garbage');
  assert.equal(badToken.status, 401);
  assert.equal(typeof badToken.body.error, 'string');
  assert.equal(applied.length, 0, 'no rcon apply without a session');
});

test('POST /api/auth/skin stores valid skins, session exposes them, rcon fires', async (t) => {
  const { base, token, applied } = await bootAuthApp(t);

  // session starts with skin: null (field present per SPEC)
  const before = await getSession(base, token);
  assert.equal(before.status, 200);
  assert.equal(before.body.skin, null);

  // name form
  const nameRes = await postSkin(base, { skin: 'name:Notch' }, token);
  assert.equal(nameRes.status, 200);
  assert.deepEqual(nameRes.body, { skin: 'name:Notch' });
  assert.deepEqual(applied, [['E2ETester', 'name:Notch']], 'immediate apply via stub rcon');
  const afterName = await getSession(base, token);
  assert.equal(afterName.body.skin, 'name:Notch');

  // url form replaces it
  const urlRes = await postSkin(base, { skin: 'url:https://example.com/skin.png' }, token);
  assert.equal(urlRes.status, 200);
  assert.equal(urlRes.body.skin, 'url:https://example.com/skin.png');
  assert.equal((await getSession(base, token)).body.skin, 'url:https://example.com/skin.png');
  assert.equal(applied.length, 2);

  // clearing with null
  const clearRes = await postSkin(base, { skin: null }, token);
  assert.equal(clearRes.status, 200);
  assert.equal(clearRes.body.skin, null);
  assert.equal((await getSession(base, token)).body.skin, null);
  assert.equal(applied.length, 2, 'clearing must not fire the rcon command');
});

test('POST /api/auth/skin rejects invalid values with 400 and stores nothing', async (t) => {
  const { base, token, applied } = await bootAuthApp(t);
  const bad = [
    { skin: 'Notch' },
    { skin: 'name:ab' },
    { skin: 'name:has space' },
    { skin: 'url:http://example.com/skin.png' },
    { skin: 'url:https://example.com/skin.jpg' },
    { skin: `url:https://example.com/${'a'.repeat(300)}.png` },
    { skin: 42 },
    {},
  ];
  for (const body of bad) {
    const res = await postSkin(base, body, token);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal((await getSession(base, token)).body.skin, null, 'nothing stored');
  assert.equal(applied.length, 0, 'no rcon apply for rejected values');
});

// -------------------------------------------- apply-on-join (netproxy hook)

// Minimal MC byte helpers (mirrors netproxy.test.js).
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
function loginStream(name) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(25565, 0);
  return Buffer.concat([
    frame(varInt(0x00), varInt(774), mcString('mc.example.com'), portBuf, varInt(2)),
    frame(varInt(0x00), mcString(name), Buffer.alloc(16, 0x42)),
  ]);
}

async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Fake MC TCP server + netproxy with a stub rcon; returns handles + teardown. */
async function bootProxy(t, session) {
  const mcSockets = [];
  const mcServer = net.createServer((sock) => {
    mcSockets.push(sock);
    sock.on('error', () => {});
  });
  await new Promise((resolve) => mcServer.listen(0, '127.0.0.1', resolve));

  const applied = [];
  const welcomes = [];
  const proxy = createNetProxy({
    env: {
      mcHost: '127.0.0.1',
      mcPort: mcServer.address().port,
      mcVersion: '1.21.11',
      rconPort: 1,
      rconPassword: 'unused',
    },
    sessionLookup: (token) => (token === 'session-token' ? { ...session } : null),
    markLogin: () => ({ firstLogin: false }),
    rcon: {
      sendWelcome: (...args) => welcomes.push(args),
      applySkin: (...args) => applied.push(args),
    },
    rconDelayMs: 40,
    skinDelayMs: 20,
  });
  const app = express();
  app.use('/api/vm/net', proxy.router);
  const server = http.createServer(app);
  proxy.handleUpgrade(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const sockets = [];
  t.after(async () => {
    // Upgraded WS + accepted TCP sockets are not covered by close(); destroy
    // them first or teardown hangs (same pattern as netproxy.test.js).
    for (const ws of sockets) ws.terminate();
    for (const sock of mcSockets) sock.destroy();
    server.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => mcServer.close(resolve)),
    ]);
  });

  async function join(username) {
    const res = await fetch(`http://127.0.0.1:${port}/api/vm/net/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer session-token' },
      body: JSON.stringify({ host: 'mc.example.com', port: 25565 }),
    });
    assert.equal(res.status, 200);
    const { token } = await res.json();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vm/net/socket?token=${token}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(loginStream(username), { binary: true });
    return ws;
  }

  return { join, applied, welcomes };
}

test('verified join applies the stored skin ~skinDelayMs later via rcon', async (t) => {
  const session = {
    userId: 7,
    username: 'Notch',
    address: 'Wa11etAddressXYZ9876',
    skin: 'name:MHF_Steve',
  };
  const { join, applied, welcomes } = await bootProxy(t, session);
  await join('Notch');
  await waitFor(() => applied.length === 1, 'skin apply');
  assert.deepEqual(applied, [['Notch', 'name:MHF_Steve']]);
  await waitFor(() => welcomes.length === 1, 'welcome still fires');
});

test('joins without a stored skin never call applySkin', async (t) => {
  const session = { userId: 7, username: 'Notch', address: 'Wa11etAddressXYZ9876', skin: null };
  const { join, applied, welcomes } = await bootProxy(t, session);
  await join('Notch');
  await waitFor(() => welcomes.length === 1, 'welcome (fires after the skin window)');
  assert.equal(applied.length, 0, 'no applySkin for skinless sessions');
});

test('username mismatch kills the connection before any skin apply', async (t) => {
  const session = {
    userId: 7,
    username: 'Notch',
    address: 'Wa11etAddressXYZ9876',
    skin: 'name:MHF_Steve',
  };
  const { join, applied } = await bootProxy(t, session);
  const ws = await join('Impostor');
  await new Promise((resolve) => ws.once('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 60)); // > skinDelayMs
  assert.equal(applied.length, 0, 'no skin apply for rejected logins');
});
