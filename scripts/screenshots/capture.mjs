#!/usr/bin/env node
// capture.mjs — capture real README screenshots for MuchuCraft with headless
// Chromium. Each shot is independent: a failure is reported, not fatal.
//
//   1. site-hero.png     — marketing site top-of-page (muchu.png hero loaded)
//   2. launcher.png      — /login/ with an injected fake Wallet Standard wallet
//   3. multiplayer.png   — game client server-select screen w/ MuchuCraft promo
//   4. spawn-plaza.png   — real in-game 3D at spawn (session minted via API)
//   5. wallet-card.png   — /login/ with active session + MUCHU wallet card
//
// Usage: node capture.mjs [shot ...]   (no args = all five)
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
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const RCON_HELPER = path.join(ROOT, 'scripts', 'rcon-cmd.mjs');
const WALLET_FILE = path.join(__dirname, '.screenshot-wallet.json');

const BASE = process.env.SCREENSHOT_BASE ?? 'https://web.muchu.app';
const USERNAME = 'ScreenshotBot';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };
const MAX_BYTES = 600 * 1024;
const WORLD_RENDER_TIMEOUT_MS = 180_000;

// GL flag variants, best-first. The probe (webgl-probe.mjs) showed the default
// already yields SwiftShader-backed WebGL2 on this Chromium, but keep the
// fallbacks in case a future Chromium blocks software GL by default.
const GL_VARIANTS = [
  { name: 'default', args: [] },
  { name: 'unsafe-swiftshader', args: ['--enable-unsafe-swiftshader'] },
  {
    name: 'angle-swiftshader',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
];
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--hide-scrollbars',
  '--window-size=1440,900',
  '--lang=en-US',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = []; // {shot, ok, detail, bytes}

/* ------------------------------------------------------------------ wallet */

function walletFromKeyPair(keyPair) {
  return {
    address: bs58.encode(keyPair.publicKey),
    signMessage(message) {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : Uint8Array.from(message);
      return nacl.sign.detached(bytes, keyPair.secretKey);
    },
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

/* ------------------------------------------------------------------- utils */

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

/** nonce -> sign -> verify, exactly like e2e/run-e2e.js. */
async function authenticate(wallet, username) {
  const nonceRes = await postJson('/api/auth/nonce', { username, address: wallet.address });
  if (nonceRes.status !== 200) {
    throw new Error(`nonce -> HTTP ${nonceRes.status} ${JSON.stringify(nonceRes.json)}`);
  }
  const { message, nonce } = nonceRes.json ?? {};
  const signature = Array.from(wallet.signMessage(message));
  const verifyRes = await postJson('/api/auth/verify', { nonce, address: wallet.address, signature });
  if (verifyRes.status !== 200) {
    throw new Error(`verify -> HTTP ${verifyRes.status} ${JSON.stringify(verifyRes.json)}`);
  }
  const { token, playUrl, username: confirmed } = verifyRes.json ?? {};
  if (typeof token !== 'string' || typeof playUrl !== 'string') {
    throw new Error(`verify response missing token/playUrl`);
  }
  return { token, playUrl, username: confirmed ?? username };
}

function rcon(...commands) {
  try {
    const out = execFileSync(process.execPath, [RCON_HELPER, ...commands], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    console.log(out.trim());
    return out;
  } catch (err) {
    console.warn(`[rcon] failed: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/** Poll an in-page predicate. Returns true when it holds within timeoutMs. */
async function waitFor(page, fn, { timeoutMs = 30_000, intervalMs = 500, arg } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(fn, arg)) return true;
    } catch { /* navigation race etc. */ }
    await sleep(intervalMs);
  }
  return false;
}

/** Hide the client's corner FPS/stats counters (cosmetic only, best-effort). */
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
    // stats.js-style panels are tiny canvases inside a fixed container.
    for (const canvas of document.querySelectorAll('canvas')) {
      if (canvas.width <= 120 && canvas.height <= 80) hideOverlayAncestor(canvas);
    }
    // text-based FPS counters
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 2 || el.tagName === 'CANVAS') continue;
      const text = (el.textContent || '').trim();
      if (/^\d+\s*FPS/i.test(text) && text.length < 30) hideOverlayAncestor(el);
    }
  }).catch(() => {});
}

/** Luminance stats over a fractional region of a PNG buffer (world liveness). */
function pngStats(buffer, region = { x0: 0.15, x1: 0.85, y0: 0.15, y1: 0.85 }) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const x0 = Math.floor(width * region.x0);
  const x1 = Math.floor(width * region.x1);
  const y0 = Math.floor(height * region.y0);
  const y1 = Math.floor(height * region.y1);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const i = (width * y + x) << 2;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { mean, std };
}

/** Write + optimize a PNG into docs/screenshots, staying under MAX_BYTES. */
async function savePng(name, buffer) {
  const outPath = path.join(OUT_DIR, name);
  let best = buffer;
  // Always try a lossless-ish recompress first, then palette quantization
  // (sharp bundles libimagequant) until we are under budget.
  const attempts = [
    { compressionLevel: 9, effort: 10 },
    { palette: true, quality: 90, compressionLevel: 9, effort: 10 },
    { palette: true, quality: 75, compressionLevel: 9, effort: 10 },
    { palette: true, quality: 55, compressionLevel: 9, effort: 10 },
  ];
  for (const opts of attempts) {
    try {
      const candidate = await sharp(buffer).png(opts).toBuffer();
      if (candidate.length < best.length) best = candidate;
      if (best.length <= MAX_BYTES && opts.palette) break;
      if (best.length <= MAX_BYTES && !opts.palette && buffer.length <= MAX_BYTES) break;
    } catch { /* keep best so far */ }
    if (best.length <= MAX_BYTES) break;
  }
  fs.writeFileSync(outPath, best);
  return { outPath, bytes: best.length };
}

/* ------------------------------------------- fake Wallet Standard injection */

/**
 * Install a fake Wallet Standard wallet into `page` BEFORE any page script
 * runs. Signing is delegated to Node (tweetnacl) via an exposed binding, so
 * signatures verify against the gateway exactly like e2e/fakewallet.js.
 */
async function installFakeWallet(page, wallet) {
  await page.exposeFunction('__screenshotWalletSign', async (bytes) =>
    Array.from(wallet.signMessage(Uint8Array.from(bytes))));
  await page.evaluateOnNewDocument((address) => {
    const account = {
      address,
      publicKey: new Uint8Array(32), // display-only; gateway uses `address`
      chains: ['solana:devnet'],
      features: ['standard:connect', 'solana:signMessage'],
      label: 'Screenshot account',
    };
    const fakeWallet = {
      version: '1.0.0',
      name: 'Phantom-like Test Wallet',
      icon: null,
      chains: ['solana:devnet'],
      accounts: [account],
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => ({ accounts: [account] }),
        },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...inputs) => {
            const outs = [];
            for (const input of inputs) {
              const bytes = Array.from(input.message ?? []);
              const signature = await window.__screenshotWalletSign(bytes);
              outs.push({
                signedMessage: Uint8Array.from(bytes),
                signature: Uint8Array.from(signature),
              });
            }
            return outs;
          },
        },
      },
    };
    const register = (api) => {
      try { api && typeof api.register === 'function' && api.register(fakeWallet); } catch { /* ignore */ }
    };
    window.addEventListener('wallet-standard:app-ready', (ev) => register(ev.detail));
    // Also announce ourselves for apps that are already listening.
    try {
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    } catch { /* ignore */ }
  }, wallet.address);
}

/* -------------------------------------------------------------------- shots */

async function newPage(browser, { clearStorage = false, seedStorage = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.setDefaultTimeout(60_000);
  if (clearStorage || seedStorage) {
    await page.evaluateOnNewDocument((seed) => {
      try {
        localStorage.clear();
        if (seed) for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
      } catch { /* ignore */ }
    }, seedStorage);
  }
  return page;
}

async function shotSiteHero(browser) {
  const page = await newPage(browser);
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 90_000 });
    const heroLoaded = await waitFor(page, () => {
      const img = document.querySelector('img.hero-img');
      return !!img && img.complete && img.naturalWidth > 0;
    }, { timeoutMs: 30_000 });
    await sleep(1500); // fonts / fade-ins
    const buf = await page.screenshot({ type: 'png' });
    const { bytes } = await savePng('site-hero.png', buf);
    report.push({ shot: 'site-hero.png', ok: true, bytes, detail: `hero img loaded=${heroLoaded}` });
  } finally {
    await page.close().catch(() => {});
  }
}

async function shotLauncher(browser, wallet) {
  const page = await newPage(browser, { clearStorage: true });
  try {
    await installFakeWallet(page, wallet);
    await page.goto(`${BASE}/login/`, { waitUntil: 'networkidle2', timeout: 90_000 });

    const walletListed = await waitFor(page, () => {
      const btn = document.querySelector('#wallet-list .wallet-btn');
      return !!btn && btn.getBoundingClientRect().width > 0;
    }, { timeoutMs: 20_000 });
    if (!walletListed) throw new Error('fake wallet never appeared in #wallet-list');

    // Click through to the username step (nicest state).
    let detail = 'wallet listed';
    await page.evaluate(() => document.querySelector('#wallet-list .wallet-btn').click());
    const usernameView = await waitFor(page, () => {
      const view = document.getElementById('view-username');
      return !!view && !view.classList.contains('hidden');
    }, { timeoutMs: 10_000 });

    if (usernameView) {
      detail = 'username step, connected wallet shown';
      for (const candidate of [USERNAME, 'MuchuMiner', 'PlazaBuilder']) {
        await page.evaluate(() => {
          const input = document.getElementById('username');
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.type('#username', candidate, { delay: 50 });
        const good = await waitFor(page, () => {
          const el = document.getElementById('username-status');
          return !!el && el.className.includes('status-good');
        }, { timeoutMs: 8_000 });
        if (good) {
          detail = `username step, "${candidate}" availability confirmed`;
          break;
        }
      }
      await sleep(500);
    }

    const buf = await page.screenshot({ type: 'png' });
    const { bytes } = await savePng('launcher.png', buf);
    report.push({ shot: 'launcher.png', ok: true, bytes, detail });
  } finally {
    await page.close().catch(() => {});
  }
}

async function shotMultiplayer(browser) {
  const page = await newPage(browser);
  try {
    await page.goto(`${BASE}/?play=1`, { waitUntil: 'networkidle2', timeout: 120_000 });
    const menuReady = await waitFor(page, () => {
      const el = document.querySelector('[data-test-id="servers-screen-button"]');
      return !!el && el.getBoundingClientRect().width > 0;
    }, { timeoutMs: 90_000, intervalMs: 1000 });
    if (!menuReady) throw new Error('main menu (servers-screen-button) never appeared');
    await sleep(2000);
    await page.evaluate(() => document.querySelector('[data-test-id="servers-screen-button"]').click());

    const listed = await waitFor(page, () => document.body.innerText.includes('MuchuCraft'), {
      timeoutMs: 30_000, intervalMs: 1000,
    });
    if (!listed) throw new Error('server list did not show a MuchuCraft entry');
    await sleep(2000); // server icon/status render
    await hideFpsOverlay(page);
    const buf = await page.screenshot({ type: 'png' });
    const { bytes } = await savePng('multiplayer.png', buf);
    report.push({ shot: 'multiplayer.png', ok: true, bytes, detail: 'server list with MuchuCraft promo entry' });
  } finally {
    await page.close().catch(() => {});
  }
}

/** Hide the "Click to capture mouse" pointer-lock hint (cosmetic). */
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

// Ground (bottom-of-frame) region: textured blocks give high variance there,
// while a sky/void-only frame stays smooth. Guards against sky-only shots.
const GROUND_REGION = { x0: 0.1, x1: 0.9, y0: 0.5, y1: 0.92 };
const groundLively = (stats) => stats.mean > 15 && stats.std > 26;

async function shotSpawnPlaza(browser, session) {
  // Daylight + clear weather so the plaza reads well.
  // minecraft: namespace bypasses Essentials' console-only /weather signature.
  rcon('time set noon', 'minecraft:weather clear 1000000');
  const page = await newPage(browser);
  try {
    const playUrl = new URL(session.playUrl, BASE).href;
    await page.goto(playUrl, { waitUntil: 'networkidle2', timeout: 120_000 }).catch(() => {});

    // Phase 1: the client connects and the local player entity exists.
    const spawned = await waitFor(page, () => {
      const bot = globalThis.bot;
      return !!(bot && bot.entity && bot.entity.position);
    }, { timeoutMs: 120_000, intervalMs: 2000 });

    // Phase 2: the chunk-streaming indicator ("Loading world chunks n%") is gone.
    const chunksLoaded = await waitFor(
      page,
      () => !/Loading world chunks/i.test(document.body.innerText),
      { timeoutMs: WORLD_RENDER_TIMEOUT_MS, intervalMs: 2000 },
    );
    await sleep(8000); // let chunk meshes actually upload/render

    // Aim slightly downward so the plaza floor fills the frame (spawn yaw/pitch
    // is 0/0 — dead-level). mineflayer pitch: negative = down.
    await page.evaluate(() => {
      try {
        const bot = globalThis.bot;
        if (bot && bot.entity && typeof bot.look === 'function') {
          bot.look(bot.entity.yaw, -0.3, true);
        }
      } catch { /* view nudge is best-effort */ }
    });
    await sleep(2000);

    // Phase 3: the canvas shows actual world geometry (textured ground region).
    const deadline = Date.now() + WORLD_RENDER_TIMEOUT_MS;
    let stats = { mean: 0, std: 0 };
    let buf = null;
    let firstLively = 0;
    while (Date.now() < deadline) {
      await hideFpsOverlay(page);
      await hidePointerHint(page);
      buf = await page.screenshot({ type: 'png' });
      stats = pngStats(buf, GROUND_REGION);
      if (groundLively(stats)) {
        if (!firstLively) firstLively = Date.now();
        // hold for ~12s after first liveliness so chunks/entities stream in
        if (Date.now() - firstLively > 12_000) break;
      }
      await sleep(4000);
    }
    if (!groundLively(stats)) {
      throw new Error(
        `world never rendered (spawned=${spawned}, chunksLoaded=${chunksLoaded}, ground mean=${stats.mean.toFixed(1)}, std=${stats.std.toFixed(1)}) — not shipping a blank/sky-only png`,
      );
    }
    const { bytes } = await savePng('spawn-plaza.png', buf);
    report.push({
      shot: 'spawn-plaza.png',
      ok: true,
      bytes,
      detail: `bot spawned=${spawned}, chunksLoaded=${chunksLoaded}, ground stats mean=${stats.mean.toFixed(1)} std=${stats.std.toFixed(1)}`,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function shotWalletCard(browser, session) {
  // Give ScreenshotBot a real balance so the card shows a non-zero amount.
  rcon(`eco give ${session.username} 42`);
  await sleep(1500);
  const page = await newPage(browser, {
    seedStorage: {
      'muchucraft.token': session.token,
      'muchucraft.username': session.username,
      'muchucraft.playUrl': session.playUrl,
    },
  });
  try {
    await page.goto(`${BASE}/login/`, { waitUntil: 'networkidle2', timeout: 90_000 });
    const sessionView = await waitFor(page, () => {
      const view = document.getElementById('view-session');
      return !!view && !view.classList.contains('hidden');
    }, { timeoutMs: 30_000 });
    if (!sessionView) throw new Error('session view never appeared (token rejected?)');

    const cardShown = await waitFor(page, () => {
      const card = document.getElementById('wallet-card');
      const balance = document.getElementById('wallet-balance');
      return !!card && !card.classList.contains('hidden')
        && !!balance && /MUCHU/.test(balance.textContent || '');
    }, { timeoutMs: 30_000 });
    if (!cardShown) throw new Error('MUCHU wallet card never became visible');
    const balanceText = await page.evaluate(() => document.getElementById('wallet-balance').textContent);
    await sleep(1000);
    // Frame the card: scroll so the whole balance/withdraw/deposit card is
    // visible (it sits below the fold of the session view).
    await page.evaluate(() => {
      const card = document.getElementById('wallet-card');
      const rect = card.getBoundingClientRect();
      const target = window.scrollY + rect.top - Math.max(24, (window.innerHeight - rect.height) / 2);
      window.scrollTo({ top: Math.max(0, target), behavior: 'instant' });
    });
    await sleep(600);
    const buf = await page.screenshot({ type: 'png' });
    const { bytes } = await savePng('wallet-card.png', buf);
    report.push({ shot: 'wallet-card.png', ok: true, bytes, detail: `balance shown: ${balanceText}` });
  } finally {
    await page.close().catch(() => {});
  }
}

/* --------------------------------------------------------------------- main */

async function launchBrowser(variant) {
  return puppeteer.launch({ headless: true, args: [...BASE_ARGS, ...variant.args] });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const want = (name) => only.size === 0 || only.has(name);
  const wallet = loadOrCreateWallet();

  // Pick a GL variant that gives a working WebGL context.
  let browser = null;
  let glVariant = null;
  for (const variant of GL_VARIANTS) {
    try {
      browser = await launchBrowser(variant);
      const probe = await browser.newPage();
      const ok = await probe.evaluate(() => {
        const canvas = document.createElement('canvas');
        return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
      });
      await probe.close();
      if (ok) { glVariant = variant.name; break; }
      await browser.close();
      browser = null;
    } catch (err) {
      console.warn(`[gl] variant ${variant.name} failed: ${err.message.split('\n')[0]}`);
      await browser?.close().catch(() => {});
      browser = null;
    }
  }
  if (!browser) throw new Error('no launch variant produced a WebGL-capable browser');
  console.log(`[gl] using variant: ${glVariant}`);

  const shots = [
    ['site-hero.png', () => shotSiteHero(browser)],
    ['launcher.png', () => shotLauncher(browser, wallet)],
    ['multiplayer.png', () => shotMultiplayer(browser)],
  ];
  for (const [name, fn] of shots) {
    if (!want(name)) continue;
    try {
      await fn();
    } catch (err) {
      report.push({ shot: name, ok: false, detail: err.message });
    }
  }

  // Session-backed shots (4 & 5) share one authenticated ScreenshotBot session.
  if (want('spawn-plaza.png') || want('wallet-card.png')) {
    let session = null;
    try {
      session = await authenticate(wallet, USERNAME);
      console.log(`[auth] session minted for ${session.username}`);
    } catch (err) {
      const msg = `auth failed: ${err.message}`;
      if (want('spawn-plaza.png')) report.push({ shot: 'spawn-plaza.png', ok: false, detail: msg });
      if (want('wallet-card.png')) report.push({ shot: 'wallet-card.png', ok: false, detail: msg });
    }
    if (session) {
      if (want('spawn-plaza.png')) {
        try {
          await shotSpawnPlaza(browser, session);
        } catch (err) {
          report.push({ shot: 'spawn-plaza.png', ok: false, detail: err.message });
        }
      }
      if (want('wallet-card.png')) {
        try {
          await shotWalletCard(browser, session);
        } catch (err) {
          report.push({ shot: 'wallet-card.png', ok: false, detail: err.message });
        }
      }
    }
  }

  await browser.close().catch(() => {});

  console.log('\n=== capture report ===');
  for (const r of report) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.shot}${r.bytes ? ` (${(r.bytes / 1024).toFixed(0)} KB)` : ''} — ${r.detail}`);
  }
  process.exit(report.every((r) => r.ok) && report.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err}`);
  process.exit(1);
});
