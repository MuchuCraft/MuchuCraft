/* MuchuCraft withdraw page (reached from the in-game /withdraw command).
 *
 * Requires a session token left by the launcher ('muchucraft.token', same
 * origin). Shows the in-game balance, accepts an amount (capped at N% of the
 * vault, surfaced by GET /api/token/status), and POSTs /api/token/withdraw,
 * which always pays the session's BOUND wallet. Then polls
 * /api/token/withdrawals until the new row confirms/fails, with a cluster-aware
 * explorer link. Vanilla JS, no build, no CDNs. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = 'muchucraft.token';
  const DEFAULT_DECIMALS = 6;

  const token = (() => { try { return localStorage.getItem(LS_TOKEN); } catch { return null; } })();
  let decimals = DEFAULT_DECIMALS;
  let cluster = 'devnet';
  let balanceRaw = 0n;
  let capRaw = null;          // N% of vault, computed from status if available
  let polling = false;

  function authHeaders(extra) { return { authorization: 'Bearer ' + token, ...(extra || {}) }; }

  function toRaw(str) {
    if (!/^\d+(\.\d+)?$/.test(str.trim())) throw new Error('Enter a valid amount');
    const [w, f = ''] = str.trim().split('.');
    if (f.length > decimals) throw new Error(`At most ${decimals} decimal places`);
    return BigInt(w + f.padEnd(decimals, '0'));
  }
  function fmtRaw(raw) {
    raw = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    let frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  }
  const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '—'));
  const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}` + (cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster.replace('-beta', ''))}`);

  function setStatus(msg, kind) {
    const box = $('status-box');
    box.className = 'status-box' + (kind ? ' status-' + kind : '');
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  async function loadStatus() {
    const res = await fetch('/api/token/status', { headers: authHeaders() });
    if (res.status === 401) { $('need-login').classList.remove('hidden'); return null; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function applyStatus(s) {
    cluster = s.cluster || cluster;
    if (typeof s.decimals === 'number') decimals = s.decimals;
    if (cluster !== 'mainnet-beta') $('cluster-note').classList.remove('hidden');
    if (s.cluster) { const b = $('cluster-badge'); b.textContent = cluster.replace('-beta', ''); b.classList.remove('hidden'); }
    $('bound-wallet').textContent = short(s.address);
    // balance may be a decimal string ('12.5') from the bridge
    try { balanceRaw = toRaw(String(s.balance ?? '0')); } catch { balanceRaw = 0n; }
    $('balance').textContent = fmtRaw(balanceRaw) + ' MUCHU';
    const pct = s.caps && s.caps.maxPctOfVault;
    const min = s.caps && s.caps.min ? s.caps.min : '1';
    if (pct) $('limits').textContent = `Minimum ${min} MUCHU · up to ${pct}% of the vault per withdrawal`;
    else $('limits').textContent = `Minimum ${min} MUCHU`;
    if (!s.withdrawable && s.reason) setStatus('Withdrawals paused: ' + s.reason, 'bad');
    validate();
  }

  function validate() {
    const btn = $('withdraw-btn');
    let raw;
    try { raw = toRaw($('amount').value || '0'); } catch { btn.disabled = true; return; }
    btn.disabled = raw <= 0n || raw > balanceRaw || polling;
  }

  async function refreshRecent() {
    try {
      const res = await fetch('/api/token/withdrawals', { headers: authHeaders() });
      if (!res.ok) return [];
      const rows = await res.json();
      const list = Array.isArray(rows) ? rows : (rows.withdrawals || rows.items || []);
      const ul = $('recent');
      ul.innerHTML = '';
      if (!list.length) { ul.innerHTML = '<li class="muted small">None yet.</li>'; return list; }
      for (const w of list.slice(0, 6)) {
        const li = document.createElement('li');
        const amt = fmtRaw(w.amountRaw ?? (w.amount ? toRaw(String(w.amount)) : 0n));
        li.innerHTML = `${amt} MUCHU · <span class="state-${w.state}">${w.state}</span>`;
        if (w.signature) {
          const a = document.createElement('a');
          a.href = explorerTx(w.signature); a.target = '_blank'; a.rel = 'noopener';
          a.textContent = ' view ↗';
          li.appendChild(a);
        }
        ul.appendChild(li);
      }
      return list;
    } catch { return []; }
  }

  async function submit() {
    let raw;
    try { raw = toRaw($('amount').value); } catch (e) { setStatus(e.message, 'bad'); return; }
    if (raw <= 0n) { setStatus('Enter an amount greater than zero', 'bad'); return; }
    if (raw > balanceRaw) { setStatus('That is more than your in-game balance', 'bad'); return; }
    polling = true; validate();
    setStatus('Submitting withdrawal…', null);
    let res, body;
    try {
      res = await fetch('/api/token/withdraw', {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ amount: $('amount').value.trim() }),
      });
      body = await res.json().catch(() => ({}));
    } catch { setStatus('Network error — try again shortly', 'bad'); polling = false; validate(); return; }
    if (res.status !== 202) {
      setStatus(body.error || `Withdrawal rejected (HTTP ${res.status})`, 'bad');
      polling = false; validate(); return;
    }
    const id = body.withdrawalId ?? body.id;
    setStatus('Withdrawal queued — sending on-chain…', null);
    // poll for the row to reach a terminal state
    const started = Date.now();
    const tick = async () => {
      const rows = await refreshRecent();
      const row = rows.find((w) => (w.id === id));
      if (row && ['confirmed', 'failed', 'refunded'].includes(row.state)) {
        polling = false; validate();
        if (row.state === 'confirmed') {
          setStatus('Sent! ' + fmtRaw(row.amountRaw ?? raw) + ' MUCHU is on the way to your wallet.', 'ok');
        } else {
          setStatus('Withdrawal ' + row.state + (row.error ? ': ' + row.error : '') + '. Your balance was not deducted.', 'bad');
        }
        await loadStatus().then((s) => s && applyStatus(s)).catch(() => {});
        return;
      }
      if (Date.now() - started > 120000) { polling = false; validate(); setStatus('Still processing — check "Recent withdrawals" shortly.', null); return; }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 2000);
  }

  async function init() {
    if (!token) { $('need-login').classList.remove('hidden'); return; }
    try {
      const s = await loadStatus();
      if (!s) return;
      $('content').classList.remove('hidden');
      applyStatus(s);
      await refreshRecent();
    } catch (e) {
      $('load-error').textContent = 'Could not load your wallet status. Reload to try again.';
      $('load-error').classList.remove('hidden');
    }
    $('amount').addEventListener('input', validate);
    $('max-btn').addEventListener('click', () => { $('amount').value = fmtRaw(balanceRaw); validate(); });
    $('withdraw-btn').addEventListener('click', submit);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
