// One-off marketing hero shoot: clean plaza, no floating text (killed before
// join, restored after by re-running build-spawn.mjs), toasts faded, HUD band
// cropped off in post. Output: website/assets/shots/hero.png
import puppeteer from 'puppeteer';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import sharp from 'sharp';

const BASE = process.env.BASE ?? 'https://web.muchu.app';
const OUT = '/home/ubuntu/cookieclickersol/website/assets/shots/hero.png';

const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);
const username = 'Photographer' + Math.floor(Math.random() * 1000);
const n = await (await fetch(`${BASE}/api/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, address }) })).json();
const sig = nacl.sign.detached(new TextEncoder().encode(n.message), kp.secretKey);
const v = await (await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: n.nonce, address, signature: Array.from(sig) }) })).json();
if (!v.playUrl) { console.error('auth failed', v); process.exit(1); }

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1360 });

let ready = false;
page.on('console', (m) => { if (/All chunks done and ready/.test(m.text())) ready = true; });

await page.goto(`${BASE}${v.playUrl}&setting=crosshair:false`, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 24 && !ready; i++) await new Promise((r) => setTimeout(r, 5000));
if (!ready) { console.error('world never became ready'); await browser.close(); process.exit(1); }

// Photography setup via RCON now that the bot keeps the chunks loaded:
// spectator = no hand/no HUD; kill the floating info texts; frame the shot.
try { process.loadEnvFile('/home/ubuntu/cookieclickersol/.env'); } catch {}
const { createRequire } = await import('node:module');
const req = createRequire('/home/ubuntu/cookieclickersol/gateway/package.json');
const { Rcon } = req('rcon-client');
const r = await Rcon.connect({ host: '127.0.0.1', port: Number(process.env.RCON_PORT || 25575), password: process.env.RCON_PASSWORD });
await r.send(`minecraft:gamemode spectator ${username}`);
console.log('kill:', await r.send('minecraft:kill @e[tag=muchu_spawn]'));
await r.send(`minecraft:tp ${username} 0.5 120.2 13.5 180 6`);
await r.end().catch(() => {});
console.log('world ready — waiting out toasts/messages');
await new Promise((r2) => setTimeout(r2, 12000));

// hide DOM overlays (chat, indicators) — canvas stays
await page.evaluate(() => {
  for (const el of document.querySelectorAll('body > div')) {
    if (!el.querySelector('canvas')) el.style.visibility = 'hidden';
  }
});
await new Promise((r) => setTimeout(r, 500));
const raw = await page.screenshot({ type: 'png' });
await browser.close();

// crop: drop top 120px (toasts) and bottom 240px (hotbar/hearts) => 1920x1000
await sharp(raw).extract({ left: 0, top: 120, width: 1920, height: 1000 }).png({ quality: 90 }).toFile(OUT);
const stats = await sharp(OUT).stats();
const std = stats.channels.reduce((a, c) => a + c.stdev, 0) / stats.channels.length;
console.log(`saved ${OUT} — stddev ${std.toFixed(1)} (blank-guard: must be > 26)`);
if (std < 26) { console.error('image looks blank — refusing'); process.exit(1); }
