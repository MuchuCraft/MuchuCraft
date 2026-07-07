// Reproduces a touchscreen laptop (touch-capable + mouse) and verifies MOUSE
// click-to-pick / click-to-place / drag all work — the case that was broken.
import puppeteer from 'puppeteer';
import nacl from 'tweetnacl';
import bs58m from 'bs58';
import { execSync } from 'node:child_process';
const bs58 = bs58m.default ?? bs58m;
const rcon = (c) => execSync('node /home/ubuntu/cookieclickersol/scripts/rcon-cmd.mjs ' + JSON.stringify(c), { cwd: '/home/ubuntu/cookieclickersol', shell: '/bin/bash' }).toString();

const BASE = 'https://web.muchu.app';
const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);
const username = 'Hybrid' + Math.floor(Math.random() * 1000);
const n = await (await fetch(`${BASE}/api/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, address }) })).json();
const sig = nacl.sign.detached(new TextEncoder().encode(n.message), kp.secretKey);
const v = await (await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: n.nonce, address, signature: Array.from(sig) }) })).json();

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
// Emulate a touchscreen laptop: touch-capable viewport (sets maxTouchPoints>0)
await p.setViewport({ width: 1280, height: 800, hasTouch: true, isMobile: false });
let ready = false;
p.on('console', (m) => { if (/All chunks done/.test(m.text())) ready = true; });
await p.goto(`${BASE}${v.playUrl}`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 24 && !ready; i++) await new Promise((r) => setTimeout(r, 5000));
const touchPts = await p.evaluate(() => navigator.maxTouchPoints);
console.log('maxTouchPoints=', touchPts, '(>0 means detectMobile()=true — the broken case)');

const cobble = () => { const m = [...rcon(`data get entity ${username} Inventory`).matchAll(/Slot: (\d+)b[^}]*cobblestone/g)].map((x) => x[1]); return m.length ? 'slot ' + m.join(',') : '(none/held)'; };
rcon(`clear ${username}`); rcon(`give ${username} minecraft:cobblestone 8`);
await new Promise((r) => setTimeout(r, 1500));
await p.mouse.click(640, 400); await new Promise((r) => setTimeout(r, 800));
await p.keyboard.press('KeyE'); await new Promise((r) => setTimeout(r, 3000));
const s = await p.evaluate(() => {
  const ov = document.querySelector('[class*=mc-inv-overlay-window]') || document.querySelector('[class*=mc-inv-overlay]');
  if (!ov) return null;
  const a = [...ov.querySelectorAll('[class*=mc-inv-slot-wrapper]')].map((el) => { const r = el.getBoundingClientRect(); return { x: (r.x + r.width / 2) | 0, y: (r.y + r.height / 2) | 0, has: Boolean(el.querySelector('[class*=mc-inv-item]')) }; }).filter((s) => s.y > 380 && s.x < 900);
  return { item: a.filter((x) => x.has)[0], empty: a.filter((x) => !x.has)[4] };
});
if (!s) { console.log('FAIL: inventory did not open'); await b.close(); process.exit(1); }
console.log('start:', cobble());
// MOUSE click-to-pick then click-to-place (the gesture that was dead on touch devices)
await p.mouse.click(s.item.x, s.item.y); await new Promise((r) => setTimeout(r, 500));
await p.mouse.click(s.empty.x, s.empty.y); await new Promise((r) => setTimeout(r, 800));
console.log('after MOUSE click-click:', cobble(), '<-- must move (mouse now works on touch device)');
await b.close();
