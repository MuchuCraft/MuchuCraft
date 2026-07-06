#!/usr/bin/env node
// e2e/run-deposit-e2e.js — end-to-end proof of MUCHU deposits (SPEC-PHASE3 §1):
// real devnet SPL transfer from the E2ETester wallet → treasury, gateway
// watcher credits in-game 1:1, earn gate unlocks, dust is recorded but never
// credited, and the in-game /deposit command replies with the deposit address.
//
// Assumes gateway + Paper server are ALREADY running, the token module is
// live (MUCHU_MINT set) and the E2ETester persisted wallet (.e2e-wallet.json)
// holds devnet MUCHU from earlier run-token-e2e.js withdrawals (≥ ~26) plus
// SOL for fees. Exit codes (same convention as run-e2e.js):
//   0 = all cases passed
//   1 = at least one case failed / timeout
//   2 = stack not running, token/deposit module not live, or missing funds/config
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import mineflayer from 'mineflayer';
import { loadOrCreateWallet } from './fakewallet.js';
import { openProxyStream } from './wsclient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// rcon-client and the Solana libs live in gateway/node_modules (this script is
// meant to run with the gateway checkout present); resolve them from there.
const gatewayRequire = createRequire(path.join(__dirname, '..', 'gateway', 'package.json'));
const { Rcon } = gatewayRequire('rcon-client');
const {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} = gatewayRequire('@solana/kit');
const splToken = gatewayRequire('@solana-program/token');
const splToken2022 = gatewayRequire('@solana-program/token-2022');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // .env is optional if the environment is already populated
}

const GATEWAY = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`;
const MC_VERSION = process.env.MC_VERSION;
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const MUCHU_MINT = (process.env.MUCHU_MINT ?? '').trim();
const DECIMALS = Number(process.env.MUCHU_DECIMALS ?? '6');
const DEPOSIT_MIN = process.env.DEPOSIT_MIN ?? '1';
const DEPOSIT_GATE_MIN = process.env.DEPOSIT_GATE_MIN ?? '25';
const POLL_SECONDS = Number(process.env.DEPOSIT_POLL_SECONDS ?? '20');
const RCON_HOST = process.env.MC_HOST ?? '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT ?? 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const LP_DIR = path.join(__dirname, '..', 'server', 'plugins', 'LuckPerms');

const USERNAME = 'E2ETester';
const WALLET_PATH = path.join(__dirname, '.e2e-wallet.json');
const GLOBAL_TIMEOUT_MS = 12 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 60_000;
const TX_CONFIRM_TIMEOUT_MS = 120_000;
const CREDIT_POLL_TIMEOUT_MS = 3 * 60 * 1000; // spec: credit + gate flip within ≤3 min
// "after 2 poll cycles it appears" — 2 cycles + generous devnet/RPC margin
const DUST_TIMEOUT_MS = Math.max(2 * POLL_SECONDS * 1000 + 60_000, 100_000);
const CHAT_REPLY_TIMEOUT_MS = 30_000;

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

/** nonce → sign → verify; returns {token} (same flow as run-token-e2e.js). */
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
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const frac = (abs % base).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

async function retry(fn, { attempts = 4, waitMs = 3_000, label = 'operation' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.log(`[deposit-e2e]   ${label} attempt ${i}/${attempts} failed (${err.message}) — retrying in ${waitMs / 1000}s`);
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

/**
 * Build + sign + send a TransferChecked of `rawAmount` MUCHU from the e2e
 * wallet to `destOwner` (the treasury deposit address), using @solana/kit +
 * @solana-program/token(-2022) from gateway/node_modules — the mint's owner
 * program is detected so a Token-2022 mint works unchanged. Resolves the
 * signature once the transaction is CONFIRMED.
 */
async function sendMuchu(destOwner, rawAmount, signer) {
  const acc = await retry(
    () => rpcCall('getAccountInfo', [MUCHU_MINT, { encoding: 'base64' }]),
    { label: 'getAccountInfo(mint)' }
  );
  if (!acc?.value) throw new Error(`mint ${MUCHU_MINT} not found on-chain`);
  const programId = String(acc.value.owner);
  const mod = programId === String(splToken2022.TOKEN_2022_PROGRAM_ADDRESS) ? splToken2022 : splToken;
  const tokenProgram = address(programId);
  const mintAddress = address(MUCHU_MINT);
  const dest = address(destOwner);
  const [srcAta] = await mod.findAssociatedTokenPda({ owner: signer.address, mint: mintAddress, tokenProgram });
  const [destAta] = await mod.findAssociatedTokenPda({ owner: dest, mint: mintAddress, tokenProgram });

  const latest = await retry(
    () => rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]),
    { label: 'getLatestBlockhash' }
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
      },
      m
    ),
    (m) => appendTransactionMessageInstructions(
      [
        // Idempotent no-op when the treasury ATA already exists (it does).
        mod.getCreateAssociatedTokenIdempotentInstruction({
          payer: signer, ata: destAta, owner: dest, mint: mintAddress, tokenProgram,
        }),
        mod.getTransferCheckedInstruction({
          source: srcAta,
          mint: mintAddress,
          destination: destAta,
          authority: signer,
          amount: rawAmount,
          decimals: DECIMALS,
        }),
      ],
      m
    )
  );
  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);
  const wire = getBase64EncodedWireTransaction(signedTx);
  console.log(`[deposit-e2e]   sending ${fmtMuchu(rawAmount)} MUCHU → ${destOwner.slice(0, 4)}…${destOwner.slice(-4)} (sig ${String(signature).slice(0, 12)}…)`);

  const deadline = Date.now() + TX_CONFIRM_TIMEOUT_MS;
  for (;;) {
    try {
      // Rebroadcasting the same signed bytes is idempotent on-chain.
      await rpcCall('sendTransaction', [wire, { encoding: 'base64', skipPreflight: false, maxRetries: 0 }]);
    } catch (err) {
      if (!/already been processed|already processed/i.test(err.message)) {
        console.log(`[deposit-e2e]   sendTransaction: ${err.message} (will retry)`);
      }
    }
    const st = (await rpcCall('getSignatureStatuses', [[String(signature)], { searchTransactionHistory: true }]))?.value?.[0];
    if (st?.err) throw new Error(`transfer ${signature} FAILED on-chain: ${JSON.stringify(st.err)}`);
    if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus)) {
      console.log(`[deposit-e2e]   confirmed on devnet (slot ${st.slot})`);
      return String(signature);
    }
    if (Date.now() > deadline) {
      throw new Error(`transfer ${signature} not confirmed within ${TX_CONFIRM_TIMEOUT_MS / 1000}s`);
    }
    await delay(3_000);
  }
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

/**
 * VERIFIED LIVE (LuckPerms 5.5 on Paper 1.21.11): LuckPerms executes RCON
 * commands asynchronously, so `lp user … parent info` returns an EMPTY RCON
 * reply and prints nothing to latest.log. The observable equivalent is
 * `lp export <name>` → plugins/LuckPerms/<name>.json.gz, whose users[].nodes
 * carry {type:'inheritance', key:'group.depositor'} entries.
 */
async function userHasDepositorGroup(username) {
  const name = `deposit-e2e-${Date.now()}`;
  const file = path.join(LP_DIR, `${name}.json.gz`);
  await rconSend(`lp export ${name}`);
  for (let i = 0; i < 20 && !existsSync(file); i++) await delay(500); // export is async
  if (!existsSync(file)) return { found: false, reason: `lp export produced no ${file}` };
  try {
    const json = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    for (const user of Object.values(json.users ?? {})) {
      if (String(user.username ?? '').toLowerCase() !== username.toLowerCase()) continue;
      const has = (user.nodes ?? []).some(
        (n) => n.type === 'inheritance' && n.key === 'group.depositor' && n.value !== false
      );
      return { found: has, reason: has ? 'group.depositor inheritance node present' : 'user exported without group.depositor' };
    }
    return { found: false, reason: 'user not in export (no explicit LuckPerms data yet)' };
  } finally {
    try { unlinkSync(file); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------- quick join (mineflayer)

/** Join once through the WS proxy so Essentials knows the player (run-token-e2e pattern). */
async function quickJoin(sessionToken) {
  console.log(`[deposit-e2e]   ${USERNAME} unknown to the server — doing a quick join via the WS proxy`);
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
        host: RCON_HOST,
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

async function checkConfig() {
  const missing = [];
  if (!MC_VERSION) missing.push('MC_VERSION');
  if (!MUCHU_MINT) missing.push('MUCHU_MINT (run gateway/scripts/devnet-setup.mjs)');
  if (!RCON_PASSWORD) missing.push('RCON_PASSWORD');
  if (missing.length) {
    console.error(`[deposit-e2e] missing config in root .env: ${missing.join(', ')}`);
    process.exit(2);
  }
}

async function checkHealth() {
  let res;
  let body = null;
  try {
    res = await fetch(new URL('/healthz', GATEWAY), { signal: AbortSignal.timeout(5000) });
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error(`[deposit-e2e] cannot reach gateway at ${GATEWAY}/healthz: ${err.cause?.message ?? err.message}`);
    console.error('[deposit-e2e] the stack does not appear to be running — start it (./start-all.sh) and re-run.');
    process.exit(2);
  }
  if (!res.ok || body?.ok !== true || body.mc !== true) {
    console.error(`[deposit-e2e] GET /healthz → HTTP ${res.status} ${JSON.stringify(body)}`);
    console.error('[deposit-e2e] gateway or Minecraft server unhealthy — check logs, then re-run.');
    process.exit(2);
  }
  console.log(`[deposit-e2e] healthz OK — gateway ${GATEWAY}, mc reachable`);
}

async function checkDevnet() {
  try {
    await retry(() => rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]), {
      label: 'devnet reachability',
      attempts: 3,
    });
    console.log(`[deposit-e2e] devnet RPC reachable (${RPC_URL})`);
  } catch (err) {
    console.error(`[deposit-e2e] devnet RPC unreachable at ${RPC_URL}: ${err.message}`);
    process.exit(2);
  }
}

/** Token routes 404 until the token module is mounted — exit 2, not FAIL. */
async function checkTokenRoutesLive(token) {
  const res = await apiFetch('/api/token/status', { token });
  if (res.status === 404) {
    console.error('[deposit-e2e] GET /api/token/status → 404: token routes are not mounted (token module not live).');
    process.exit(2);
  }
  if (res.status !== 200) {
    console.error(`[deposit-e2e] GET /api/token/status → HTTP ${res.status} ${JSON.stringify(res.json)} — token module unhealthy.`);
    process.exit(2);
  }
  return res.json;
}

/** The e2e wallet must already hold the funds this test spends (exit 2 if not). */
async function checkWalletFunds(wallet, signer) {
  if (!signer) {
    console.error(`[deposit-e2e] ${WALLET_PATH} unreadable — run run-e2e.js/run-token-e2e.js first to create + fund the persisted wallet.`);
    process.exit(2);
  }
  const needRaw = toRaw(DEPOSIT_GATE_MIN) + toRaw(DEPOSIT_MIN); // 25 deposit + dust headroom
  const muchu = await walletMuchuRaw(wallet.address);
  const lamports = BigInt((await rpcCall('getBalance', [wallet.address, { commitment: 'confirmed' }]))?.value ?? 0);
  console.log(`[deposit-e2e] e2e wallet ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}: ${fmtMuchu(muchu)} MUCHU, ${Number(lamports) / 1e9} SOL`);
  if (muchu < needRaw) {
    console.error(`[deposit-e2e] wallet holds ${fmtMuchu(muchu)} MUCHU but this run needs ≥ ${fmtMuchu(needRaw)} — run run-token-e2e.js (withdrawals fund this wallet) and re-run.`);
    process.exit(2);
  }
  if (lamports < 3_000_000n) { // fee headroom for two transfers
    console.error('[deposit-e2e] wallet has < 0.003 SOL for fees — airdrop devnet SOL to it and re-run.');
    process.exit(2);
  }
}

// -------------------------------------------------------------------- cases

const results = [];

async function runCase(name, fn) {
  const started = Date.now();
  console.log(`[deposit-e2e] running: ${name}`);
  try {
    await fn();
    console.log(`[deposit-e2e] PASS  ${name} (${Date.now() - started}ms)`);
    results.push({ name, pass: true });
  } catch (err) {
    console.log(`[deposit-e2e] FAIL  ${name} (${Date.now() - started}ms): ${err.message}`);
    results.push({ name, pass: false, error: err.message });
  }
}

let wallet = null;
let signer = null;
let session = null;
let depositAddress = null;
let balanceBeforeRaw = null;
let cumulativeBeforeRaw = null;

async function fetchStatus() {
  const res = await apiFetch('/api/token/status', { token: session.token });
  if (res.status !== 200) {
    throw new Error(`GET /api/token/status → HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

async function fetchDeposits() {
  const res = await apiFetch('/api/token/deposits', { token: session.token });
  if (res.status !== 200) {
    throw new Error(`GET /api/token/deposits → HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  if (!Array.isArray(res.json)) {
    throw new Error(`GET /api/token/deposits did not return an array: ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

// 1) session + status → deposit address + gate shape
async function caseStatusDepositBlock() {
  session = await authenticate(wallet, USERNAME);
  await checkTokenRoutesLive(session.token);
  const status = await fetchStatus();
  const dep = status.deposit;
  if (!dep || typeof dep !== 'object') {
    throw new Error(`status has no deposit block: ${JSON.stringify(status)}`);
  }
  if (typeof dep.address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dep.address)) {
    throw new Error(`deposit.address is not a base58 Solana address: ${JSON.stringify(dep.address)}`);
  }
  if (dep.minimum !== DEPOSIT_MIN) {
    throw new Error(`deposit.minimum ${JSON.stringify(dep.minimum)} != DEPOSIT_MIN ${DEPOSIT_MIN}`);
  }
  const gate = dep.gate;
  if (!gate || gate.threshold !== DEPOSIT_GATE_MIN || !/^\d+$/.test(String(gate.cumulativeRaw)) ||
      typeof gate.unlocked !== 'boolean') {
    throw new Error(`deposit.gate shape wrong: ${JSON.stringify(gate)}`);
  }
  depositAddress = dep.address;
  balanceBeforeRaw = toRaw(status.balance ?? '0');
  cumulativeBeforeRaw = BigInt(gate.cumulativeRaw);
  console.log(`[deposit-e2e]   deposit address ${depositAddress.slice(0, 6)}…, min ${dep.minimum}, gate ${gate.threshold} — cumulative ${fmtMuchu(cumulativeBeforeRaw)}, ${gate.unlocked ? 'UNLOCKED (prior runs)' : 'locked (expected on a fresh run)'}`);
  console.log(`[deposit-e2e]   in-game balance before deposit: ${fmtMuchu(balanceBeforeRaw)}`);
}

// 2) send 25 MUCHU on devnet from the e2e wallet → treasury
let depositSignature = null;
async function caseSendDeposit() {
  if (!session || !depositAddress) throw new Error('no session/deposit address (case 1 failed)');
  // The bridge can only credit players Essentials knows — join once if needed.
  const looksUnknown = (reply) =>
    /player not found|does not exist|never (been )?(seen|joined)|unknown player|no player was found/i.test(reply ?? '');
  const balReply = await rconSend(`balance ${USERNAME}`);
  if (looksUnknown(balReply)) await quickJoin(session.token);
  depositSignature = await sendMuchu(depositAddress, toRaw(DEPOSIT_GATE_MIN), signer);
}

// 3) poll status ≤3 min: in-game balance +25 and gate.unlocked
async function caseCreditAndGate() {
  if (!depositSignature) throw new Error('no deposit signature (case 2 failed)');
  const expectedRaw = balanceBeforeRaw + toRaw(DEPOSIT_GATE_MIN);
  const deadline = Date.now() + CREDIT_POLL_TIMEOUT_MS;
  let status = null;
  for (;;) {
    status = await fetchStatus();
    const bal = toRaw(status.balance ?? '0');
    if (bal >= expectedRaw && status.deposit?.gate?.unlocked === true) break;
    if (Date.now() > deadline) {
      const rows = await fetchDeposits().catch(() => []);
      throw new Error(
        `credit/gate not observed within ${CREDIT_POLL_TIMEOUT_MS / 1000}s — balance ${status.balance} ` +
        `(need ${fmtMuchu(expectedRaw)}), gate ${JSON.stringify(status.deposit?.gate)}, ` +
        `deposit row: ${JSON.stringify(rows.find((d) => d.signature === depositSignature) ?? null)}`
      );
    }
    await delay(5_000);
  }
  console.log(`[deposit-e2e]   balance ${status.balance} (+${DEPOSIT_GATE_MIN}), gate unlocked, cumulativeRaw ${status.deposit.gate.cumulativeRaw}`);
  const row = (await fetchDeposits()).find((d) => d.signature === depositSignature);
  if (!row || row.status !== 'credited') {
    throw new Error(`deposit ${depositSignature} not listed as credited: ${JSON.stringify(row ?? null)}`);
  }
  console.log(`[deposit-e2e]   /api/token/deposits shows ${row.amount} MUCHU credited (${row.signature.slice(0, 12)}…)`);
}

// 4) depositor group visible via LuckPerms
async function caseDepositorGroup() {
  // Spec-letter command first (reply is empty on this LP version — see helper).
  const reply = await rconSend(`lp user ${USERNAME} parent info`);
  if (/depositor/i.test(reply ?? '')) {
    console.log(`[deposit-e2e]   rcon parent info → ${JSON.stringify(reply.trim())}`);
    return;
  }
  console.log('[deposit-e2e]   parent info reply empty (LuckPerms async RCON) — verifying via lp export dump');
  const deadline = Date.now() + 60_000; // promotion happens on the credit tick; allow a beat
  for (;;) {
    const { found, reason } = await userHasDepositorGroup(USERNAME);
    if (found) {
      console.log(`[deposit-e2e]   ${USERNAME} inherits group.depositor (${reason})`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${USERNAME} is not in the depositor group: ${reason}`);
    }
    await delay(5_000);
  }
}

// 5) dust: 0.5 MUCHU → recorded as dust, never credited
async function caseDust() {
  if (!session || !depositAddress) throw new Error('no session/deposit address (case 1 failed)');
  const statusBefore = await fetchStatus();
  const balBefore = toRaw(statusBefore.balance ?? '0');
  const cumBefore = BigInt(statusBefore.deposit.gate.cumulativeRaw);
  const dustRaw = toRaw(DEPOSIT_MIN) / 2n; // strictly below the minimum
  if (dustRaw <= 0n) throw new Error(`cannot derive a dust amount below DEPOSIT_MIN=${DEPOSIT_MIN}`);
  const sig = await sendMuchu(depositAddress, dustRaw, signer);

  const deadline = Date.now() + DUST_TIMEOUT_MS;
  let row = null;
  for (;;) {
    row = (await fetchDeposits()).find((d) => d.signature === sig) ?? null;
    if (row) break;
    if (Date.now() > deadline) {
      throw new Error(`dust deposit ${sig} not in /api/token/deposits after ${DUST_TIMEOUT_MS / 1000}s (2 poll cycles + margin)`);
    }
    await delay(5_000);
  }
  if (row.status !== 'dust') {
    throw new Error(`dust deposit has status '${row.status}' (expected 'dust'): ${JSON.stringify(row)}`);
  }
  if (row.amountRaw !== dustRaw.toString()) {
    throw new Error(`dust row amountRaw ${row.amountRaw} != sent ${dustRaw}`);
  }
  const statusAfter = await fetchStatus();
  const balAfter = toRaw(statusAfter.balance ?? '0');
  if (balAfter !== balBefore) {
    throw new Error(`balance changed after dust: ${fmtMuchu(balBefore)} → ${fmtMuchu(balAfter)} (dust must NOT credit)`);
  }
  if (BigInt(statusAfter.deposit.gate.cumulativeRaw) !== cumBefore) {
    throw new Error(`gate cumulative changed after dust: ${cumBefore} → ${statusAfter.deposit.gate.cumulativeRaw}`);
  }
  console.log(`[deposit-e2e]   ${fmtMuchu(dustRaw)} MUCHU recorded as dust, balance unchanged at ${statusAfter.balance}`);
}

// 6) bot joins and runs /deposit; the chat reply contains the deposit address
async function caseDepositCommand() {
  if (!session || !depositAddress) throw new Error('no session/deposit address (case 1 failed)');
  const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: session.token });
  const messages = [];
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(spawnTimer);
        clearTimeout(replyTimer);
        try { bot.quit(); } catch { /* already gone */ }
        if (err) reject(err);
        else resolve();
      };
      const spawnTimer = setTimeout(
        () => finish(new Error(`bot did not spawn within ${SPAWN_TIMEOUT_MS / 1000}s`)),
        SPAWN_TIMEOUT_MS
      );
      let replyTimer = null;
      const bot = mineflayer.createBot({
        username: USERNAME,
        auth: 'offline',
        version: MC_VERSION,
        host: RCON_HOST,
        port: Number(process.env.MC_PORT ?? 25565),
        connect: (client) => {
          client.setSocket(proxy.stream);
          setImmediate(() => client.emit('connect'));
        },
      });
      bot.on('error', (err) => finish(new Error(`bot error: ${err?.message ?? err}`)));
      bot.on('kicked', (reason) => finish(new Error(`bot kicked: ${JSON.stringify(reason)}`)));
      bot.on('end', () => finish(new Error('connection ended before the /deposit reply')));
      bot.on('message', (jsonMsg) => {
        const text = jsonMsg?.toString?.() ?? String(jsonMsg);
        messages.push(text);
        if (text.includes(depositAddress)) {
          console.log(`[deposit-e2e]   /deposit reply: ${JSON.stringify(text.trim())}`);
          finish();
        }
      });
      bot.once('spawn', async () => {
        clearTimeout(spawnTimer);
        await delay(1500);
        console.log('[deposit-e2e]   bot spawned — sending /deposit');
        bot.chat('/deposit');
        replyTimer = setTimeout(
          () => finish(new Error(
            `no chat reply containing the deposit address within ${CHAT_REPLY_TIMEOUT_MS / 1000}s — ` +
            `saw: ${JSON.stringify(messages.slice(-8))}`
          )),
          CHAT_REPLY_TIMEOUT_MS
        );
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

// --------------------------------------------------------------------- main

function printSummary() {
  console.log('[deposit-e2e] ----------------- summary -----------------');
  for (const r of results) {
    console.log(`[deposit-e2e] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` — ${r.error}`}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`[deposit-e2e] ${passed}/${results.length} cases passed`);
  return passed === results.length && results.length > 0;
}

async function main() {
  await checkConfig();

  const globalTimer = setTimeout(() => {
    console.error(`[deposit-e2e] FATAL: global timeout after ${GLOBAL_TIMEOUT_MS / 1000}s — aborting`);
    printSummary();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  await checkHealth();
  await checkDevnet();

  // Same persisted wallet as run-e2e.js/run-token-e2e.js: E2ETester's bound
  // wallet, funded with MUCHU by earlier withdrawal runs.
  wallet = loadOrCreateWallet(WALLET_PATH);
  try {
    const saved = JSON.parse(readFileSync(WALLET_PATH, 'utf8'));
    signer = await createKeyPairSignerFromBytes(Uint8Array.from(saved.secretKey));
  } catch {
    signer = null;
  }
  if (signer && String(signer.address) !== wallet.address) {
    console.error('[deposit-e2e] persisted wallet/signature mismatch — .e2e-wallet.json is corrupt.');
    process.exit(2);
  }
  await checkWalletFunds(wallet, signer);

  await runCase('1. session + /api/token/status deposit block (address, minimum, gate shape)', caseStatusDepositBlock);
  if (!session || !depositAddress) {
    clearTimeout(globalTimer);
    printSummary();
    process.exit(1);
  }
  await runCase(`2. send ${DEPOSIT_GATE_MIN} MUCHU on devnet → treasury (transferChecked, confirmed)`, caseSendDeposit);
  await runCase(`3. watcher credits +${DEPOSIT_GATE_MIN} in-game and gate unlocks (≤3 min)`, caseCreditAndGate);
  await runCase('4. LuckPerms shows E2ETester in the depositor group', caseDepositorGroup);
  await runCase(`5. dust ${fmtMuchu(toRaw(DEPOSIT_MIN) / 2n)} MUCHU → recorded as dust, NOT credited`, caseDust);
  await runCase('6. bot runs /deposit in chat and the reply contains the deposit address', caseDepositCommand);

  clearTimeout(globalTimer);
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`[deposit-e2e] FATAL: ${err.stack ?? err}`);
  printSummary();
  process.exit(1);
});
