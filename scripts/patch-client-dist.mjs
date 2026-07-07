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

  // ---- Inventory hint ------------------------------------------------------
  // The client uses vanilla item handling: LEFT-CLICK a slot to lift the
  // stack onto the cursor, LEFT-CLICK a destination to drop it (there is no
  // press-and-hold drag). Web players instinctively try to drag, so show a
  // one-line hint whenever an inventory/container window is open.
  let hintEl = null;
  const ensureHint = () => {
    if (hintEl) return hintEl;
    hintEl = document.createElement('div');
    hintEl.textContent = 'Click an item to pick it up, then click a slot to place it';
    Object.assign(hintEl.style, {
      position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
      zIndex: '2147483647', pointerEvents: 'none', font: '13px system-ui, sans-serif',
      color: '#efece6', background: 'rgba(11,11,13,0.82)', border: '1px solid #b7a4ea',
      borderRadius: '6px', padding: '6px 12px', whiteSpace: 'nowrap',
    });
    document.body.appendChild(hintEl);
    return hintEl;
  };
  setInterval(() => {
    const el = ensureHint();
    el.style.display = guiOpen() ? 'block' : 'none';
  }, 400);
})();

// ---- Fresh-code guarantee --------------------------------------------------
// The client registers a service worker that can keep serving a stale cached
// build to returning players even after a hard refresh. Purge it so everyone
// runs the current code; reload once if we actually removed a stale worker.
(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then((regs) => {
    if (!regs.length) return;
    let removed = false;
    Promise.all(regs.map((r) => r.unregister().then((ok) => { removed = removed || ok; })))
      .then(() => (self.caches ? caches.keys() : []))
      .then((keys) => Promise.all((keys || []).map((k) => caches.delete(k))))
      .then(() => {
        // One-shot reload (guarded by a session flag) so the fresh, un-SW'd
        // assets load — never loops.
        if (removed && !sessionStorage.getItem('muchu-sw-purged')) {
          sessionStorage.setItem('muchu-sw-purged', '1');
          location.reload();
        }
      })
      .catch(() => {});
  }).catch(() => {});
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
