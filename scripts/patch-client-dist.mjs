#!/usr/bin/env node
/**
 * scripts/patch-client-dist.mjs <distDir>
 *
 * Injects the MuchuCraft pointer-lock guard into the downloaded web-client
 * bundle. Fixes upstream zardoy/minecraft-web-client#562: while a container
 * GUI (inventory / chest / jobs menu) is open, any click that misses a slot
 * hits the game canvas, which silently re-requests pointer lock — the cursor
 * vanishes and the GUI stops responding ("can't move items"). The guard
 * refuses pointer-lock requests while such a GUI is open, mirroring a normal
 * browser denial (a code path the client already handles).
 *
 * Idempotent: safe to re-run. Called by client/setup.sh and website/build.sh
 * after extracting self-host.zip.
 */
import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2];
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node scripts/patch-client-dist.mjs <client dist dir>');
  process.exit(2);
}

const GUARD = `// MuchuCraft pointer-lock guard — see scripts/patch-client-dist.mjs
(() => {
  'use strict';
  // Only 'mc-inv-overlay*' elements mean a GUI WINDOW is open. The HUD
  // hotbar (always on screen during play) shares the other mc-inv-* classes,
  // so matching those would block pointer lock during normal play.
  const guiOpen = () => [...document.querySelectorAll('[class*="mc-inv-overlay"]')].some(
    (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== 'hidden',
  );
  const orig = Element.prototype.requestPointerLock;
  Element.prototype.requestPointerLock = function (...args) {
    if (guiOpen()) {
      // Refuse exactly like a browser denial; the client handles this path.
      return Promise.reject(
        new DOMException('MuchuCraft: pointer lock suppressed while a GUI is open', 'NotAllowedError'),
      );
    }
    return orig.apply(this, args);
  };
})();
`;

fs.writeFileSync(path.join(dist, 'muchu-guard.js'), GUARD);

const indexPath = path.join(dist, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('muchu-guard.js')) {
  const tag = '<script src="muchu-guard.js"></script>';
  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${tag}`);
  } else {
    html = tag + html;
  }
  fs.writeFileSync(indexPath, html);
  console.log(`[patch-client] guard injected into ${indexPath}`);
} else {
  console.log('[patch-client] already patched — refreshed guard file only');
}
