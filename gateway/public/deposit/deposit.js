/* MuchuCraft deposit page.
 *
 * Data source: GET /api/token/status. Unauthenticated it returns the PUBLIC
 * subset {cluster, mint, deposit: {address, minimum, gateThreshold}} — enough
 * to render the address, QR and limits. If the launcher left a session token
 * in localStorage ('muchucraft.token', same origin), the authed status is
 * fetched too and the page additionally shows the player's own gate progress
 * and bound wallet. QR is generated locally with qrcode.js (qrcode-generator,
 * MIT — copied into this directory, no CDNs).
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = 'muchucraft.token'; // written by the launcher (/login/)
  const DEFAULT_DECIMALS = 6; // MUCHU_DECIMALS; status payloads carry raw units

  // ---------- helpers -------------------------------------------------------

  function readSessionToken() {
    try { return localStorage.getItem(LS_TOKEN); } catch { return null; }
  }

  async function fetchStatus(token) {
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    const res = await fetch('/api/token/status', { headers });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** '12500000' raw → '12.5' (BigInt integer math — never floats). */
  function formatRaw(rawStr, decimals) {
    let raw;
    try { raw = BigInt(rawStr); } catch { return null; }
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole.toString();
  }

  /** '25' / '0.5' whole-MUCHU decimal string → raw BigInt, or null. */
  function toRaw(value, decimals) {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const frac = match[2] || '';
    if (frac.length > decimals) return null;
    const padded = frac.padEnd(decimals, '0');
    return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(padded || '0');
  }

  /** Gate progress in percent (clamped 0–100). */
  function progressPct(cumulativeRawStr, thresholdStr, decimals) {
    try {
      const raw = BigInt(cumulativeRawStr);
      const threshold = toRaw(thresholdStr, decimals);
      if (threshold === null || threshold <= 0n) return 100;
      return Math.max(0, Math.min(100, Number((raw * 100n) / threshold)));
    } catch {
      return 0;
    }
  }

  /** Solana Pay transfer-request URI — wallets that scan it prefill the transfer. */
  function solanaPayUri(address, mint) {
    return 'solana:' + address + '?spl-token=' + mint + '&label=MuchuCraft%20Deposit';
  }

  function renderQr(uri) {
    /* global qrcode */
    const qr = qrcode(0, 'M'); // type 0 = auto-size, medium error correction
    qr.addData(uri);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  function wireCopy(buttonId, getValue) {
    const btn = $(buttonId);
    btn.addEventListener('click', async () => {
      const value = getValue();
      if (!value) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch {
        // clipboard API unavailable (http, permissions) — legacy fallback
        try {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch { ok = false; }
      }
      const original = btn.dataset.original || (btn.dataset.original = btn.textContent);
      btn.textContent = ok ? btn.dataset.copied : 'Copy failed';
      btn.classList.toggle('copied', ok);
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1600);
    });
  }

  function showError(message) {
    const el = $('load-error');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  // ---------- render ---------------------------------------------------------

  function renderPublic(status) {
    const deposit = status.deposit || {};
    const cluster = String(status.cluster || '');
    const mint = String(status.mint || '');

    if (cluster) {
      const badge = $('cluster-badge');
      badge.textContent = cluster;
      badge.classList.remove('hidden');
      if (cluster !== 'mainnet-beta') $('cluster-note').classList.remove('hidden');
    }

    if (!deposit.address) {
      showError('Deposits are warming up — the deposit address is not published yet. Refresh in a minute.');
      return false;
    }

    $('deposit-address').textContent = deposit.address;
    $('mint-address').textContent = mint || '(mint unknown)';
    $('deposit-min').textContent = deposit.minimum || '—';

    const uri = solanaPayUri(deposit.address, mint);
    try {
      renderQr(uri);
    } catch (err) {
      $('qr').textContent = 'QR unavailable';
      console.warn('[deposit] QR render failed:', err);
    }
    $('qr-uri-link').href = uri;

    $('content').classList.remove('hidden');
    return true;
  }

  function renderMine(status) {
    // Show the player's bound wallet (the only address deposits are credited
    // from). Earn-gate progress was removed — everyone earns without depositing.
    if (status && status.boundWallet) {
      $('me-wallet').textContent = status.boundWallet;
      $('me').classList.remove('hidden');
    }
  }

  // ---------- boot -----------------------------------------------------------

  wireCopy('copy-address', () => $('deposit-address').textContent.trim());
  wireCopy('copy-mint', () => $('mint-address').textContent.trim());

  (async () => {
    let publicStatus;
    try {
      publicStatus = await fetchStatus(null);
    } catch (err) {
      showError(err.status === 404
        ? 'The MUCHU token economy is not enabled on this server yet.'
        : 'Could not reach the MuchuCraft gateway — try again shortly.');
      return;
    }
    if (!renderPublic(publicStatus)) return;

    const token = readSessionToken();
    if (!token) return;
    try {
      renderMine(await fetchStatus(token));
    } catch {
      // expired/invalid session — public view is complete on its own
    }
  })();
})();
