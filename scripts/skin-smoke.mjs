#!/usr/bin/env node
// scripts/skin-smoke.mjs — SPEC-PHASE3 §5 step 5: set a skin via the API for
// E2ETester, join once through the WS proxy, and verify (a) the gateway fires
// the SkinsRestorer RCON apply on join and (b) SkinsRestorer accepts the
// command. NOTE: SkinsRestorer (like LuckPerms) executes RCON commands async
// and directs output to the RCON sender, so nothing appears in latest.log —
// acceptance is proven by its persisted storage instead: after a successful
// `skin set` it writes plugins/SkinsRestorer/players/<offline-uuid>.player
// (with a skinIdentifier) and skins/<id>.playerskin (verified live).
// Run from anywhere; uses e2e/ deps + persisted wallet.
// Exit 0 = PASS, 1 = FAIL, 2 = environment problem.
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // env may already be set
}

const { loadOrCreateWallet } = await import(path.join(ROOT, 'e2e', 'fakewallet.js'));
const { openProxyStream } = await import(path.join(ROOT, 'e2e', 'wsclient.js'));
const { default: mineflayer } = await import(path.join(ROOT, 'e2e', 'node_modules', 'mineflayer', 'index.js'));

const GATEWAY = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? '8090'}`;
const USERNAME = 'E2ETester';
const SKIN = process.env.SKIN_SMOKE_VALUE ?? 'name:Notch';
const GATEWAY_LOG = path.join(ROOT, 'logs', 'gateway.log');
const SR_DIR = path.join(ROOT, 'server', 'plugins', 'SkinsRestorer');

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${GATEWAY}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status, json };
}

function fail(msg) {
  console.error(`[skin-smoke] FAIL: ${msg}`);
  process.exit(1);
}

// --- session (nonce → sign → verify) ---
const wallet = loadOrCreateWallet(path.join(ROOT, 'e2e', '.e2e-wallet.json'));
const nonceRes = await api('/api/auth/nonce', {
  method: 'POST',
  body: { username: USERNAME, address: wallet.address },
});
if (nonceRes.status !== 200) {
  console.error(`[skin-smoke] nonce → HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
  process.exit(2);
}
const verifyRes = await api('/api/auth/verify', {
  method: 'POST',
  body: {
    nonce: nonceRes.json.nonce,
    address: wallet.address,
    signature: Array.from(wallet.signMessage(nonceRes.json.message)),
  },
});
if (verifyRes.status !== 200) {
  console.error(`[skin-smoke] verify → HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  process.exit(2);
}
const token = verifyRes.json.token;
console.log(`[skin-smoke] session for ${USERNAME} OK`);

// --- set the skin via the API ---
const setRes = await api('/api/auth/skin', { token, method: 'POST', body: { skin: SKIN } });
if (setRes.status !== 200 || setRes.json?.skin !== SKIN) {
  fail(`POST /api/auth/skin → HTTP ${setRes.status} ${JSON.stringify(setRes.json)} (expected {skin:${JSON.stringify(SKIN)}})`);
}
console.log(`[skin-smoke] POST /api/auth/skin stored ${JSON.stringify(setRes.json.skin)}`);

const sessRes = await api('/api/auth/session', { token });
if (sessRes.status !== 200 || sessRes.json?.skin !== SKIN) {
  fail(`GET /api/auth/session skin=${JSON.stringify(sessRes.json?.skin)} (expected ${JSON.stringify(SKIN)})`);
}
console.log('[skin-smoke] GET /api/auth/session echoes the stored skin');

// --- join once so the post-sniff hook fires the RCON apply ---
const gwMark = readFileSync(GATEWAY_LOG, 'utf8').length;
const playersBefore = new Map(
  readdirSync(path.join(SR_DIR, 'players')).map((f) => {
    const p = path.join(SR_DIR, 'players', f);
    return [f, readFileSync(p, 'utf8')];
  }),
);

const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: token });
try {
  await new Promise((resolve, reject) => {
    let settled = false;
    let quitting = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('bot did not spawn within 60s')), 60_000);
    const bot = mineflayer.createBot({
      username: USERNAME,
      auth: 'offline',
      version: process.env.MC_VERSION,
      host: process.env.MC_HOST ?? '127.0.0.1',
      port: Number(process.env.MC_PORT ?? 25565),
      connect: (client) => {
        client.setSocket(proxy.stream);
        setImmediate(() => client.emit('connect'));
      },
    });
    bot.on('error', (err) => (quitting ? finish() : finish(new Error(`bot error: ${err?.message ?? err}`))));
    bot.on('kicked', (reason) => finish(new Error(`bot kicked: ${JSON.stringify(reason)}`)));
    bot.on('end', () => (quitting ? finish() : finish(new Error('connection ended before spawn'))));
    bot.once('spawn', async () => {
      console.log('[skin-smoke] bot spawned — waiting 15s for the 6s-delayed skin apply');
      await delay(15_000); // apply fires 6s after the login sniff; SR then fetches async
      quitting = true;
      bot.quit();
      setTimeout(() => finish(), 5_000);
    });
  });
} finally {
  try {
    proxy.ws.terminate();
  } catch {
    // already closed
  }
}

await delay(2_000);

// --- evidence: gateway log line + SkinsRestorer persisted storage ---
const gwNew = readFileSync(GATEWAY_LOG, 'utf8').slice(gwMark);
const expectCmd = `skin set ${SKIN.slice(SKIN.indexOf(':') + 1)} ${USERNAME}`;

const gwLine = gwNew.split('\n').find((l) => l.includes('rcon skin apply'));
if (!gwLine || !gwLine.includes(expectCmd)) {
  fail(`gateway log has no 'rcon skin apply: ${expectCmd}' line after the join (saw: ${JSON.stringify(gwLine ?? null)})`);
}
console.log(`[skin-smoke] gateway apply-on-join fired: ${gwLine.trim()}`);

// SkinsRestorer acceptance = a new/updated players/<uuid>.player row that
// references a skinIdentifier (its async RCON output never reaches latest.log).
const changed = readdirSync(path.join(SR_DIR, 'players')).filter((f) => {
  const now = readFileSync(path.join(SR_DIR, 'players', f), 'utf8');
  return now !== playersBefore.get(f);
});
const record = changed
  .map((f) => ({ file: f, body: JSON.parse(readFileSync(path.join(SR_DIR, 'players', f), 'utf8')) }))
  .find((r) => r.body?.skinIdentifier?.identifier);
if (!record) {
  fail(`SkinsRestorer persisted no new players/<uuid>.player with a skinIdentifier (changed: ${JSON.stringify(changed)})`);
}
const skinFiles = readdirSync(path.join(SR_DIR, 'skins'));
console.log(`[skin-smoke] SkinsRestorer accepted: players/${record.file} → skinIdentifier ${JSON.stringify(record.body.skinIdentifier)}`);
console.log(`[skin-smoke] skins/ store: ${skinFiles.join(', ') || '(empty)'}`);
console.log('[skin-smoke] PASS — skin stored via API, applied on join via RCON, accepted + persisted by SkinsRestorer');
