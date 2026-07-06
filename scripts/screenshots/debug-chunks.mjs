// Debug probe: load the game client, capture console/errors/failed requests,
// report crossOriginIsolated + chunk progress. Usage: node debug-chunks.mjs
import puppeteer from 'puppeteer';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const BASE = process.env.BASE ?? 'https://web.muchu.app';

// mint a session
const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);
const username = 'ChunkDebug' + Math.floor(Math.random() * 10000);
const n = await (await fetch(`${BASE}/api/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, address }) })).json();
const sig = nacl.sign.detached(new TextEncoder().encode(n.message), kp.secretKey);
const v = await (await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: n.nonce, address, signature: Array.from(sig) }) })).json();
if (!v.playUrl) { console.error('auth failed', v); process.exit(1); }
console.log('[probe] session for', username);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const seen = new Set();
page.on('console', (m) => {
  const t = `${m.type()}: ${m.text()}`.slice(0, 300);
  if (!seen.has(t) && (m.type() === 'error' || m.type() === 'warning' || /error|fail|worker|wasm|chunk|SharedArray/i.test(t))) {
    seen.add(t); console.log('[console]', t);
  }
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 140), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http', r.status() + ']', r.url().slice(0, 140)); });

await page.goto(`${BASE}${v.playUrl}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

for (let i = 1; i <= 6; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const state = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('div,span')].map((e) => e.textContent).filter((t) => t && /chunk|loading|kick|error|disconnect/i.test(t)).slice(0, 4);
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sab: typeof SharedArrayBuffer !== 'undefined',
      workers: performance.getEntriesByType('resource').filter((r) => /worker/i.test(r.name)).map((r) => r.name.split('/').pop()).slice(0, 6),
      overlay: texts,
    };
  }).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  console.log(`[probe t+${i * 15}s]`, JSON.stringify(state));
}
await page.screenshot({ path: '/tmp/chunk-debug.png' });
await browser.close();
console.log('[probe] screenshot at /tmp/chunk-debug.png');
