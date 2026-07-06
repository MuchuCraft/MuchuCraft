#!/usr/bin/env node
// e2e/run-public-e2e.js — proves the PUBLIC path end-to-end like a real remote
// player: TLS healthz → SIWS auth over HTTPS → /api/vm/net/connect with Bearer
// → DATA socket over wss:// → mineflayer bot spawns, chats, disconnects →
// negative (no Bearer → 403).
//
// Base URL: first CLI arg, else env PUBLIC_BASE, else https://web.muchu.app.
// Uses a fresh throwaway keypair + username PublicBot<rand> every run — it
// never touches .e2e-wallet.json.
//
// Exit codes: 0 = all cases passed, 1 = at least one failed / timeout,
//             2 = public endpoint unreachable/unhealthy or missing config.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { createFakeWallet } from './fakewallet.js';
import { openProxyStream } from './wsclient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // .env is optional if the environment is already populated
}

const BASE = process.argv[2] ?? process.env.PUBLIC_BASE ?? 'https://web.muchu.app';
const MC_VERSION = process.env.CLIENT_MC_VERSION || process.env.MC_VERSION;
const EXPECTED_SIWS_DOMAIN = 'web.muchu.app';
const USERNAME = `PublicBot${Math.random().toString(36).slice(2, 7)}`; // ≤16 chars
const GLOBAL_TIMEOUT_MS = 5 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 90_000;
const CHAT_LINE = 'Hello from the public internet via wss!';

// ---------------------------------------------------------------- utilities

async function postJson(pathname, payload, headers = {}) {
  const res = await fetch(new URL(pathname, BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body
  }
  return { status: res.status, ok: res.ok, json };
}

/** createBot wired to a proxied duplex (never a real TCP socket). */
function createProxiedBot({ username, stream }) {
  return mineflayer.createBot({
    username,
    auth: 'offline',
    // Pin the version: auto-detect would try to ping the server over TCP,
    // bypassing the WSS transport entirely.
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

// -------------------------------------------------------------------- cases

const results = [];

async function runCase(name, fn) {
  const started = Date.now();
  console.log(`[public-e2e] running: ${name}`);
  try {
    await fn();
    console.log(`[public-e2e] PASS  ${name} (${Date.now() - started}ms)`);
    results.push({ name, pass: true });
  } catch (err) {
    console.log(`[public-e2e] FAIL  ${name} (${Date.now() - started}ms): ${err.message}`);
    results.push({ name, pass: false, error: err.message });
  }
}

// Shared state across cases (each case feeds the next).
const wallet = createFakeWallet(); // fresh throwaway keypair, never persisted
let session = null; // {token, message, ...}
let connection = null; // proof from the explicit /connect case
let proxy = null; // wss handle opened in case 4, consumed by case 5

async function caseHealthz() {
  if (new URL(BASE).protocol !== 'https:') {
    throw new Error(`base URL is not https (${BASE}) — this test must exercise TLS`);
  }
  const res = await fetch(new URL('/healthz', BASE), { signal: AbortSignal.timeout(10_000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // fallthrough
  }
  if (!res.ok || body?.ok !== true) {
    throw new Error(`GET /healthz → HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  if (body.mc !== true) {
    throw new Error(`gateway is up but mc is not reachable (healthz mc=${JSON.stringify(body.mc)})`);
  }
  console.log(`[public-e2e]   healthz OK over TLS — ${BASE}, mc reachable`);
}

async function caseAuth() {
  const nonceRes = await postJson('/api/auth/nonce', { username: USERNAME, address: wallet.address });
  if (nonceRes.status !== 200) {
    throw new Error(`nonce request → HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
  }
  const { message, nonce, mode } = nonceRes.json ?? {};
  if (typeof message !== 'string' || typeof nonce !== 'string') {
    throw new Error(`nonce response missing message/nonce: ${JSON.stringify(nonceRes.json)}`);
  }
  const firstLine = message.split('\n')[0];
  if (!firstLine.includes(EXPECTED_SIWS_DOMAIN)) {
    throw new Error(`SIWS message first line does not contain "${EXPECTED_SIWS_DOMAIN}": "${firstLine}"`);
  }
  console.log(`[public-e2e]   SIWS first line OK: "${firstLine}"`);
  const signature = Array.from(wallet.signMessage(message));
  const verifyRes = await postJson('/api/auth/verify', { nonce, address: wallet.address, signature });
  if (verifyRes.status !== 200) {
    throw new Error(`verify → HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  }
  const { token } = verifyRes.json ?? {};
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error(`verify response missing session token: ${JSON.stringify(verifyRes.json)}`);
  }
  session = { token, mode };
  console.log(
    `[public-e2e]   mode=${mode} user=${USERNAME} wallet=${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)} token=${token.slice(0, 8)}…`
  );
}

async function caseConnect() {
  if (!session) throw new Error('no session token (auth case failed)');
  const res = await postJson(
    '/api/vm/net/connect',
    {
      host: process.env.MC_HOST ?? '127.0.0.1',
      port: Number(process.env.MC_PORT ?? 25565),
    },
    { Authorization: `Bearer ${session.token}` }
  );
  if (res.status !== 200) {
    throw new Error(`POST /api/vm/net/connect → HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  const { token, remote } = res.json ?? {};
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`connect response has no connection token: ${JSON.stringify(res.json)}`);
  }
  connection = { token, remote };
  console.log(
    `[public-e2e]   connection token issued over HTTPS (${token.length} chars), remote=${JSON.stringify(remote ?? null)}`
  );
}

async function caseWssSocket() {
  if (!session) throw new Error('no session token (auth case failed)');
  // openProxyStream does its own /connect (connection tokens are single-use)
  // then dials the data socket; assert the derived URL really is wss://.
  proxy = await openProxyStream({ gatewayUrl: BASE, bearerToken: session.token });
  const wsUrl = proxy.ws.url ?? '';
  if (!wsUrl.startsWith('wss://')) {
    throw new Error(`data socket URL is not wss:// — got "${wsUrl}"`);
  }
  console.log(`[public-e2e]   data socket open: ${wsUrl.replace(/token=[^&]+/, 'token=<redacted>')}`);
}

async function caseBotSpawns() {
  if (!proxy) throw new Error('no open wss proxy stream (socket case failed)');
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
          console.log(`[public-e2e]   (ignored error during quit: ${err?.message ?? err})`);
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
          console.log(`[public-e2e]   ${USERNAME} spawned via wss — sending chat line`);
          bot.chat(CHAT_LINE);
          await delay(1500); // let the chat packet flush
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

async function caseNoBearer() {
  let status = null;
  try {
    await openProxyStream({ gatewayUrl: BASE });
  } catch (err) {
    status = err.status ?? null;
  }
  if (status === null) throw new Error('/connect without Bearer unexpectedly succeeded');
  if (status !== 403) throw new Error(`expected HTTP 403, got ${status}`);
  console.log('[public-e2e]   /api/vm/net/connect without Bearer over public URL → 403 as expected');
}

// --------------------------------------------------------------------- main

function printSummary() {
  console.log('[public-e2e] ----------------- summary -----------------');
  for (const r of results) {
    console.log(`[public-e2e] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` — ${r.error}`}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`[public-e2e] ${passed}/${results.length} cases passed`);
  return passed === results.length && results.length > 0;
}

async function main() {
  if (!MC_VERSION) {
    console.error('[public-e2e] MC_VERSION is not set (root .env) — cannot pin the protocol version.');
    process.exit(2);
  }
  console.log(`[public-e2e] base=${BASE} username=${USERNAME} version=${MC_VERSION}`);

  // Hard global timeout: if anything hangs, dump a summary and bail.
  const globalTimer = setTimeout(() => {
    console.error(`[public-e2e] FATAL: global timeout after ${GLOBAL_TIMEOUT_MS / 1000}s — aborting`);
    printSummary();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  await runCase('1. GET /healthz over TLS (public URL)', caseHealthz);
  if (!results[0].pass) {
    console.error('[public-e2e] public endpoint unreachable/unhealthy — aborting.');
    printSummary();
    process.exit(2);
  }
  await runCase('2. fresh wallet SIWS auth over HTTPS (nonce → sign → verify, domain check)', caseAuth);
  await runCase('3. POST /api/vm/net/connect with Bearer over HTTPS → connection token', caseConnect);
  await runCase('4. data socket opens over wss://', caseWssSocket);
  await runCase(`5. mineflayer bot ${USERNAME} spawns via wss, chats, disconnects`, caseBotSpawns);
  await runCase('6. /api/vm/net/connect without Bearer over public URL → 403', caseNoBearer);

  clearTimeout(globalTimer);
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`[public-e2e] FATAL: ${err.stack ?? err}`);
  printSummary();
  process.exit(1);
});
