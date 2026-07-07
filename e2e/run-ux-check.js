#!/usr/bin/env node
// e2e/run-ux-check.js — integrator UX checks, one wallet-bound bot session:
//   A. /deposit chat reply carries the treasury address AND the deposit-page link text
//   B. Adventure plate at (-2,111,30): stepping on it spreadplayers the bot >150 blocks out
//   C. /tpr randomly teleports (Essentials tpr.yml, 200..2400 from 0,0; 3s warmup)
//   D. /kit daily delivers items once; the second claim is refused (24h cooldown)
// Assumes gateway + Paper are running. Exit 0 = all hard checks pass.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { loadOrCreateWallet } from './fakewallet.js';
import { openProxyStream } from './wsclient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* optional */ }

const GATEWAY = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? '8090'}`;
const MC_VERSION = process.env.CLIENT_MC_VERSION || process.env.MC_VERSION;
const USERNAME = 'E2ETester';
const WALLET_PATH = path.join(__dirname, '.e2e-wallet.json');
const RCON_HELPER = path.join(__dirname, '..', 'scripts', 'rcon-cmd.mjs');
const PLATE = { x: -1.5, y: 111, z: 30.5 }; // stand on the plate block (-2,111,30)
const SPAWN = { x: 0.5, y: 118, z: 0.5 };

const results = [];
function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`[ux] ${pass ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`);
}

function rcon(cmd) {
  return execFileSync('node', [RCON_HELPER, cmd], { encoding: 'utf8' });
}

async function postJson(pathname, payload) {
  const res = await fetch(new URL(pathname, GATEWAY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function authenticate(wallet, username) {
  const n = await postJson('/api/auth/nonce', { username, address: wallet.address });
  if (n.status !== 200) throw new Error(`nonce → HTTP ${n.status} ${JSON.stringify(n.json)}`);
  const v = await postJson('/api/auth/verify', {
    nonce: n.json.nonce,
    address: wallet.address,
    signature: Array.from(wallet.signMessage(n.json.message)),
  });
  if (v.status !== 200) throw new Error(`verify → HTTP ${v.status} ${JSON.stringify(v.json)}`);
  return v.json.token;
}

const horiz = (p) => Math.hypot(p.x, p.z);

async function main() {
  const wallet = loadOrCreateWallet(WALLET_PATH);
  const token = await authenticate(wallet, USERNAME);
  console.log(`[ux] authenticated ${USERNAME} (wallet ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)})`);

  const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: token });
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

  const messages = [];
  bot.on('message', (m) => {
    const text = m.toString();
    messages.push({ t: Date.now(), text });
    console.log(`[ux]   <chat> ${text}`);
  });
  bot.on('kicked', (r) => console.log(`[ux] KICKED: ${JSON.stringify(r)}`));
  bot.on('error', (e) => console.log(`[ux] bot error: ${e?.message ?? e}`));

  async function waitForMessage(regex, ms, since = 0) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = messages.find((m) => m.t >= since && regex.test(m.text));
      if (hit) return hit.text;
      await delay(200);
    }
    return null;
  }

  async function waitForPosition(pred, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (bot.entity?.position && pred(bot.entity.position)) return bot.entity.position.clone();
      await delay(200);
    }
    return null;
  }

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bot did not spawn in 60s')), 60_000);
    bot.once('spawn', () => { clearTimeout(t); resolve(); });
  });
  console.log('[ux] bot spawned');
  await delay(2000);

  // baseline: stand on the spawn dais
  rcon(`minecraft:tp ${USERNAME} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
  await delay(2000);
  console.log(`[ux] baseline position ${bot.entity.position}`);

  // ---- A. /deposit chat reply
  let since = Date.now();
  bot.chat('/deposit');
  const addrMsg = await waitForMessage(/A5BSgGExt51Asbon2J7YtjotUdewSpJgHzHn83PVdo8R/, 10_000, since);
  const linkMsg = await waitForMessage(/deposit page/i, 3_000, since);
  record('A. /deposit reply contains treasury address', !!addrMsg, addrMsg ?? 'no address line within 10s');
  record('A. /deposit reply contains deposit-page link text', !!linkMsg, linkMsg ?? 'no "deposit page" line');

  // ---- B. Adventure plate
  rcon(`minecraft:tp ${USERNAME} ${PLATE.x} ${PLATE.y} ${PLATE.z}`);
  const t0 = Date.now();
  const far = await waitForPosition((p) => horiz(p) > 150, 6_000);
  if (far) {
    record('B. adventure plate spreadplayers', true,
      `landed at (${far.x.toFixed(1)}, ${far.y.toFixed(1)}, ${far.z.toFixed(1)}) — ${horiz(far).toFixed(0)} blocks from origin in ${Date.now() - t0}ms`);
  } else {
    record('B. adventure plate spreadplayers', false,
      `still at ${bot.entity.position} after 6s on the plate`);
  }

  // ---- optional: /back (soft check, no hard assert)
  since = Date.now();
  bot.chat('/back');
  const backMsg = await waitForMessage(/./, 5_000, since);
  console.log(`[ux] (soft) /back replied: ${backMsg ?? '<nothing within 5s>'}`);

  // return to spawn for a clean /tpr start
  rcon(`minecraft:tp ${USERNAME} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
  await delay(2500);

  // ---- C. /tpr (3s warmup, async safe-location search)
  since = Date.now();
  bot.chat('/tpr');
  const tprPos = await waitForPosition((p) => horiz(p) > 150, 30_000);
  if (tprPos) {
    record('C. /tpr random teleport', true,
      `landed at (${tprPos.x.toFixed(1)}, ${tprPos.y.toFixed(1)}, ${tprPos.z.toFixed(1)}) — ${horiz(tprPos).toFixed(0)} blocks out in ${Date.now() - since}ms`);
  } else {
    const err = messages.filter((m) => m.t >= since).map((m) => m.text).join(' | ');
    record('C. /tpr random teleport', false, `no teleport in 30s; replies: ${err || '<none>'}`);
  }
  await delay(2000);

  // ---- D. /kit daily — first claim delivers, second refused
  const invBefore = bot.inventory.items().reduce((n, i) => n + i.count, 0);
  since = Date.now();
  bot.chat('/kit daily');
  const kitMsg = await waitForMessage(/kit/i, 10_000, since);
  await delay(2000);
  const invAfter = bot.inventory.items().reduce((n, i) => n + i.count, 0);
  const names = bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ');
  record('D. /kit daily first claim delivers items', invAfter > invBefore,
    `inventory ${invBefore} → ${invAfter} items (${names || 'empty'}); reply: ${kitMsg ?? '<none>'}`);

  since = Date.now();
  bot.chat('/kit daily');
  const refusal = await waitForMessage(/can.?t use|cooldown|another|wait/i, 10_000, since);
  const invAfter2 = bot.inventory.items().reduce((n, i) => n + i.count, 0);
  record('D. /kit daily second claim refused', !!refusal && invAfter2 === invAfter,
    `reply: ${refusal ?? '<no refusal message>'}; inventory ${invAfter} → ${invAfter2}`);

  // tidy up: bot back to spawn, then quit
  rcon(`minecraft:tp ${USERNAME} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
  await delay(1000);
  bot.quit();
  await delay(1500);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[ux] ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`[ux] fatal: ${err.stack ?? err}`);
  process.exit(1);
});
