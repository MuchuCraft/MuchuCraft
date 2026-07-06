#!/usr/bin/env node
// e2e/run-token-e2e.js — end-to-end proof of the MUCHU 1:1 token economy:
// in-game earn (eco give) → gateway token routes → real devnet SPL transfer
// to the session's bound wallet.
//
// Assumes gateway + Paper server are ALREADY running AND devnet setup ran
// (gateway/scripts/devnet-setup.mjs filled MUCHU_MINT in root .env).
// Exit codes (same convention as run-e2e.js):
//   0 = all cases passed
//   1 = at least one case failed / timeout
//   2 = stack not running, token module not live, or missing config
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { loadOrCreateWallet } from './fakewallet.js';
import { openProxyStream } from './wsclient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// rcon-client lives in gateway/node_modules (this script is meant to run with
// the gateway checkout present); resolve it from there regardless of cwd.
const gatewayRequire = createRequire(path.join(__dirname, '..', 'gateway', 'package.json'));
const { Rcon } = gatewayRequire('rcon-client');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // .env is optional if the environment is already populated
}

const GATEWAY = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`;
const MC_VERSION = process.env.CLIENT_MC_VERSION || process.env.MC_VERSION;

// Safety: these suites move tokens. Refuse to run against mainnet unless
// explicitly forced — a casual re-run must never spend real funds.
if ((process.env.SOLANA_CLUSTER || '').startsWith('mainnet') && process.env.E2E_ALLOW_MAINNET !== '1') {
  console.error('[e2e] SOLANA_CLUSTER is mainnet — refusing to run token tests with real funds. Set E2E_ALLOW_MAINNET=1 to override.');
  process.exit(2);
}

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const MUCHU_MINT = (process.env.MUCHU_MINT ?? '').trim();
const DECIMALS = Number(process.env.MUCHU_DECIMALS ?? '6');
const WITHDRAW_MIN = Number(process.env.WITHDRAW_MIN ?? '10');
const WITHDRAW_MAX_PER_TX = Number(process.env.WITHDRAW_MAX_PER_TX ?? '1000');
const RCON_HOST = process.env.MC_HOST ?? '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT ?? 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD;

const USERNAME = 'E2ETester';
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // devnet is slow; be generous
const SPAWN_TIMEOUT_MS = 60_000;
const WITHDRAW_CONFIRM_TIMEOUT_MS = 240_000; // devnet flakiness: generous
const ONCHAIN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- utilities

async function apiFetch(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(new URL(pathname, GATEWAY), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** nonce → sign → verify; returns {token, ...} (same flow as run-e2e.js). */
async function authenticate(wallet, username) {
  const nonceRes = await apiFetch('/api/auth/nonce', {
    method: 'POST',
    body: { username, address: wallet.address },
  });
  if (nonceRes.status !== 200) {
    throw new Error(`nonce request → HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
  }
  const { message, nonce } = nonceRes.json ?? {};
  if (typeof message !== 'string' || typeof nonce !== 'string') {
    throw new Error(`nonce response missing message/nonce: ${JSON.stringify(nonceRes.json)}`);
  }
  const verifyRes = await apiFetch('/api/auth/verify', {
    method: 'POST',
    body: { nonce, address: wallet.address, signature: Array.from(wallet.signMessage(message)) },
  });
  if (verifyRes.status !== 200) {
    throw new Error(`verify → HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  }
  const { token } = verifyRes.json ?? {};
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error(`verify response missing session token: ${JSON.stringify(verifyRes.json)}`);
  }
  return { token };
}

/** "123.45" (≤ DECIMALS dp) → raw BigInt units. Throws on junk. */
function toRaw(decimalStr) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(decimalStr));
  if (!m) throw new Error(`not a plain decimal string: ${JSON.stringify(decimalStr)}`);
  const frac = (m[2] ?? '').slice(0, DECIMALS).padEnd(DECIMALS, '0');
  return BigInt(m[1]) * 10n ** BigInt(DECIMALS) + BigInt(frac || '0');
}

function fmtMuchu(raw) {
  const base = 10n ** BigInt(DECIMALS);
  const frac = (raw % base).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${raw / base}.${frac}` : `${raw / base}`;
}

async function retry(fn, { attempts = 4, waitMs = 3_000, label = 'operation' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.log(`[token-e2e]   ${label} attempt ${i}/${attempts} failed (${err.message}) — retrying in ${waitMs / 1000}s`);
        await delay(waitMs);
      }
    }
  }
  throw lastErr;
}

// -------------------------------------------------------------- Solana RPC

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/** Sum of MUCHU raw units across the wallet's token accounts for MUCHU_MINT. */
async function walletMuchuRaw(ownerAddress) {
  const result = await retry(
    () =>
      rpcCall('getTokenAccountsByOwner', [
        ownerAddress,
        { mint: MUCHU_MINT },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]),
    { label: 'getTokenAccountsByOwner', attempts: 5 }
  );
  let sum = 0n;
  for (const acc of result?.value ?? []) {
    sum += BigInt(acc.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0');
  }
  return sum;
}

// --------------------------------------------------------------------- RCON

async function rconSend(command) {
  const rcon = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
  try {
    return await rcon.send(command);
  } finally {
    rcon.end().catch(() => {});
  }
}

// ---------------------------------------------------- quick join (mineflayer)

/**
 * Essentials only knows players that joined at least once. If `eco give`
 * says the player is unknown, hop in once through the gateway WS proxy
 * (same pattern as run-e2e.js case 2), then retry.
 */
async function quickJoin(sessionToken) {
  console.log(`[token-e2e]   ${USERNAME} unknown to the server — doing a quick join via the WS proxy`);
  const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: sessionToken });
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
        () => finish(new Error(`quick-join bot did not spawn within ${SPAWN_TIMEOUT_MS / 1000}s`)),
        SPAWN_TIMEOUT_MS
      );
      const bot = mineflayer.createBot({
        username: USERNAME,
        auth: 'offline',
        version: MC_VERSION,
        host: process.env.MC_HOST ?? '127.0.0.1',
        port: Number(process.env.MC_PORT ?? 25565),
        connect: (client) => {
          client.setSocket(proxy.stream);
          setImmediate(() => client.emit('connect'));
        },
      });
      bot.on('error', (err) => {
        if (quitting) finish();
        else finish(new Error(`quick-join bot error: ${err?.message ?? err}`));
      });
      bot.on('kicked', (reason) => finish(new Error(`quick-join bot kicked: ${JSON.stringify(reason)}`)));
      bot.on('end', () => {
        if (quitting) finish();
        else finish(new Error('quick-join connection ended before spawn'));
      });
      bot.once('spawn', async () => {
        console.log('[token-e2e]   quick-join bot spawned — disconnecting');
        await delay(1500); // let Essentials persist the player's userdata
        quitting = true;
        bot.quit();
        setTimeout(() => finish(), 5000);
      });
    });
  } finally {
    try {
      proxy.ws.terminate();
    } catch {
      // already closed
    }
  }
  await delay(1000);
}

// ------------------------------------------------------------------ preflight

async function checkHealth() {
  let res;
  let body = null;
  try {
    res = await fetch(new URL('/healthz', GATEWAY), { signal: AbortSignal.timeout(5000) });
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error(`[token-e2e] cannot reach gateway at ${GATEWAY}/healthz: ${err.cause?.message ?? err.message}`);
    console.error('[token-e2e] the stack does not appear to be running — start it (./start-all.sh) and re-run.');
    process.exit(2);
  }
  if (!res.ok || body?.ok !== true || body.mc !== true) {
    console.error(`[token-e2e] GET /healthz → HTTP ${res.status} ${JSON.stringify(body)}`);
    console.error('[token-e2e] gateway or Minecraft server unhealthy — check logs, then re-run.');
    process.exit(2);
  }
  console.log(`[token-e2e] healthz OK — gateway ${GATEWAY}, mc reachable`);
}

async function checkConfig() {
  if (!MC_VERSION) {
    console.error('[token-e2e] MC_VERSION is not set (root .env).');
    process.exit(2);
  }
  if (!MUCHU_MINT) {
    console.error('[token-e2e] MUCHU_MINT is not set in root .env — run: cd gateway && node scripts/devnet-setup.mjs');
    process.exit(2);
  }
  if (!RCON_PASSWORD) {
    console.error('[token-e2e] RCON_PASSWORD is not set (root .env) — cannot drive `eco give`.');
    process.exit(2);
  }
}

async function checkDevnet() {
  try {
    await retry(() => rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]), {
      label: 'devnet reachability',
      attempts: 3,
    });
    console.log(`[token-e2e] devnet RPC reachable (${RPC_URL})`);
  } catch (err) {
    console.error(`[token-e2e] devnet RPC unreachable at ${RPC_URL}: ${err.message}`);
    process.exit(2);
  }
}

/** Token routes 404 until the token module is mounted — that is exit 2, not FAIL. */
async function checkTokenRoutesLive(token) {
  const res = await apiFetch('/api/token/status', { token });
  if (res.status === 404) {
    console.error('[token-e2e] GET /api/token/status → 404: token routes are not mounted (token module not live yet).');
    console.error('[token-e2e] ensure MUCHU_MINT is set in .env and the gateway was restarted with the token module.');
    process.exit(2);
  }
  if (res.status !== 200) {
    console.error(`[token-e2e] GET /api/token/status → HTTP ${res.status} ${JSON.stringify(res.json)} — token module unhealthy.`);
    process.exit(2);
  }
  return res.json;
}

// -------------------------------------------------------------------- cases

const results = [];

async function runCase(name, fn) {
  const started = Date.now();
  console.log(`[token-e2e] running: ${name}`);
  try {
    await fn();
    console.log(`[token-e2e] PASS  ${name} (${Date.now() - started}ms)`);
    results.push({ name, pass: true });
  } catch (err) {
    console.log(`[token-e2e] FAIL  ${name} (${Date.now() - started}ms): ${err.message}`);
    results.push({ name, pass: false, error: err.message });
  }
}

let wallet = null;
let session = null;
let preWithdrawOnchainRaw = null;

async function caseSession() {
  session = await authenticate(wallet, USERNAME);
  console.log(`[token-e2e]   session for ${USERNAME}, wallet ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`);
}

async function caseEcoGive() {
  if (!session) throw new Error('no session (case 1 failed)');
  const looksUnknown = (reply) =>
    /player not found|does not exist|never (been )?(seen|joined)|unknown player|no player was found/i.test(reply ?? '');
  let reply = await rconSend(`eco give ${USERNAME} 50`);
  console.log(`[token-e2e]   rcon eco give → ${JSON.stringify(reply?.trim())}`);
  if (looksUnknown(reply)) {
    // Player must have joined at least once for Essentials to have an account.
    await quickJoin(session.token);
    reply = await retry(() => rconSend(`eco give ${USERNAME} 50`), { label: 'eco give retry', attempts: 3 });
    console.log(`[token-e2e]   rcon eco give (after join) → ${JSON.stringify(reply?.trim())}`);
    if (looksUnknown(reply)) throw new Error(`player still unknown after quick join: ${reply}`);
  }
  if (/error|failed/i.test(reply ?? '') && !/has been added|added to/i.test(reply ?? '')) {
    throw new Error(`eco give did not succeed: ${JSON.stringify(reply)}`);
  }
}

async function fetchStatus() {
  const res = await apiFetch('/api/token/status', { token: session.token });
  if (res.status !== 200) {
    throw new Error(`GET /api/token/status → HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

async function caseStatusBalance() {
  if (!session) throw new Error('no session (case 1 failed)');
  // Give the bridge/economy a moment; retry a few polls.
  const deadline = Date.now() + 30_000;
  let status;
  for (;;) {
    status = await fetchStatus();
    if (typeof status?.balance === 'string' && toRaw(status.balance) >= toRaw('50')) break;
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 50 — last status: ${JSON.stringify(status)}`);
    }
    await delay(2_500);
  }
  console.log(`[token-e2e]   status: balance=${status.balance} cluster=${status.cluster} mint=${String(status.mint).slice(0, 8)}…`);
  if (status.boundWallet && status.boundWallet !== wallet.address) {
    throw new Error(`boundWallet ${status.boundWallet} != e2e wallet ${wallet.address}`);
  }
  if (status.mint && status.mint !== MUCHU_MINT) {
    throw new Error(`status.mint ${status.mint} != MUCHU_MINT ${MUCHU_MINT}`);
  }
}

function findWithdrawal(listJson, id) {
  const list = Array.isArray(listJson) ? listJson : listJson?.withdrawals ?? [];
  return list.find((w) => w?.id === id || w?.withdrawalId === id) ?? null;
}

async function pollWithdrawalTerminal(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await apiFetch('/api/token/withdrawals', { token: session.token });
      if (res.status === 200) {
        const row = findWithdrawal(res.json, id);
        if (row) {
          if (row.state !== last) {
            last = row.state;
            console.log(`[token-e2e]   withdrawal ${id} → state=${row.state}${row.signature ? ` sig=${String(row.signature).slice(0, 12)}…` : ''}`);
          }
          if (['confirmed', 'failed', 'refunded'].includes(row.state)) return row;
        }
      }
    } catch (err) {
      console.log(`[token-e2e]   withdrawals poll error (retrying): ${err.message}`);
    }
    await delay(3_000);
  }
  throw new Error(`withdrawal ${id} not terminal within ${timeoutMs / 1000}s (last state: ${last})`);
}

async function caseWithdrawConfirmed() {
  if (!session) throw new Error('no session (case 1 failed)');
  // Snapshot the on-chain balance BEFORE withdrawing (case 5 checks the delta).
  preWithdrawOnchainRaw = await walletMuchuRaw(wallet.address);
  console.log(`[token-e2e]   on-chain MUCHU before withdraw: ${fmtMuchu(preWithdrawOnchainRaw)}`);

  const res = await apiFetch('/api/token/withdraw', {
    method: 'POST',
    token: session.token,
    body: { amount: '25' },
  });
  if (res.status !== 202) {
    throw new Error(`POST /withdraw 25 → HTTP ${res.status} ${JSON.stringify(res.json)} (expected 202)`);
  }
  const id = res.json?.withdrawalId;
  if (id === undefined || id === null) {
    throw new Error(`202 body missing withdrawalId: ${JSON.stringify(res.json)}`);
  }
  console.log(`[token-e2e]   withdraw 25 accepted → withdrawalId=${id}`);
  const row = await pollWithdrawalTerminal(id, WITHDRAW_CONFIRM_TIMEOUT_MS);
  if (row.state !== 'confirmed') {
    throw new Error(`withdrawal ended in state '${row.state}' (error: ${row.error ?? 'n/a'})`);
  }
  console.log(`[token-e2e]   confirmed, signature ${row.signature}`);
}

async function caseOnchainDelta() {
  if (preWithdrawOnchainRaw === null) throw new Error('no pre-withdraw snapshot (case 4 failed)');
  const expected = 25n * 10n ** BigInt(DECIMALS); // 25 MUCHU = 25_000_000 raw @ 6dp
  const deadline = Date.now() + ONCHAIN_TIMEOUT_MS;
  let delta = null;
  for (;;) {
    const now = await walletMuchuRaw(wallet.address);
    delta = now - preWithdrawOnchainRaw;
    if (delta === expected) break;
    if (Date.now() > deadline) {
      throw new Error(`on-chain delta is ${delta} raw (${fmtMuchu(delta < 0n ? 0n : delta)} MUCHU), expected exactly ${expected} raw`);
    }
    await delay(4_000); // RPC nodes can lag the confirmed tx briefly
  }
  console.log(`[token-e2e]   bound wallet gained exactly ${fmtMuchu(expected)} MUCHU (${expected} raw)`);
}

async function caseBelowMin() {
  // WITHDRAW_MIN=10 in .env; 5 is below it.
  const res = await apiFetch('/api/token/withdraw', {
    method: 'POST',
    token: session.token,
    body: { amount: '5' },
  });
  if (res.status !== 400) {
    throw new Error(`withdraw 5 (below min ${WITHDRAW_MIN}) → HTTP ${res.status} ${JSON.stringify(res.json)} (expected 400)`);
  }
  console.log(`[token-e2e]   withdraw 5 → 400 as expected (${res.json?.error ?? 'no error text'})`);
}

async function caseOverBalance() {
  // Spec intent: an amount over the in-game balance → 409 insufficient. The
  // literal 10000 would trip the max-per-tx (400) first, so pick an amount
  // that is over the balance but inside [min, max-per-tx].
  const status = await fetchStatus();
  const balanceRaw = toRaw(status.balance ?? '0');
  const over = Math.min(Number(balanceRaw / 10n ** BigInt(DECIMALS)) + 50, WITHDRAW_MAX_PER_TX);
  if (toRaw(String(over)) <= balanceRaw) {
    throw new Error(`cannot pick an over-balance amount ≤ max-per-tx (balance=${status.balance}, max=${WITHDRAW_MAX_PER_TX}) — drain the E2ETester balance and re-run`);
  }
  const res = await apiFetch('/api/token/withdraw', {
    method: 'POST',
    token: session.token,
    body: { amount: String(over) },
  });
  if (res.status !== 409) {
    throw new Error(`withdraw ${over} (over balance ${status.balance}) → HTTP ${res.status} ${JSON.stringify(res.json)} (expected 409)`);
  }
  console.log(`[token-e2e]   withdraw ${over} (balance ${status.balance}) → 409 as expected (${res.json?.error ?? ''})`);
}

async function caseSecondInFlight() {
  // Two withdrawals submitted back-to-back: exactly one 202, the other 409
  // (one non-terminal withdrawal per user).
  const post = () =>
    apiFetch('/api/token/withdraw', { method: 'POST', token: session.token, body: { amount: '10' } });
  const [a, b] = await Promise.all([post(), post()]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  if (!(statuses[0] === 202 && statuses[1] === 409)) {
    throw new Error(`two fast withdraws → ${a.status}/${b.status} (expected one 202 and one 409): ${JSON.stringify([a.json, b.json])}`);
  }
  console.log(`[token-e2e]   two fast withdraws → ${a.status} + ${b.status} as expected`);
  // Cleanup so re-runs start without an in-flight withdrawal (best-effort).
  const accepted = a.status === 202 ? a : b;
  const id = accepted.json?.withdrawalId;
  if (id !== undefined && id !== null) {
    try {
      const row = await pollWithdrawalTerminal(id, WITHDRAW_CONFIRM_TIMEOUT_MS);
      console.log(`[token-e2e]   in-flight withdrawal ${id} settled: ${row.state}`);
    } catch (err) {
      console.log(`[token-e2e]   WARNING: cleanup withdrawal ${id} still pending (${err.message}) — next run may 409 on case 4`);
    }
  }
}

// --------------------------------------------------------------------- main

function printSummary() {
  console.log('[token-e2e] ----------------- summary -----------------');
  for (const r of results) {
    console.log(`[token-e2e] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` — ${r.error}`}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`[token-e2e] ${passed}/${results.length} cases passed`);
  return passed === results.length && results.length > 0;
}

async function main() {
  await checkConfig();

  const globalTimer = setTimeout(() => {
    console.error(`[token-e2e] FATAL: global timeout after ${GLOBAL_TIMEOUT_MS / 1000}s — aborting`);
    printSummary();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  await checkHealth();
  await checkDevnet();

  // Same persisted wallet as run-e2e.js so the E2ETester username stays bound
  // to it — withdrawals land in this wallet.
  wallet = loadOrCreateWallet(path.join(__dirname, '.e2e-wallet.json'));

  await runCase('1. session for E2ETester (persisted fakewallet)', caseSession);
  if (!session) {
    clearTimeout(globalTimer);
    printSummary();
    process.exit(1);
  }

  // Not-live token module is an environment problem, not a test failure.
  await checkTokenRoutesLive(session.token);

  await runCase('2. RCON `eco give E2ETester 50` (quick-join first if unknown)', caseEcoGive);
  await runCase('3. GET /api/token/status shows balance ≥ 50', caseStatusBalance);
  await runCase("4. POST /withdraw 25 → 202, polls to 'confirmed'", caseWithdrawConfirmed);
  await runCase('5. on-chain: bound wallet ATA gained exactly 25 MUCHU (25000000 raw)', caseOnchainDelta);
  await runCase(`6a. withdraw 5 (below min ${WITHDRAW_MIN}) → 400`, caseBelowMin);
  await runCase('6b. withdraw over balance → 409', caseOverBalance);
  await runCase('6c. second withdraw while first in-flight → 409', caseSecondInFlight);

  clearTimeout(globalTimer);
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`[token-e2e] FATAL: ${err.stack ?? err}`);
  printSummary();
  process.exit(1);
});
