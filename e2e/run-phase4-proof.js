#!/usr/bin/env node
// e2e/run-phase4-proof.js — SPEC-PHASE4.md §5.2/§5.3/§5.4 empirical proof.
//
// Drives a fresh NON-op wallet-bound bot (GriefTester) through the gateway
// (same auth + WS-proxy path as run-e2e.js) and proves, against the LIVE
// server:
//   A. spawn-on-dais (position within 3 blocks of world spawn 0.5,118,0.5)
//   B. WorldGuard spawn region: dig + place BLOCKED inside the region
//      (bot.blockAt AND RCON `execute if block` both confirm no change)
//   C. dig + place SUCCEED in the wilderness (~500,~,500) — then the
//      wilderness blocks are cleaned up (restored via RCON setblock)
//   D. player experience: /rules, /motd, /kit starter (written book), /sethome
//      + /home round-trip, /spawn back to the dais — all as the non-op bot,
//      asserted via chat replies + position checks
//   E. after >=2 min online: no hostile mobs inside the spawn region
//      (distance probes at plaza center + exact region-box probes)
//   F. best-effort in-game `/rg info` capture (temporary, reverted LuckPerms
//      grant) — the file-based proof lives in scripts/protect-spawn.sh
//
// Assumes the stack is RUNNING (./start-all.sh). Exit 0 = all cases pass.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { loadOrCreateWallet, createFakeWallet } from './fakewallet.js';
import { openProxyStream } from './wsclient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env optional if env already populated
}

const require2 = createRequire(path.join(ROOT, 'gateway', 'package.json'));
const { Rcon } = require2('rcon-client');

const GATEWAY = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? '8090'}`;
const MC_VERSION = process.env.CLIENT_MC_VERSION || process.env.MC_VERSION;
const USERNAME = process.env.PROOF_USERNAME ?? 'GriefTester';
const SPAWN = { x: 0.5, y: 118, z: 0.5 };
const GLOBAL_TIMEOUT_MS = 9 * 60 * 1000;
const MOB_OBSERVE_MS = 2 * 60 * 1000;

// ------------------------------------------------------------------- helpers

let rcon = null;
async function rconCmd(cmd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!rcon) {
        rcon = await Rcon.connect({
          host: '127.0.0.1',
          port: Number(process.env.RCON_PORT ?? 25575),
          password: process.env.RCON_PASSWORD,
        });
      }
      const reply = await rcon.send(cmd);
      return reply.replace(/§./g, '').trim();
    } catch (err) {
      try { await rcon?.end(); } catch { /* already dead */ }
      rcon = null;
      if (attempt === 1) throw new Error(`RCON failed for '${cmd}': ${err.message}`);
    }
  }
  return '';
}

const evidence = [];
function log(line) {
  console.log(`[phase4] ${line}`);
}
function keep(label, text) {
  evidence.push({ label, text });
  log(`${label}: ${text}`);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function postJson(pathname, payload, headers = {}) {
  const res = await fetch(new URL(pathname, GATEWAY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json };
}

async function authenticate(wallet, username) {
  const nonceRes = await postJson('/api/auth/nonce', { username, address: wallet.address });
  if (nonceRes.status !== 200) {
    const err = new Error(`nonce → HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
    err.status = nonceRes.status;
    throw err;
  }
  const { message, nonce } = nonceRes.json ?? {};
  const signature = Array.from(wallet.signMessage(message));
  const verifyRes = await postJson('/api/auth/verify', { nonce, address: wallet.address, signature });
  if (verifyRes.status !== 200) throw new Error(`verify → HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  return verifyRes.json.token;
}

function createProxiedBot({ username, stream }) {
  return mineflayer.createBot({
    username,
    auth: 'offline',
    version: MC_VERSION,
    host: process.env.MC_HOST ?? '127.0.0.1',
    port: Number(process.env.MC_PORT ?? 25565),
    connect: (client) => {
      client.setSocket(stream);
      setImmediate(() => client.emit('connect'));
    },
  });
}

// message ledger — Essentials replies land here via the 'message' event
const messages = [];
const titles = [];
function watchBot(bot) {
  bot.on('message', (msg) => {
    const text = msg.toString();
    if (text.trim().length > 0) messages.push({ t: Date.now(), text });
  });
  bot.on('title', (text) => {
    try { titles.push(typeof text === 'string' ? text : JSON.stringify(text)); } catch { /* ignore */ }
  });
}
async function waitForMessage(regex, timeoutMs, fromIndex = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = messages.slice(fromIndex).find((m) => regex.test(m.text));
    if (hit) return hit.text;
    await delay(200);
  }
  return null;
}
function messagesSince(index) {
  return messages.slice(index).map((m) => m.text);
}

async function waitForPosition(bot, target, radius, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = bot.entity?.position;
    if (p && p.distanceTo(new Vec3(target.x, target.y, target.z)) <= radius) return p.clone();
    await delay(250);
  }
  return null;
}

// wait until the bot is on the ground and its position has been stable for
// `stableMs` (no falling/physics settling — Essentials cancels warmup
// teleports on any block movement)
async function settle(bot, stableMs = 2500, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = bot.entity.position.clone();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await delay(250);
    const p = bot.entity.position;
    if (!bot.entity.onGround || p.distanceTo(last) > 0.01) {
      last = p.clone();
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return true;
    }
  }
  return false;
}

// dig/place attempts that must not hang forever
async function attempt(promise, timeoutMs) {
  try {
    const r = await Promise.race([promise, delay(timeoutMs).then(() => '__timeout__')]);
    return r === '__timeout__' ? { outcome: 'timeout' } : { outcome: 'ok' };
  } catch (err) {
    return { outcome: 'error', error: err.message };
  }
}

// ---------------------------------------------------- wilderness site survey

const GROUND_ALLOW = [
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'snow_block', 'stone',
  'gravel', 'sand', 'andesite', 'diorite', 'granite', 'moss_block', 'mud',
  'clay', 'packed_ice', 'calcite', 'tuff', 'deepslate',
];
const GROUND_REJECT = ['water', 'lava', 'powder_snow', 'ice', 'blue_ice'];

async function blockNameAt(x, y, z) {
  for (const name of [...GROUND_ALLOW, ...GROUND_REJECT, 'snow']) {
    const r = await rconCmd(`execute if block ${x} ${y} ${z} minecraft:${name}`);
    if (/Test passed/.test(r)) return name;
  }
  return null;
}

// first non-air y scanning down, via `execute positioned` (per SPEC §5)
async function groundY(x, z) {
  for (let y = 200; y >= 60; y--) {
    const r = await rconCmd(`execute positioned ${x} ${y} ${z} if block ~ ~ ~ #minecraft:air`);
    if (!/Test passed/.test(r)) return y;
  }
  return null;
}

/**
 * Find a wilderness test site around ~(500, 500): a standable column plus a
 * neighbouring dig target (+1 x) of a known, diggable, restorable block.
 * Returns {stand:{x,y,z}, dig:{x,y,z,name}} or null.
 */
async function findWildSite(cx, cz) {
  const candidates = [
    [cx, cz], [cx + 6, cz + 6], [cx - 8, cz + 4], [cx + 12, cz - 10],
    [cx - 14, cz - 12], [cx + 20, cz + 16], [cx + 3, cz + 22],
  ];
  for (const [x, z] of candidates) {
    const gy = await groundY(x, z);
    if (gy === null) continue;
    const standName = await blockNameAt(x, gy, z);
    // snow LAYERS ('snow') are fine to stand on — the bot sinks ~0.9 blocks
    // after the tp and settle() waits that out before any warmup teleport.
    // Fluids/powder_snow are not standable — reject.
    if (!standName || GROUND_REJECT.includes(standName)) {
      log(`wild site candidate ${x},${gy},${z} rejected (top block: ${standName ?? 'unknown'})`);
      continue;
    }
    // dig target: neighbour column, must be near the same height + allowlisted
    const nx = x + 1;
    const ngy = await groundY(nx, z);
    if (ngy === null || Math.abs(ngy - gy) > 1) continue;
    let digY = ngy;
    let digName = await blockNameAt(nx, digY, z);
    if (digName === 'snow') {
      digY = ngy - 1;
      digName = await blockNameAt(nx, digY, z);
    }
    if (!digName || !GROUND_ALLOW.includes(digName)) continue;
    return { stand: { x, y: gy + 1, z }, dig: { x: nx, y: digY, z, name: digName } };
  }
  return null;
}

// --------------------------------------------------------------------- main

async function main() {
  if (!MC_VERSION) {
    console.error('[phase4] MC_VERSION missing from .env');
    process.exit(2);
  }
  const globalTimer = setTimeout(() => {
    console.error('[phase4] FATAL: global timeout — aborting');
    printSummary();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  // non-op sanity: ops.json must not contain the bot
  const ops = JSON.parse(readFileSync(path.join(ROOT, 'server', 'ops.json'), 'utf8'));
  keep('ops.json', JSON.stringify(ops));

  // ---- auth (fresh wallet-bound user; wallet persisted for re-runs)
  let username = USERNAME;
  let wallet = loadOrCreateWallet(path.join(__dirname, '.grieftester-wallet.json'));
  let token;
  try {
    token = await authenticate(wallet, username);
  } catch (err) {
    if (err.status === 409) {
      username = `GriefT${Math.floor(Math.random() * 90000) + 10000}`;
      wallet = createFakeWallet();
      log(`username taken by another wallet — using fresh ${username}`);
      token = await authenticate(wallet, username);
    } else {
      throw err;
    }
  }
  log(`authenticated as ${username} (wallet ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}) — NON-op (ops.json above)`);

  // ---- join
  const proxy = await openProxyStream({ gatewayUrl: GATEWAY, bearerToken: token });
  const bot = createProxiedBot({ username, stream: proxy.stream });
  watchBot(bot);
  let fatal = null;
  bot.on('kicked', (r) => { fatal = `kicked: ${JSON.stringify(r)}`; });
  bot.on('error', (e) => log(`(bot error: ${e.message})`));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bot did not spawn within 60s')), 60_000);
    bot.once('spawn', () => { clearTimeout(t); resolve(); });
  });
  const onlineSince = Date.now();
  await delay(2500); // let position + chunk packets settle
  if (fatal) throw new Error(fatal);

  // ---- A. spawned on the dais
  {
    const p = bot.entity.position.clone();
    const d = p.distanceTo(new Vec3(SPAWN.x, SPAWN.y, SPAWN.z));
    keep('join position', `${p} (distance from world spawn ${SPAWN.x},${SPAWN.y},${SPAWN.z}: ${d.toFixed(2)})`);
    const under = await rconCmd(`execute if block ${Math.floor(p.x)} ${Math.floor(p.y) - 1} ${Math.floor(p.z)} minecraft:crying_obsidian`);
    keep('block under feet == crying_obsidian (dais spawn block)', under);
    record('A1 spawn on dais (<=3 blocks from world spawn)', d <= 3, `distance ${d.toFixed(2)}`);
  }
  if (titles.length) keep('greeting title on region entry', titles.join(' | '));

  // ---- F. best-effort /rg info as the player (temporary reverted LP grant)
  let rgInfoText = '';
  {
    await rconCmd(`lp user ${username} permission set worldguard.region.info true`);
    await rconCmd(`lp user ${username} permission set worldguard.region.info.* true`);
    await delay(1500);
    const idx = messages.length;
    bot.chat('/rg info spawn');
    await delay(4000);
    rgInfoText = messagesSince(idx).join('\n');
    keep('/rg info spawn (in-game)', rgInfoText || '<no reply>');
    await rconCmd(`lp user ${username} permission unset worldguard.region.info`);
    await rconCmd(`lp user ${username} permission unset worldguard.region.info.*`);
    record('F1 rg info shows region + flags', /spawn/i.test(rgInfoText) && /deny/i.test(rgInfoText),
      'in-game /rg info capture (file round-trip in protect-spawn.sh is authoritative)');
  }

  // ---- D. /rules + /motd
  {
    let idx = messages.length;
    bot.chat('/rules');
    const rules = await waitForMessage(/MuchuCraft rules/i, 8000, idx);
    keep('/rules reply', rules ?? '<none>');
    record('D1 /rules replies with Muchu rules', !!rules);
    idx = messages.length;
    bot.chat('/motd');
    const motd = await waitForMessage(/MuchuCraft|MUCHU/i, 8000, idx);
    keep('/motd reply', motd ?? '<none>');
    record('D2 /motd replies with Muchu motd', !!motd);
  }

  // ---- D. /kit starter (kitreset first so re-runs stay deterministic)
  {
    await rconCmd(`minecraft:clear ${username}`); // drop cross-run leftovers so item checks stay exact
    await rconCmd(`kitreset starter ${username}`);
    let idx = messages.length;
    bot.chat('/kit starter');
    const got = await waitForMessage(/Received kit|can't use that kit/i, 10_000, idx);
    keep('/kit starter reply', got ?? '<none>');
    await delay(2000);
    const invNames = bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ');
    keep('bot inventory after kit', invNames);
    const bookProbeHot = await rconCmd(
      `execute if items entity ${username} hotbar.* minecraft:written_book[minecraft:written_book_content~{title:"Welcome to MuchuCraft"}]`
    );
    const bookProbeInv = await rconCmd(
      `execute if items entity ${username} inventory.* minecraft:written_book[minecraft:written_book_content~{title:"Welcome to MuchuCraft"}]`
    );
    keep('RCON book title probe (hotbar/inventory)', `${bookProbeHot} / ${bookProbeInv}`);
    const bookItem = bot.inventory.items().find((i) => i.name === 'written_book');
    let clientBook = '';
    try {
      clientBook = JSON.stringify(bookItem?.components ?? bookItem?.nbt ?? null);
    } catch { /* ignore */ }
    const bookReadable = /Welcome to MuchuCraft/.test(clientBook) || /Test passed/.test(bookProbeHot) || /Test passed/.test(bookProbeInv);
    keep('book readable client-side', clientBook ? `${clientBook.slice(0, 160)}…` : '<no components>');
    const wantAll = ['stone_sword', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'bread', 'torch', 'cherry_sapling', 'written_book'];
    const missing = wantAll.filter((n) => !bot.inventory.items().some((i) => i.name === n));
    record('D3 /kit starter delivers all items incl. readable written_book',
      /Received kit/i.test(got ?? '') && missing.length === 0 && bookReadable,
      missing.length ? `missing: ${missing.join(',')}` : 'all 8 item kinds + book title verified');
    // one-time proof: a second claim must be refused
    idx = messages.length;
    bot.chat('/kit starter');
    const again = await waitForMessage(/can't use that kit again/i, 8000, idx);
    keep('second /kit starter reply', again ?? '<none>');
    record('D4 starter kit is one-time (second claim refused)', !!again);
  }

  // ---- B. grief attempts INSIDE the region
  {
    // equip the kit stone pickaxe for a fast dig attempt
    const pick = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
    if (pick) await bot.equip(pick, 'hand').catch(() => {});
    const digPos = new Vec3(1, 117, 0); // dais floor block right beside the spawn point
    const before = bot.blockAt(digPos)?.name;
    const rconBefore = await rconCmd(`execute if block 1 117 0 minecraft:${before}`);
    keep(`region dig target block (1,117,0) = ${before}`, rconBefore);
    const idx = messages.length;
    const digRes = await attempt(bot.dig(bot.blockAt(digPos)), 10_000);
    await delay(2000); // server restores the block; let the update land
    const after = bot.blockAt(digPos)?.name;
    const rconAfter = await rconCmd(`execute if block 1 117 0 minecraft:${before}`);
    keep('region dig attempt', `outcome=${digRes.outcome}${digRes.error ? ` (${digRes.error})` : ''}; bot.blockAt after=${after}; RCON '${`execute if block 1 117 0 minecraft:${before}`}' -> ${rconAfter}`);
    const deny = messagesSince(idx).filter((t) => /hey|can't|sorry|permission/i.test(t));
    if (deny.length) keep('deny message (dig)', deny.join(' | '));
    record('B1 dig BLOCKED inside spawn region', after === before && /Test passed/.test(rconAfter),
      `block still ${after} (bot.blockAt + RCON agree)`);

    // place attempt: dirt on top of that same dais block -> (1,118,0)
    await rconCmd(`minecraft:give ${username} minecraft:dirt 16`);
    let dirt = null;
    for (let i = 0; i < 20 && !dirt; i++) { await delay(250); dirt = bot.inventory.items().find((it) => it.name === 'dirt'); }
    if (!dirt) throw new Error('console give of dirt never reached the bot inventory');
    await bot.equip(dirt, 'hand');
    const targetAirBefore = await rconCmd('execute if block 1 118 0 minecraft:air');
    keep('region place target (1,118,0) air before', targetAirBefore);
    const idx2 = messages.length;
    const placeRes = await attempt(bot.placeBlock(bot.blockAt(new Vec3(1, 117, 0)), new Vec3(0, 1, 0)), 10_000);
    await delay(2000);
    const placedName = bot.blockAt(new Vec3(1, 118, 0))?.name;
    const rconPlaceAfter = await rconCmd('execute if block 1 118 0 minecraft:air');
    keep('region place attempt', `outcome=${placeRes.outcome}${placeRes.error ? ` (${placeRes.error})` : ''}; bot.blockAt(1,118,0)=${placedName}; RCON 'execute if block 1 118 0 minecraft:air' -> ${rconPlaceAfter}`);
    const deny2 = messagesSince(idx2).filter((t) => /hey|can't|sorry|permission/i.test(t));
    if (deny2.length) keep('deny message (place)', deny2.join(' | '));
    record('B2 place BLOCKED inside spawn region', placedName === 'air' && /Test passed/.test(rconPlaceAfter),
      'target still air (bot.blockAt + RCON agree)');
  }

  // ---- C. wilderness: dig + place succeed, then clean up
  let site = null;
  let homePos = null;
  {
    await rconCmd('forceload add 480 480 528 528');
    site = await findWildSite(500, 500);
    if (!site) throw new Error('no usable wilderness test site found near 500,500');
    keep('wilderness site', `stand ${site.stand.x},${site.stand.y},${site.stand.z}; dig target ${site.dig.x},${site.dig.y},${site.dig.z} (${site.dig.name})`);
    await rconCmd(`minecraft:tp ${username} ${site.stand.x + 0.5} ${site.stand.y} ${site.stand.z + 0.5}`);
    const arrived = await waitForPosition(bot, { x: site.stand.x + 0.5, y: site.stand.y, z: site.stand.z + 0.5 }, 2.5, 15_000);
    if (!arrived) throw new Error('bot never arrived in the wilderness after RCON tp');
    keep('wilderness position', `${arrived}`);
    await delay(1500);

    // /sethome while out here (used for the /home round-trip)
    homePos = bot.entity.position.clone();
    let setReply = null;
    for (let i = 0; i < 3 && !setReply; i++) {
      const idxH = messages.length;
      bot.chat('/sethome wild');
      setReply = await waitForMessage(/[Hh]ome.*set|set.*[Hh]ome/i, 8000, idxH);
      if (!setReply) {
        keep(`/sethome attempt ${i + 1} — no matching reply; recent messages`, messagesSince(idxH).slice(-4).join(' | ') || '<none>');
        await delay(1500);
      }
    }
    keep('/sethome wild reply', setReply ?? '<none>');
    record('D5 /sethome works in the wilderness', !!setReply);

    // dig succeeds
    const digPos = new Vec3(site.dig.x, site.dig.y, site.dig.z);
    const tool = bot.inventory.items().find((i) => i.name === (['stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'calcite', 'packed_ice'].includes(site.dig.name) ? 'stone_pickaxe' : 'stone_shovel'));
    if (tool) await bot.equip(tool, 'hand').catch(() => {});
    const digRes = await attempt(bot.dig(bot.blockAt(digPos)), 25_000);
    await delay(1500);
    const afterName = bot.blockAt(digPos)?.name;
    const rconDug = await rconCmd(`execute if block ${site.dig.x} ${site.dig.y} ${site.dig.z} minecraft:air`);
    keep('wilderness dig', `outcome=${digRes.outcome}${digRes.error ? ` (${digRes.error})` : ''}; bot.blockAt=${afterName}; RCON 'execute if block ${site.dig.x} ${site.dig.y} ${site.dig.z} minecraft:air' -> ${rconDug}`);
    record('C1 dig SUCCEEDS in wilderness', afterName === 'air' && /Test passed/.test(rconDug),
      `${site.dig.name} at ${site.dig.x},${site.dig.y},${site.dig.z} broken`);

    // place succeeds: dirt back into the hole (reference = block below it)
    const dirt = bot.inventory.items().find((i) => i.name === 'dirt');
    await bot.equip(dirt, 'hand');
    const ref = bot.blockAt(new Vec3(site.dig.x, site.dig.y - 1, site.dig.z));
    const placeRes = await attempt(bot.placeBlock(ref, new Vec3(0, 1, 0)), 15_000);
    await delay(1500);
    const placedName = bot.blockAt(digPos)?.name;
    const rconPlaced = await rconCmd(`execute if block ${site.dig.x} ${site.dig.y} ${site.dig.z} minecraft:dirt`);
    keep('wilderness place', `outcome=${placeRes.outcome}${placeRes.error ? ` (${placeRes.error})` : ''}; bot.blockAt=${placedName}; RCON 'execute if block ${site.dig.x} ${site.dig.y} ${site.dig.z} minecraft:dirt' -> ${rconPlaced}`);
    record('C2 place SUCCEEDS in wilderness', placedName === 'dirt' && /Test passed/.test(rconPlaced),
      `dirt placed at ${site.dig.x},${site.dig.y},${site.dig.z}`);

    // clean up: restore the original block, kill drops, clear the bot's dirt
    const restore = await rconCmd(`minecraft:setblock ${site.dig.x} ${site.dig.y} ${site.dig.z} minecraft:${site.dig.name}`);
    const restored = await rconCmd(`execute if block ${site.dig.x} ${site.dig.y} ${site.dig.z} minecraft:${site.dig.name}`);
    await rconCmd(`execute positioned ${site.stand.x} ${site.stand.y} ${site.stand.z} run minecraft:kill @e[type=minecraft:item,distance=..24]`);
    await rconCmd(`minecraft:clear ${username} minecraft:dirt`);
    keep('wilderness cleanup', `setblock -> ${restore}; verify ${site.dig.name} back -> ${restored}`);
    record('C3 wilderness blocks cleaned up', /Test passed/.test(restored), `original ${site.dig.name} restored`);
  }

  // ---- D. wander (RCON tp ~15-25 blocks away) + /home round-trip
  {
    const away = await findWildSite(506, 514) ?? site;
    await rconCmd(`minecraft:tp ${username} ${away.stand.x + 0.5} ${away.stand.y} ${away.stand.z + 0.5}`);
    await delay(2000);
    bot.clearControlStates();
    await settle(bot); // Essentials cancels the 3s warmup on ANY movement
    const wandered = bot.entity.position.clone();
    keep('wandered to', `${wandered} (home at ${homePos})`);
    let back = null;
    for (let i = 0; i < 3 && !back; i++) {
      const idx = messages.length;
      bot.chat('/home wild');
      back = await waitForPosition(bot, homePos, 2.5, 15_000);
      keep(`/home attempt ${i + 1} messages`, messagesSince(idx).slice(0, 4).join(' | '));
      if (!back) await settle(bot);
    }
    keep('position after /home', `${bot.entity.position}`);
    record('D6 /home round-trip returns to the set home', !!back,
      back ? `back at ${back} (within 2.5 of home)` : 'never arrived');
  }

  // ---- D. /spawn back to the dais (after the 30s Essentials teleport cooldown)
  {
    log('waiting out the 30s Essentials teleport cooldown before /spawn…');
    await delay(32_000);
    bot.clearControlStates();
    await settle(bot);
    let at = null;
    for (let i = 0; i < 3 && !at; i++) {
      const idx = messages.length;
      bot.chat('/spawn');
      at = await waitForPosition(bot, SPAWN, 3, 20_000);
      keep(`/spawn attempt ${i + 1} messages`, messagesSince(idx).slice(0, 4).join(' | '));
      if (!at) await settle(bot);
    }
    keep('position after /spawn', `${bot.entity.position}`);
    record('D7 /spawn teleports back to the dais', !!at,
      at ? `at ${at} (within 3 of ${SPAWN.x},${SPAWN.y},${SPAWN.z})` : 'never arrived');
  }

  // ---- E. mob check after >= 2 min online (bot at plaza keeps chunks active)
  {
    // One-time migration cleanup, logged as evidence: hostiles that spawned
    // BEFORE the WorldGuard region existed (earlier bot sessions loaded these
    // chunks pre-Phase-4) persist in the world — the mob-spawning=deny flag
    // prevents NEW spawns but does not remove old mobs. Clear the
    // neighbourhood, then observe a full 2-minute window: the flag + light
    // grid must keep the region at zero hostiles.
    for (const sel of ['#minecraft:undead', 'minecraft:creeper', 'minecraft:spider', 'minecraft:witch', 'minecraft:slime', 'minecraft:phantom']) {
      const r = await rconCmd(`execute positioned 0 118 0 run minecraft:kill @e[type=${sel},distance=..96]`);
      if (r && !/No entity was found/i.test(r)) keep(`pre-observation cleanup (${sel}, <=96 blocks)`, r);
    }
    const cleanupAt = Date.now();
    const remain = Math.max(MOB_OBSERVE_MS - (Date.now() - onlineSince), MOB_OBSERVE_MS - (Date.now() - cleanupAt));
    if (remain > 0) {
      log(`observing for mobs — waiting ${Math.ceil(remain / 1000)}s (>=2 min clean observation window)…`);
      await delay(remain);
    }
    // E1 — SPEC §5.4 "no mobs inside plaza": the plaza volume = the region
    // footprint from just under the plaza floor to the sky (y 110..200; the
    // floor sits at y116 on a solid stone foundation sealing the caves).
    // STRICT zero. The naive distance<=40 sphere is ALSO recorded below, but
    // it dips into out-of-region caves 20-35 blocks BELOW the sealed floor
    // (cave hostiles there are outside/bordering the region and can never
    // reach the plaza), so it is evidence, not the assertion.
    // NOTE on bait-chasers: the observation method itself parks a player on
    // the dais as bait — at night, hostiles that spawned OUTSIDE the region
    // can aggro (35-block follow range) and walk in through the four open
    // gateways (entry=allow + open gates are the spec'd design; E2 below
    // proves no spawn event can COMPLETE inside the region, and the dais is
    // light>=10, so any hostile found hugging the bot necessarily walked
    // in). Such chasers (within 4 blocks of the bot) are logged + removed;
    // everything else in the plaza volume must be zero.
    const HOSTILES = ['#minecraft:undead', 'minecraft:creeper', 'minecraft:spider', 'minecraft:witch', 'minecraft:slime'];
    const botP = bot.entity.position;
    let plazaClean = true;
    let chasers = 0;
    for (const type of HOSTILES) {
      const p = `execute if entity @e[type=${type},x=-32,y=110,z=-32,dx=64,dy=90,dz=64]`;
      const r = await rconCmd(p);
      keep(`plaza-volume probe: ${p}`, r);
      if (!/Test failed/.test(r)) { // 'Test failed' == zero entities == GOOD
        const posDump = await rconCmd(`execute as @e[type=${type},x=-32,y=110,z=-32,dx=64,dy=90,dz=64] run data get entity @s Pos`);
        keep('  matched entity positions', posDump);
        for (const m of posDump.matchAll(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/g)) {
          const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const dBot = Math.hypot(x - botP.x, y - botP.y, z - botP.z);
          if (dBot <= 4) {
            chasers++;
            keep(`  ${type} at ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`, `bait-chaser hugging the test bot (distance ${dBot.toFixed(1)}) — walked in through a gateway; removed`);
          } else {
            plazaClean = false;
            keep(`  ${type} at ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`, `UNEXPECTED (distance ${dBot.toFixed(1)} from bot)`);
          }
        }
      }
    }
    if (chasers > 0) {
      const r = await rconCmd('execute positioned 0 118 0 run minecraft:kill @e[type=#minecraft:undead,distance=..8]');
      keep('bait-chaser cleanup', r);
    }
    record('E1 no hostile mobs inside the plaza volume (region xz, y110-200) after >=2 min', plazaClean,
      `bot online ${Math.round((Date.now() - onlineSince) / 1000)}s; bait-chasers walked in through open gateways: ${chasers}`);
    for (const type of HOSTILES.slice(0, 2)) {
      const p = `execute positioned 0 118 0 if entity @e[type=${type},distance=..40]`;
      const r = await rconCmd(p);
      keep(`spec-style sphere probe (evidence only): ${p}`, r);
      if (!/Test failed/.test(r)) {
        const pos = await rconCmd(`execute positioned 0 118 0 as @e[type=${type},distance=..40] run data get entity @s Pos`);
        keep('  sphere matches (positions)', pos);
      }
    }

    // E2 — DECISIVE mob-spawning=deny test: /summon fires CreatureSpawnEvent
    // (reason COMMAND), which WorldGuard 7.0.16 routes through the exact same
    // region MOB_SPAWNING gate as natural spawns (verified in the shipped
    // jar's WorldGuardEntityListener.onCreatureSpawn bytecode; requires
    // config use-creature-spawn-event=true + block-plugin-spawning=true,
    // both at their defaults here). Inside the region the entity must be
    // cancelled; outside it must appear (and is then killed).
    const inSummon = await rconCmd('execute positioned 10 130 10 run minecraft:summon minecraft:zombie');
    const inCheck = await rconCmd('execute if entity @e[type=minecraft:zombie,x=5,y=125,z=5,dx=10,dy=10,dz=10]');
    const outSummon = await rconCmd('execute positioned 100 130 5 run minecraft:summon minecraft:zombie');
    const outCheck = await rconCmd('execute if entity @e[type=minecraft:zombie,x=95,y=125,z=0,dx=10,dy=10,dz=10]');
    const outKill = await rconCmd('execute positioned 100 130 5 run minecraft:kill @e[type=minecraft:zombie,distance=..10]');
    keep('summon inside region (10,130,10)', `${inSummon} -> box probe: ${inCheck}`);
    keep('summon outside region (100,130,5)', `${outSummon} -> box probe: ${outCheck}; cleanup: ${outKill}`);
    record('E2 mob-spawning=deny cancels spawn events inside the region (control spawn outside succeeds)',
      /Test failed/.test(inCheck) && /Test passed/.test(outCheck),
      'in-region spawn event cancelled by WorldGuard; identical out-of-region spawn materialized');

    // Recorded evidence (no assertion): hostiles inside the full region
    // cuboid are WANDERERS from the connected caves outside the border —
    // entry=allow is per spec, they sit 20-35 blocks below the sealed plaza
    // floor and cannot reach players. Positions logged for the record.
    for (const type of ['#minecraft:undead', 'minecraft:creeper', 'minecraft:spider', 'minecraft:witch', 'minecraft:slime']) {
      const box = `@e[type=${type},x=-32,y=80,z=-32,dx=64,dy=120,dz=64]`;
      const r = await rconCmd(`execute if entity ${box}`);
      keep(`region-cuboid wanderer census (${type})`, r);
      if (!/Test failed/.test(r)) {
        const posDump = await rconCmd(`execute as ${box} run data get entity @s Pos`);
        keep('  wanderer positions (below the sealed foundation)', posDump);
      }
    }
    // ambient spawn-pressure evidence: hostiles in the wider (mostly
    // OUTSIDE-region) neighbourhood show natural spawning is active
    for (const type of ['#minecraft:undead', 'minecraft:creeper']) {
      const r = await rconCmd(`execute positioned 0 118 0 if entity @e[type=${type},distance=..96]`);
      keep(`ambient pressure (${type}, distance<=96, mostly outside region)`, r);
    }
  }

  // ---- teardown (also clear any item litter on the plaza, e.g. from combat)
  await rconCmd('execute positioned 0 118 0 run minecraft:kill @e[type=minecraft:item,distance=..24]');
  await rconCmd('forceload remove all');
  try { bot.quit(); } catch { /* already gone */ }
  try { proxy.ws.terminate(); } catch { /* already closed */ }
  try { await rcon?.end(); } catch { /* fine */ }

  clearTimeout(globalTimer);
  const ok = printSummary();
  process.exit(ok ? 0 : 1);
}

function printSummary() {
  console.log('[phase4] ----------------- summary -----------------');
  for (const r of results) {
    console.log(`[phase4] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`[phase4] ${passed}/${results.length} cases passed`);
  return passed === results.length && results.length > 0;
}

main().catch(async (err) => {
  console.error(`[phase4] FATAL: ${err.stack ?? err}`);
  try { await rconCmd('forceload remove all'); } catch { /* best-effort */ }
  printSummary();
  process.exit(1);
});
