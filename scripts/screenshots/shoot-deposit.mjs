import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const resp = await page.goto('https://web.muchu.app/deposit/', { waitUntil: 'networkidle0', timeout: 60000 });
  console.log('status:', resp.status());
  await page.waitForFunction(() => {
    const el = document.getElementById('deposit-address');
    return el && el.textContent && el.textContent.length > 20;
  }, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1000));

  const info = await page.evaluate(() => {
    const qr = document.getElementById('qr');
    const svg = qr ? qr.querySelector('svg') : null;
    const canvas = qr ? qr.querySelector('canvas') : null;
    const img = qr ? qr.querySelector('img') : null;
    const r = qr ? qr.getBoundingClientRect() : null;
    return {
      depositAddress: document.getElementById('deposit-address')?.textContent,
      mintAddress: document.getElementById('mint-address')?.textContent,
      copyButtons: [...document.querySelectorAll('button.btn-copy')].map(b => ({ id: b.id, text: b.textContent.trim(), visible: b.offsetParent !== null })),
      qrChild: svg ? 'svg' : canvas ? 'canvas' : img ? 'img' : 'NONE',
      qrRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      min: document.getElementById('deposit-min')?.textContent,
      gate: document.getElementById('gate-threshold')?.textContent,
      badge: document.getElementById('cluster-badge')?.textContent,
      uri: document.getElementById('qr-uri-link')?.href,
      title: document.title,
      // design-law probes: any computed gradient backgrounds?
      gradients: [...document.querySelectorAll('*')].filter(el => {
        const bi = getComputedStyle(el).backgroundImage;
        return bi && bi.includes('gradient');
      }).map(el => el.tagName + (el.id ? '#' + el.id : '') + ' ' + getComputedStyle(el).backgroundImage.slice(0, 60)),
      fonts: getComputedStyle(document.body).fontFamily,
    };
  });
  console.log(JSON.stringify(info, null, 2));

  await page.screenshot({ path: '/tmp/deposit-page.png' });

  // Non-blank QR region check on the actual screenshot pixels
  const png = PNG.sync.read(fs.readFileSync('/tmp/deposit-page.png'));
  const { x, y, w, h } = { x: Math.round(info.qrRect.x), y: Math.round(info.qrRect.y), w: Math.round(info.qrRect.w), h: Math.round(info.qrRect.h) };
  let dark = 0, light = 0, total = 0;
  const shades = new Set();
  for (let yy = y; yy < y + h && yy < png.height; yy++) {
    for (let xx = x; xx < x + w && xx < png.width; xx++) {
      const i = (yy * png.width + xx) * 4;
      const lum = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
      shades.add(Math.round(lum / 16));
      if (lum < 80) dark++; else if (lum > 175) light++;
      total++;
    }
  }
  console.log(`QR region ${w}x${h} at (${x},${y}): total=${total} dark=${dark} (${(100*dark/total).toFixed(1)}%) light=${light} (${(100*light/total).toFixed(1)}%) lumBuckets=${shades.size}`);
  const ok = dark / total > 0.1 && light / total > 0.1;
  console.log('QR non-blank check:', ok ? 'PASS' : 'FAIL');
  if (errors.length) console.log('PAGE ERRORS:', errors);
  else console.log('no page/console errors');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
