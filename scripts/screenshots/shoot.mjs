#!/usr/bin/env node
// shoot.mjs — marketing gameplay photography for the MuchuCraft website.
//
// Reuses capture.mjs's session/join/overlay-hiding/ground-variance approach but
// adds a "photographer" workflow: one authenticated ScreenshotBot session, the
// bot's client-side physics disabled (bot.physicsEnabled=false) so RCON
// `minecraft:tp <name> x y z yaw pitch` places a rock-steady free camera, HUD
// hidden via the client's own F1 state (window.miscUiState.showUI=false), and
// per-shot world conditions (time of day / weather) driven over RCON.
//
// Usage:
//   node shoot.mjs                       # all built-in shots -> website/assets/shots
//   node shoot.mjs hero-plaza night      # subset of built-in shots
//   node shoot.mjs --plan plan.json --out /tmp/shots   # scouting probes
//
// plan.json: [{ "file": "probe-1.png", "time": 13000, "x":13.5, "y":121.5,
//   "z":13.5, "yaw":135, "pitch":8, "hand":false, "holdMs":4000 }, ...]
//
// Frames are gated on the ground-variance check (no blank/sky-only frames are
// shipped) and compressed to < 500 KB with sharp.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RCON_HELPER = path.join(ROOT, 'scripts', 'rcon-cmd.mjs');
const WALLET_FILE = path.join(__dirname, '.screenshot-wallet.json');

const BASE = process.env.SCREENSHOT_BASE ?? 'https://web.muchu.app';
const USERNAME = 'ScreenshotBot';
const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1 };
const MAX_BYTES = 500 * 1024;
const JOIN_TIMEOUT_MS = 240_000;

/* ------------------------------------------------------------ built-in shots
 * World facts (docs/SPAWN.md): plaza disc r~20 centered (0,116,0), walk level
 * y117, dais + spawn (0,118,0), torii gates N/E/S/W on the r~20 ring, mountain
 * rises to ~y130 on N/W, ravine + quartz balcony/oak bridge east (x~21-27,z~0),
 * cherry-grove village south (~y110). Wilds scouted via RCON `locate biome`:
 * jagged_peaks ~(760,-408) (summit ~y214), cherry_grove ~(472,-664).
 * MC yaw: 0=south(+z) 90=west(-x) 180=north(-z) -90=east(+x); pitch +down.
 */
const SHOTS = {
  'hero-plaza.png': {
    time: 13000, // golden dusk
    x: 14.5, y: 121.5, z: 14.5, yaw: 137, pitch: 10,
    hand: false,
    detail: 'Amethyst Compass at golden hour, SE rim looking NW across dais to torii + mountain',
  },
  'village.png': {
    time: 6000, // noon
    x: 24.5, y: 120.5, z: 1.5, yaw: -35, pitch: 14,
    hand: false,
    detail: 'cherry-grove village & ravine from the east balcony, noon',
  },
  'night.png': {
    time: 18000, // midnight-ish
    x: -13.5, y: 119.5, z: -8.0, yaw: -110, pitch: 8,
    hand: false, night: true,
    detail: 'plaza at night: lanterns, froglights, amethyst glow',
  },
  'wilds.png': {
    time: 6000,
    x: 850.5, y: 155, z: -330.5, yaw: 118, pitch: 6,
    hand: false,
    detail: 'untouched jagged-peaks vista ~900 blocks out',
  },
  'gate-pov.png': {
    time: 6000,
    x: 15.5, y: 117, z: 0.5, yaw: -90, pitch: 4,
    hand: true,
    detail: 'first-person inside the east torii looking out over balcony/ravine/bridge',
  },
};

/* ----------------------------------------------------------------- plumbing */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];

function walletFromKeyPair(keyPair) {
  return {
    address: bs58.encode(keyPair.publicKey),
    signMessage: (message) => nacl.sign.detached(
      typeof message === 'string' ? new TextEncoder().encode(message) : Uint8Array.from(message),
      keyPair.secretKey,
    ),
  };
}

function loadOrCreateWallet() {
  try {
    const saved = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    return walletFromKeyPair(nacl.sign.keyPair.fromSecretKey(Uint8Array.from(saved.secretKey)));
  } catch {
    const keyPair = nacl.sign.keyPair();
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ secretKey: Array.from(keyPair.secretKey) }), { mode: 0o600 });
    return walletFromKeyPair(keyPair);
  }
}

async function postJson(pathname, payload) {
  const res = await fetch(new URL(pathname, BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function authenticate(wallet, username) {
  const nonceRes = await postJson('/api/auth/nonce', { username, address: wallet.address });
  if (nonceRes.status !== 200) throw new Error(`nonce -> HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
  const { message, nonce } = nonceRes.json ?? {};
  const signature = Array.from(wallet.signMessage(message));
  const verifyRes = await postJson('/api/auth/verify', { nonce, address: wallet.address, signature });
  if (verifyRes.status !== 200) throw new Error(`verify -> HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  const { token, playUrl, username: confirmed } = verifyRes.json ?? {};
  if (typeof token !== 'string' || typeof playUrl !== 'string') throw new Error('verify response missing token/playUrl');
  return { token, playUrl, username: confirmed ?? username };
}

function rcon(...commands) {
  try {
    const out = execFileSync(process.execPath, [RCON_HELPER, ...commands], { encoding: 'utf8', timeout: 20_000 });
    console.log(out.trim());
    return out;
  } catch (err) {
    console.warn(`[rcon] failed: ${err.message.split('\n')[0]}`);
    return null;
  }
}

async function waitFor(page, fn, { timeoutMs = 30_000, intervalMs = 500, arg } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.evaluate(fn, arg)) return true; } catch { /* nav race */ }
    await sleep(intervalMs);
  }
  return false;
}

/** stats.js panels + text FPS counters (same heuristic as capture.mjs). */
async function hideFpsOverlay(page) {
  await page.evaluate(() => {
    const hideOverlayAncestor = (el) => {
      let node = el;
      for (let i = 0; i < 4 && node.parentElement; i++) {
        const cs = getComputedStyle(node);
        if (cs.position === 'fixed' || cs.position === 'absolute') break;
        node = node.parentElement;
      }
      node.style.display = 'none';
    };
    for (const canvas of document.querySelectorAll('canvas')) {
      if (canvas.width <= 120 && canvas.height <= 80) hideOverlayAncestor(canvas);
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 2 || el.tagName === 'CANVAS') continue;
      const text = (el.textContent || '').trim();
      if (/^\d+\s*FPS/i.test(text) && text.length < 30) hideOverlayAncestor(el);
    }
  }).catch(() => {});
}

async function hidePointerHint(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 3 || el.tagName === 'CANVAS') continue;
      if (/capture mouse/i.test(el.textContent || '')) {
        let node = el;
        for (let i = 0; i < 4 && node.parentElement; i++) {
          const cs = getComputedStyle(node);
          if (cs.position === 'fixed' || cs.position === 'absolute') break;
          node = node.parentElement;
        }
        node.style.display = 'none';
      }
    }
  }).catch(() => {});
}

/** Hide toast notifications ("Processing GUI textures", autosave, ...) that
 * live outside the F1/showUI-gated HUD tree. */
async function hideToasts(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.tagName === 'CANVAS' || el.children.length > 4) continue;
      const text = (el.textContent || '').trim();
      if (text.length === 0 || text.length > 80) continue;
      if (/processing gui textures|world saved|saving|connected to|joined the game/i.test(text)) {
        let node = el;
        for (let i = 0; i < 6 && node.parentElement; i++) {
          const cs = getComputedStyle(node);
          if (cs.position === 'fixed' || cs.position === 'absolute') break;
          node = node.parentElement;
        }
        node.style.display = 'none';
      }
    }
  }).catch(() => {});
}

/** Hide ALL of the client's HUD via its own F1 state + belt-and-braces DOM. */
async function setUiHidden(page, hidden) {
  await page.evaluate((h) => {
    try { if (window.miscUiState) window.miscUiState.showUI = !h; } catch { /* ignore */ }
  }, hidden).catch(() => {});
  if (hidden) {
    await hideFpsOverlay(page);
    await hidePointerHint(page);
    await hideToasts(page);
  }
}

async function setShowHand(page, show) {
  await page.evaluate((s) => {
    try { if (window.options) window.options.showHand = s; } catch { /* ignore */ }
  }, show).catch(() => {});
}

/* Ground-variance gate (capture.mjs pattern): textured world in the lower part
 * of the frame => high stddev; blank/sky-only => smooth. Night shots are darker
 * so they get relaxed thresholds (the lantern/froglight glow still gives
 * plenty of local contrast, verified by eye on every shipped frame).
 *
 * rowStd (mean stddev WITHIN each sampled row) guards against fog/sky
 * gradients: a vertical gradient has huge global std but near-zero intra-row
 * variance, while textured blocks vary strongly along every row. */
const GROUND_REGION = { x0: 0.1, x1: 0.9, y0: 0.5, y1: 0.92 };
const lively = (stats, night) => (night
  ? stats.mean > 4 && stats.std > 10 && stats.rowStd > 8
  : stats.mean > 15 && stats.std > 26 && stats.rowStd > 18);

function pngStats(buffer, region = GROUND_REGION) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const x0 = Math.floor(width * region.x0);
  const x1 = Math.floor(width * region.x1);
  const y0 = Math.floor(height * region.y0);
  const y1 = Math.floor(height * region.y1);
  let sum = 0; let sumSq = 0; let n = 0;
  let rowStdSum = 0; let rows = 0;
  for (let y = y0; y < y1; y += 4) {
    let rSum = 0; let rSumSq = 0; let rN = 0;
    for (let x = x0; x < x1; x += 4) {
      const i = (width * y + x) << 2;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum; sumSq += lum * lum; n++;
      rSum += lum; rSumSq += lum * lum; rN++;
    }
    const rMean = rSum / rN;
    rowStdSum += Math.sqrt(Math.max(0, rSumSq / rN - rMean * rMean));
    rows++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { mean, std, rowStd: rowStdSum / rows };
}

async function savePng(outDir, name, buffer) {
  const outPath = path.join(outDir, name);
  let best = buffer;
  const attempts = [
    { compressionLevel: 9, effort: 10 },
    { palette: true, quality: 95, compressionLevel: 9, effort: 10 },
    { palette: true, quality: 85, compressionLevel: 9, effort: 10 },
    { palette: true, quality: 70, compressionLevel: 9, effort: 10 },
    { palette: true, quality: 55, compressionLevel: 9, effort: 10 },
  ];
  for (const opts of attempts) {
    if (best.length <= MAX_BYTES) break;
    try {
      const candidate = await sharp(buffer).png(opts).toBuffer();
      if (candidate.length < best.length) best = candidate;
    } catch { /* keep best */ }
  }
  fs.writeFileSync(outPath, best);
  return { outPath, bytes: best.length };
}

/* ---------------------------------------------------------------- the shoot */

async function joinWorld(browser, session, renderDistance) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.setDefaultTimeout(90_000);
  const playUrl = new URL(session.playUrl, BASE);
  // ?setting=<name>:<json> — the shipped client applies these as settings
  // overrides (verified in dist/static/js/index.e3d79375.js).
  playUrl.searchParams.append('setting', `renderDistance:${renderDistance}`);
  await page.goto(playUrl.href, { waitUntil: 'networkidle2', timeout: 120_000 }).catch(() => {});

  const spawned = await waitFor(page, () => {
    const bot = globalThis.bot;
    return !!(bot && bot.entity && bot.entity.position);
  }, { timeoutMs: JOIN_TIMEOUT_MS, intervalMs: 2000 });
  if (!spawned) throw new Error('bot never spawned (no globalThis.bot.entity)');

  // The account rejoins wherever it last stood (possibly a remote shoot spot
  // where nothing ever meshes) — pull it to the plaza before waiting for the
  // world to render.
  rcon(`minecraft:tp ${USERNAME} 0.5 118 0.5 0 0`);

  const chunksLoaded = await waitFor(
    page,
    () => !/Loading world chunks/i.test(document.body.innerText),
    { timeoutMs: JOIN_TIMEOUT_MS, intervalMs: 2000 },
  );

  // The overlay disappearing is NOT the same as meshes being on screen —
  // demand a genuinely textured frame before any shot is attempted.
  const renderDeadline = Date.now() + JOIN_TIMEOUT_MS;
  let joinStats = { mean: 0, std: 0, rowStd: 0 };
  while (Date.now() < renderDeadline) {
    const buf = await page.screenshot({ type: 'png' });
    joinStats = pngStats(buf);
    if (lively(joinStats, false)) break;
    await sleep(4000);
  }
  console.log(`[join] spawned=true chunkOverlayGone=${chunksLoaded} rendered=${lively(joinStats, false)} (mean=${joinStats.mean.toFixed(1)} std=${joinStats.std.toFixed(1)} rowStd=${joinStats.rowStd.toFixed(1)})`);
  if (!lively(joinStats, false)) throw new Error('world never rendered after join (fog/blank only)');

  // Freeze client-side physics: the camera then sits EXACTLY where RCON tp
  // puts the player (no falling, no drift) — free camera placement.
  await page.evaluate(() => { try { globalThis.bot.physicsEnabled = false; } catch { /* ignore */ } });
  await setUiHidden(page, true);
  return page;
}

let currentGm = null;

async function takeFrame(page, frame, outDir) {
  const {
    file, time, x, y, z, yaw = 0, pitch = 0,
    hand = false, night = false, holdMs = 6000, settleTimeoutMs = 120_000,
    // spectator: no block-hover outline (cursorBlockDisplay skips it) and no
    // floating-kick; creative only for shots that want the first-person arm.
    gm = hand ? 'creative' : 'spectator',
  } = frame;
  if (gm !== currentGm) {
    rcon(`minecraft:gamemode ${gm} ${USERNAME}`);
    currentGm = gm;
  }
  if (time != null) rcon(`minecraft:time set ${time}`);
  rcon(`minecraft:tp ${USERNAME} ${x} ${y} ${z} ${yaw} ${pitch}`);
  await setShowHand(page, hand);
  await sleep(holdMs); // chunk stream + mesh upload after the move

  const deadline = Date.now() + settleTimeoutMs;
  let buf = null;
  let stats = { mean: 0, std: 0 };
  let streak = 0; // consecutive lively samples with a settled mean
  let prevMean = null;
  let stable = false;
  while (Date.now() < deadline) {
    await setUiHidden(page, true);
    await setShowHand(page, hand);
    buf = await page.screenshot({ type: 'png' });
    stats = pngStats(buf);
    const isLively = lively(stats, night);
    console.log(`[frame ${file}] mean=${stats.mean.toFixed(1)} std=${stats.std.toFixed(1)} rowStd=${stats.rowStd.toFixed(1)} lively=${isLively}`);
    streak = isLively && prevMean !== null && Math.abs(stats.mean - prevMean) < 1.5 ? streak + 1 : 0;
    if (streak >= 2) { stable = true; break; } // 3 lively samples in a row, mean settled
    prevMean = isLively ? stats.mean : null;
    await sleep(4000);
  }
  if (!lively(stats, night)) {
    throw new Error(`ground-variance gate failed (mean=${stats.mean.toFixed(1)}, std=${stats.std.toFixed(1)}, rowStd=${stats.rowStd.toFixed(1)}) — not shipping a blank/fog-only frame`);
  }
  const { bytes, outPath } = await savePng(outDir, file, buf);
  report.push({ shot: file, ok: true, bytes, detail: `stable=${stable} mean=${stats.mean.toFixed(1)} std=${stats.std.toFixed(1)}` });
  console.log(`[saved] ${outPath} (${(bytes / 1024).toFixed(0)} KB)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const planFile = getFlag('--plan');
  const outDir = getFlag('--out') ?? path.join(ROOT, 'website', 'assets', 'shots');
  const renderDistance = Number(getFlag('--rd') ?? 7);
  fs.mkdirSync(outDir, { recursive: true });

  let frames;
  if (planFile) {
    frames = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  } else {
    const only = new Set(argv.map((a) => (a.endsWith('.png') ? a : `${a}.png`)));
    frames = Object.entries(SHOTS)
      .filter(([name]) => only.size === 0 || only.has(name))
      .map(([name, s]) => ({ file: name, ...s }));
  }
  if (frames.length === 0) throw new Error('nothing to shoot');

  const wallet = loadOrCreateWallet();
  const session = await authenticate(wallet, USERNAME);
  console.log(`[auth] session minted for ${session.username}`);

  // Stage the world: clear skies, daylight, frozen clock (advance_time is the
  // 1.21.11 registry-style name for doDaylightCycle).
  rcon('minecraft:weather clear 1000000', 'minecraft:time set 6000', 'minecraft:gamerule advance_time false');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, '--lang=en-US',
      '--enable-unsafe-swiftshader',
    ],
  });

  let page = null;
  try {
    page = await joinWorld(browser, session, renderDistance);
    rcon(
      // Creative immediately: exempt from Paper's "floating too long" kick —
      // with client physics frozen the camera hovers, which reads as flying.
      // Individual frames switch spectator/creative as needed (takeFrame).
      `minecraft:gamemode creative ${USERNAME}`,
      `minecraft:effect give ${USERNAME} minecraft:resistance infinite 4 true`,
      `minecraft:clear ${USERNAME}`, // empty hand — no kit pickaxe photobombing
    );
    currentGm = 'creative';
    for (const frame of frames) {
      try {
        await takeFrame(page, frame, outDir);
      } catch (err) {
        report.push({ shot: frame.file, ok: false, detail: err.message });
      }
    }
  } finally {
    // Clean exit: park the bot at spawn, drop effects, restore gamemode +
    // clock, close the bot session.
    rcon(
      `minecraft:tp ${USERNAME} 0.5 118 0.5 0 0`,
      `minecraft:effect clear ${USERNAME}`,
      `minecraft:gamemode survival ${USERNAME}`,
      'minecraft:gamerule advance_time true',
      'time set noon',
      'minecraft:weather clear 1000000',
    );
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log('\n=== shoot report ===');
  for (const r of report) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.shot}${r.bytes ? ` (${(r.bytes / 1024).toFixed(0)} KB)` : ''} — ${r.detail}`);
  }
  process.exit(report.every((r) => r.ok) && report.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err}`);
  // last-ditch world restore
  rcon('minecraft:gamerule advance_time true', 'time set noon');
  process.exit(1);
});
