#!/usr/bin/env node
// e2e/run-e2e.js — end-to-end proof of the whole MuchuCraft stack, no browser.
//
// Assumes gateway + Paper server are ALREADY running (see start-all.sh).
// Exit codes: 0 = all cases passed, 1 = at least one case failed / timeout,
//             2 = stack not running (healthz failed) or missing config.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { createFakeWallet, loadOrCreateWallet } from './fakewallet.js';
import { openProxyStream } from './wsclient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // .env is optional if the environment is already populated
}

const GATEWAY = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`;
const MC_VERSION = process.env.CLIENT_MC_VERSION || process.env.MC_VERSION;
const USERNAME = 'E2ETester';
const IMPOSTOR = 'Impostor';
const GLOBAL_TIMEOUT_MS = 4 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 60_000;
const KILL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- utilities

async function postJson(pathname, payload, headers = {}) {
  const res = await fetch(new URL(pathname, GATEWAY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body
  }
  return { status: res.status, ok: res.ok, json };
}

/** nonce → sign → verify; returns {token, nonce, message, signature, ...}. */
async function authenticate(wallet, username) {
  const nonceRes = await postJson('/api/auth/nonce', { username, address: wallet.address });
  if (nonceRes.status !== 200) {
    throw new Error(`nonce request → HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
  }
  const { message, nonce, mode } = nonceRes.json ?? {};
  if (typeof message !== 'string' || typeof nonce !== 'string') {
    throw new Error(`nonce response missing message/nonce: ${JSON.stringify(nonceRes.json)}`);
  }
  const signature = Array.from(wallet.signMessage(message));
  const verifyRes = await postJson('/api/auth/verify', {
    nonce,
    address: wallet.address,
    signature,
  });
  if (verifyRes.status !== 200) {
    throw new Error(`verify → HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  }
  const { token, expiresAt, playUrl } = verifyRes.json ?? {};
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error(`verify response missing session token: ${JSON.stringify(verifyRes.json)}`);
  }
  return { token, nonce, message, signature, mode, expiresAt, playUrl };
}

/** createBot wired to a proxied duplex (never a real TCP socket). */
function createProxiedBot({ username, stream }) {
  return mineflayer.createBot({
    username,
    auth: 'offline',
    // Pin the version: auto-detect would try to ping the server over TCP,
    // bypassing the WS transport entirely.
    version: MC_VERSION,
    host: process.env.MC_HOST ?? '127.0.0.1',
    port: Number(process.env.MC_PORT ?? 25565),
    connect: (client) => {
      client.setSocket(stream);
      // With auth:'offline', createClient invokes this callback BEFORE
      // setProtocol attaches the client's 'connect' listener (which writes
      // the handshake). Emit async so the listener is wired up first; a
      // plain duplex never emits 'connect' on its own.
      setImmediate(() => client.emit('connect'));
    },
  });
}

// ------------------------------------------------------------------ healthz

async function checkHealth() {
  let res;
  try {
    res = await fetch(new URL('/healthz', GATEWAY), { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.error(`[e2e] cannot reach gateway at ${GATEWAY}/healthz: ${err.cause?.message ?? err.message}`);
    console.error('[e2e] the stack does not appear to be running — start it (./start-all.sh) and re-run.');
    process.exit(2);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // fallthrough
  }
  if (!res.ok || body?.ok !== true) {
    console.error(`[e2e] GET /healthz → HTTP ${res.status} ${JSON.stringify(body)}`);
    console.error('[e2e] gateway is unhealthy — check its logs, then re-run.');
    process.exit(2);
  }
  if (body.mc !== true) {
    console.error(`[e2e] gateway is up but the Minecraft server is not reachable (healthz mc=${JSON.stringify(body.mc)}).`);
    console.error('[e2e] start the Paper server (server/start.sh or ./start-all.sh) and re-run.');
    process.exit(2);
  }
  console.log(`[e2e] healthz OK — gateway ${GATEWAY}, mc reachable, version ${MC_VERSION}`);
}

// -------------------------------------------------------------------- cases

const results = [];

async function runCase(name, fn) {
  const started = Date.now();
  console.log(`[e2e] running: ${name}`);
  try {
    await fn();
    console.log(`[e2e] PASS  ${name} (${Date.now() - started}ms)`);
    results.push({ name, pass: true });
  } catch (err) {
    console.log(`[e2e] FAIL  ${name} (${Date.now() - started}ms): ${err.message}`);
    results.push({ name, pass: false, error: err.message });
  }
}

// Shared state across cases (case 1 feeds 2, 4 and 6). The E2ETester wallet
// is persisted so repeated runs reuse the wallet the username is bound to.
let wallet = null; // initialized in main() after the health check
let session = null; // {token, nonce, message, signature, ...}

async function caseAuth() {
  session = await authenticate(wallet, USERNAME);
  console.log(`[e2e]   mode=${session.mode} wallet=${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)} token=${session.token.slice(0, 8)}…`);
}

async function caseBotSpawns() {
  if (!session) throw new Error('no session token (case 1 failed)');
  const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: session.token });
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
      const timer = setTimeout(
        () => finish(new Error(`bot did not spawn within ${SPAWN_TIMEOUT_MS / 1000}s`)),
        SPAWN_TIMEOUT_MS
      );
      const bot = createProxiedBot({ username: USERNAME, stream: proxy.stream });
      bot.on('error', (err) => {
        if (quitting) {
          // teardown race noise after an intentional quit is not a failure
          console.log(`[e2e]   (ignored error during quit: ${err?.message ?? err})`);
          finish();
        } else {
          finish(new Error(`bot error: ${err?.message ?? err}`));
        }
      });
      bot.on('kicked', (reason) =>
        finish(new Error(`bot kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
      );
      bot.on('end', (reason) => {
        if (quitting) finish();
        else finish(new Error(`connection ended before spawn (${reason ?? 'no reason'})`));
      });
      bot.once('spawn', async () => {
        try {
          console.log('[e2e]   bot spawned — sending chat line');
          bot.chat('Hello from the MuchuCraft e2e bot (wallet-verified).');
          await delay(1500); // let the chat packet flush / RCON welcome land
          quitting = true;
          bot.quit();
          // fallback in case 'end' never fires
          setTimeout(() => finish(), 5000);
        } catch (err) {
          finish(err);
        }
      });
    });
  } finally {
    try {
      proxy.ws.terminate();
    } catch {
      // already closed
    }
  }
}

async function caseBadBearer() {
  for (const [label, token] of [
    ['missing Authorization header', undefined],
    ['garbage token', 'deadbeef-not-a-session-token'],
  ]) {
    let status = null;
    try {
      await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: token });
    } catch (err) {
      status = err.status ?? null;
    }
    if (status === null) throw new Error(`${label}: /connect unexpectedly succeeded`);
    if (status !== 403) throw new Error(`${label}: expected HTTP 403, got ${status}`);
    console.log(`[e2e]   ${label} → 403 as expected`);
  }
}

async function caseImpostor() {
  if (!session) throw new Error('no session token (case 1 failed)');
  // Valid session (owned by E2ETester) but the Minecraft login uses another
  // username. The proxy must kill the connection before the bot can spawn.
  const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: session.token });
  let bot = null;
  try {
    const spawnPromise = new Promise((resolve) => {
      bot = createProxiedBot({ username: IMPOSTOR, stream: proxy.stream });
      bot.on('error', () => {}); // teardown mid-handshake is expected
      bot.on('kicked', () => {});
      bot.once('spawn', () => resolve({ type: 'spawn' }));
    });
    const result = await Promise.race([
      proxy.waitForShutdownOrClose(KILL_TIMEOUT_MS),
      spawnPromise,
    ]);
    if (result.type === 'spawn') {
      throw new Error('Impostor bot SPAWNED — username enforcement failed');
    }
    if (result.type === 'timeout') {
      throw new Error(`no proxy-shutdown/close within ${KILL_TIMEOUT_MS / 1000}s`);
    }
    const detail =
      result.type === 'shutdown'
        ? result.reason
        : `code ${result.code}${result.reason ? ` ${result.reason}` : ''}`;
    console.log(`[e2e]   connection killed as expected (${result.type}: ${detail})`);
  } finally {
    try {
      bot?.quit();
    } catch {
      // stream already dead
    }
    try {
      proxy.ws.terminate();
    } catch {
      // already closed
    }
  }
}

async function caseSecondWallet() {
  const otherWallet = createFakeWallet();
  const res = await postJson('/api/auth/nonce', {
    username: USERNAME,
    address: otherWallet.address,
  });
  if (res.status !== 409) {
    throw new Error(`expected HTTP 409 for taken username, got ${res.status} ${JSON.stringify(res.json)}`);
  }
  if (typeof res.json?.error !== 'string') {
    throw new Error(`409 body missing {error}: ${JSON.stringify(res.json)}`);
  }
  console.log(`[e2e]   nonce for taken username → 409 (${res.json.error})`);
}

async function caseReplayNonce() {
  if (!session) throw new Error('no consumed nonce (case 1 failed)');
  // The nonce was consumed by the successful verify in case 1; replaying the
  // exact same verify payload must be rejected with a 4xx.
  const res = await postJson('/api/auth/verify', {
    nonce: session.nonce,
    address: wallet.address,
    signature: session.signature,
  });
  if (res.status < 400 || res.status > 499) {
    throw new Error(`expected 4xx for replayed nonce, got ${res.status} ${JSON.stringify(res.json)}`);
  }
  console.log(`[e2e]   replayed nonce → ${res.status} as expected`);
}

// --------------------------------------------------------------------- main

function printSummary() {
  console.log('[e2e] ----------------- summary -----------------');
  for (const r of results) {
    console.log(`[e2e] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` — ${r.error}`}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`[e2e] ${passed}/${results.length} cases passed`);
  return passed === results.length && results.length > 0;
}

async function main() {
  if (!MC_VERSION) {
    console.error('[e2e] MC_VERSION is not set (root .env) — cannot pin the protocol version.');
    process.exit(2);
  }

  // Hard global timeout: if anything hangs, dump a summary and bail.
  const globalTimer = setTimeout(() => {
    console.error(`[e2e] FATAL: global timeout after ${GLOBAL_TIMEOUT_MS / 1000}s — aborting`);
    printSummary();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  await checkHealth();

  wallet = loadOrCreateWallet(path.join(__dirname, '.e2e-wallet.json'));

  await runCase('1. wallet auth: nonce → sign → verify → session token', caseAuth);
  await runCase('2. mineflayer bot spawns via WS proxy, chats, disconnects', caseBotSpawns);
  await runCase('3. /api/vm/net/connect without valid Bearer → 403', caseBadBearer);
  await runCase(`4. valid session but username "${IMPOSTOR}" → connection killed`, caseImpostor);
  await runCase(`5. second wallet requests nonce for "${USERNAME}" → 409`, caseSecondWallet);
  await runCase('6. replayed (already consumed) nonce on verify → 4xx', caseReplayNonce);

  clearTimeout(globalTimer);
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`[e2e] FATAL: ${err.stack ?? err}`);
  printSummary();
  process.exit(1);
});
