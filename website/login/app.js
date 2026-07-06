/* MuchuCraft launcher — vanilla JS, no build step, no external dependencies.
 * Flow: discover wallets -> connect -> pick username (live availability) ->
 * POST /api/auth/nonce -> sign exact message -> POST /api/auth/verify ->
 * store session -> redirect to playUrl. Stored sessions resume via
 * GET /api/auth/session without re-signing. */
(() => {
  'use strict';

  /* ---------------------------------------------------------------- *
   * Constants & tiny helpers                                          *
   * ---------------------------------------------------------------- */

  const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
  const LS = {
    token: 'muchucraft.token',
    username: 'muchucraft.username',
    playUrl: 'muchucraft.playUrl',
  };

  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
  }
  function lsClear() {
    try { for (const key of Object.values(LS)) localStorage.removeItem(key); } catch { /* ignore */ }
  }

  const VIEWS = ['view-loading', 'view-session', 'view-wallets', 'view-username'];
  function showView(id) {
    for (const v of VIEWS) (v === id ? show : hide)($(v));
  }

  function setBanner(text, kind) {
    const banner = $('banner');
    if (!text) {
      banner.textContent = '';
      banner.className = 'banner hidden';
      return;
    }
    banner.textContent = text;
    banner.className = `banner banner-${kind || 'info'}`;
  }

  function shortAddress(addr) {
    return addr && addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : (addr || '');
  }

  function isUserRejection(err) {
    if (!err) return false;
    if (err.code === 4001) return true;
    const msg = String((err && err.message) || err).toLowerCase();
    return msg.includes('rejected') || msg.includes('declined') || msg.includes('denied')
      || msg.includes('cancelled') || msg.includes('canceled');
  }

  /* muchu.app copy of the launcher: the site is static on Vercel, so API
   * calls go cross-origin to the game host and the client lives at /play/. */
  const API_BASE = 'https://web.muchu.app';
  function toPlayHref(playUrl) {
    return '/play/' + String(playUrl || '/').replace(/^\//, '');
  }

  /** fetch wrapper: JSON in/out, friendly network errors, {error} bodies surfaced. */
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path.startsWith('/api/') ? API_BASE + path : path, opts);
    } catch {
      const err = new Error('Network error — could not reach the MuchuCraft gateway. Is it running?');
      err.network = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const fallback = res.status === 429
        ? 'Too many requests — please wait a moment and try again.'
        : `Request failed (HTTP ${res.status}).`;
      const err = new Error((data && data.error) || fallback);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  /* ---------------------------------------------------------------- *
   * Wallet discovery                                                  *
   * Primary: Wallet Standard two-way handshake.                       *
   * Fallback: legacy injected providers, polled briefly after load.   *
   * ---------------------------------------------------------------- */

  /** @type {Array<{key:string,name:string,icon:?string,kind:'standard'|'legacy',wallet?:object,provider?:object}>} */
  const wallets = [];
  let discoveryDone = false;
  let discoveryTimer = 0;

  function hasSolanaFeatures(wallet) {
    try {
      const features = wallet && wallet.features;
      if (!features) return false;
      const connect = features['standard:connect'];
      const signMessage = features['solana:signMessage'];
      if (!connect || typeof connect.connect !== 'function') return false;
      if (!signMessage || typeof signMessage.signMessage !== 'function') return false;
      const chains = Array.isArray(wallet.chains) ? wallet.chains : [];
      return chains.some((c) => typeof c === 'string' && c.startsWith('solana:'));
    } catch {
      return false;
    }
  }

  function addWallet(entry) {
    const key = String(entry.name || '').trim().toLowerCase();
    if (!key || wallets.some((w) => w.key === key)) return; // dedupe by name
    wallets.push({ ...entry, key });
    renderWallets();
  }

  function registerWallets(...incoming) {
    for (const wallet of incoming) {
      if (hasSolanaFeatures(wallet)) {
        addWallet({
          name: wallet.name || 'Solana wallet',
          icon: typeof wallet.icon === 'string' ? wallet.icon : null,
          kind: 'standard',
          wallet,
        });
      }
    }
    return () => { /* unregister: no-op for this page's lifetime */ };
  }

  const walletStandardApi = Object.freeze({ register: registerWallets });

  // Wallets announce themselves; hand them our (frozen) registration API.
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    try {
      const callback = event.detail;
      if (typeof callback === 'function') callback(walletStandardApi);
    } catch (err) {
      console.warn('[login] wallet-standard registration failed', err);
    }
  });

  function announceAppReady() {
    try {
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletStandardApi }));
    } catch (err) {
      console.warn('[login] wallet-standard app-ready dispatch failed', err);
    }
  }
  announceAppReady(); // ask already-loaded wallets to register

  const LEGACY_PROVIDERS = [
    { name: 'Phantom', get: () => (window.phantom && window.phantom.solana) || null },
    { name: 'Solflare', get: () => window.solflare || null },
    { name: 'Backpack', get: () => window.backpack || null },
  ];

  function scanLegacy() {
    for (const legacy of LEGACY_PROVIDERS) {
      let provider = null;
      try { provider = legacy.get(); } catch { /* ignore exotic getters */ }
      if (provider && typeof provider.connect === 'function' && typeof provider.signMessage === 'function') {
        addWallet({ name: legacy.name, icon: null, kind: 'legacy', provider });
      }
    }
  }

  function startDiscovery() {
    clearInterval(discoveryTimer);
    discoveryDone = false;
    announceAppReady();
    scanLegacy();
    renderWallets();
    let ticks = 0;
    discoveryTimer = setInterval(() => {
      scanLegacy();
      if (++ticks >= 12) { // ~3s of brief polling for late injectors
        clearInterval(discoveryTimer);
        discoveryDone = true;
        renderWallets();
      }
    }, 250);
  }

  function renderWallets() {
    const list = $('wallet-list');
    list.textContent = '';
    for (const w of wallets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wallet-btn';

      if (w.icon && (w.icon.startsWith('data:image/') || w.icon.startsWith('data:img/'))) {
        const img = document.createElement('img');
        img.src = w.icon;
        img.alt = '';
        img.className = 'wallet-icon';
        btn.appendChild(img);
      } else {
        const glyph = document.createElement('span');
        glyph.className = 'wallet-icon wallet-glyph';
        glyph.textContent = w.name.slice(0, 1).toUpperCase();
        btn.appendChild(glyph);
      }

      const label = document.createElement('span');
      label.className = 'wallet-name';
      label.textContent = w.name;
      btn.appendChild(label);

      const tag = document.createElement('span');
      tag.className = 'wallet-kind';
      tag.textContent = w.kind === 'standard' ? 'detected' : 'legacy';
      btn.appendChild(tag);

      btn.addEventListener('click', () => connectWallet(w));
      list.appendChild(btn);
    }

    const scanning = $('wallet-scanning');
    const noWallet = $('no-wallet');
    if (wallets.length > 0) {
      hide(scanning);
      hide(noWallet);
    } else if (discoveryDone) {
      hide(scanning);
      show(noWallet);
    } else {
      show(scanning);
      hide(noWallet);
    }
  }

  /* ---------------------------------------------------------------- *
   * Connect                                                           *
   * ---------------------------------------------------------------- */

  const state = { entry: null, account: null, address: null };

  function resetConnection() {
    state.entry = null;
    state.account = null;
    state.address = null;
  }

  async function connectWallet(entry) {
    setBanner('');
    try {
      if (entry.kind === 'standard') {
        const result = await entry.wallet.features['standard:connect'].connect();
        const accounts =
          (result && Array.isArray(result.accounts) && result.accounts.length ? result.accounts : entry.wallet.accounts) || [];
        const account =
          accounts.find((a) => Array.isArray(a.chains) && a.chains.some((c) => String(c).startsWith('solana:')))
          || accounts[0];
        if (!account || !account.address) throw new Error('the wallet did not return a Solana account.');
        state.entry = entry;
        state.account = account;
        state.address = account.address;
      } else {
        const provider = entry.provider;
        const result = await provider.connect();
        const publicKey = (result && result.publicKey) || provider.publicKey;
        const address = typeof publicKey === 'string'
          ? publicKey
          : publicKey && (typeof publicKey.toBase58 === 'function' ? publicKey.toBase58() : publicKey.toString());
        if (!address) throw new Error('could not read the wallet address.');
        state.entry = entry;
        state.account = null;
        state.address = address;
      }
      enterUsernameView();
    } catch (err) {
      resetConnection();
      if (isUserRejection(err)) {
        setBanner('Connection request was declined in the wallet — no worries, try again whenever you like.', 'warn');
      } else if (err && err.network) {
        setBanner(err.message, 'error');
      } else {
        setBanner(`Could not connect to ${entry.name}: ${(err && err.message) || err}`, 'error');
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Username input with live availability                             *
   * ---------------------------------------------------------------- */

  let debounceTimer = 0;
  let checkSeq = 0;

  function setUsernameStatus(text, kind) {
    const el = $('username-status');
    el.textContent = text;
    el.className = 'status' + (kind ? ` status-${kind}` : '');
  }

  function setSignEnabled(enabled) {
    $('btn-sign').disabled = !enabled;
  }

  function enterUsernameView() {
    setBanner('');
    $('connected-wallet').textContent = state.entry.name;
    const addrEl = $('connected-address');
    addrEl.textContent = shortAddress(state.address);
    addrEl.title = state.address;
    hide($('message-details'));
    $('message-text').textContent = '';
    hide($('sign-error'));
    showView('view-username');
    const input = $('username');
    onUsernameInput();
    input.focus();
  }

  function onUsernameInput() {
    const name = $('username').value.trim();
    clearTimeout(debounceTimer);
    hide($('sign-error'));

    if (name.length === 0) {
      setUsernameStatus('', '');
      setSignEnabled(false);
      return;
    }
    if (!USERNAME_RE.test(name)) {
      setUsernameStatus('3–16 characters — letters, numbers and underscores only.', 'bad');
      setSignEnabled(false);
      return;
    }

    setUsernameStatus('Checking availability…', 'pending');
    setSignEnabled(false);
    const seq = ++checkSeq;

    debounceTimer = setTimeout(async () => {
      try {
        const headers = {};
        const token = lsGet(LS.token);
        if (token) headers.Authorization = `Bearer ${token}`;
        const data = await api(`/api/auth/username/${encodeURIComponent(name)}`, { headers });
        if (seq !== checkSeq) return; // stale response, user kept typing
        if (data.status === 'available') {
          setUsernameStatus('Available ✓', 'good');
          setSignEnabled(true);
        } else if (data.status === 'yours') {
          setUsernameStatus('This username already belongs to your wallet ✓', 'good');
          setSignEnabled(true);
        } else if (data.status === 'taken') {
          setUsernameStatus('Taken by another wallet — pick a different name.', 'bad');
          setSignEnabled(false);
        } else {
          setUsernameStatus('Could not read availability — you can still try to sign.', 'warn');
          setSignEnabled(true);
        }
      } catch (err) {
        if (seq !== checkSeq) return;
        // Availability is advisory; the nonce endpoint enforces ownership (409).
        setUsernameStatus('Could not check availability — you can still try to sign.', 'warn');
        setSignEnabled(true);
      }
    }, 300);
  }

  /* ---------------------------------------------------------------- *
   * Sign & Play                                                       *
   * ---------------------------------------------------------------- */

  async function signMessage(message) {
    const bytes = new TextEncoder().encode(message);

    if (state.entry.kind === 'standard') {
      const feature = state.entry.wallet.features['solana:signMessage'];
      const outputs = await feature.signMessage({ account: state.account, message: bytes });
      const out = Array.isArray(outputs) ? outputs[0] : outputs;
      if (!out || !out.signature) throw new Error('The wallet did not return a signature.');
      const result = { signature: Array.from(out.signature) };
      // Some wallets (Ledger/Solflare off-chain header) sign a wrapped message —
      // send it too so the gateway can verify over the wrapped bytes.
      if (out.signedMessage) result.signedMessage = Array.from(out.signedMessage);
      return result;
    }

    // Legacy providers (Phantom / Solflare / Backpack injected objects).
    const raw = await state.entry.provider.signMessage(bytes, 'utf8');
    let sig = raw && raw.signature !== undefined ? raw.signature : raw;
    if (sig && !(sig instanceof Uint8Array) && !Array.isArray(sig) && Array.isArray(sig.data)) {
      sig = sig.data; // Buffer-ish {type:'Buffer', data:[...]}
    }
    if (!sig || typeof sig.length !== 'number' || sig.length === 0) {
      throw new Error('The wallet did not return a signature.');
    }
    return { signature: Array.from(sig) };
  }

  let signing = false;

  async function onSignAndPlay() {
    if (signing || !state.entry || !state.address) return;
    const name = $('username').value.trim();
    if (!USERNAME_RE.test(name)) return;

    signing = true;
    const btn = $('btn-sign');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    hide($('sign-error'));

    try {
      btn.textContent = 'Requesting sign-in message…';
      const nonceRes = await api('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, address: state.address }),
      });
      if (typeof nonceRes.message !== 'string' || !nonceRes.nonce) {
        throw new Error('The gateway returned an unexpected nonce response.');
      }

      // Show the exact message so the user can compare with the wallet popup.
      $('message-text').textContent = nonceRes.message;
      show($('message-details'));

      btn.textContent = 'Waiting for your wallet…';
      const signed = await signMessage(nonceRes.message);

      btn.textContent = 'Verifying signature…';
      const body = {
        nonce: nonceRes.nonce,
        address: state.address,
        signature: signed.signature,
      };
      if (signed.signedMessage) body.signedMessage = signed.signedMessage;
      const verifyRes = await api('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!verifyRes.token || !verifyRes.playUrl) {
        throw new Error('The gateway returned an unexpected verify response.');
      }

      lsSet(LS.token, verifyRes.token);
      lsSet(LS.username, verifyRes.username || name);
      lsSet(LS.playUrl, verifyRes.playUrl);

      btn.textContent = 'Launching MuchuCraft…';
      location.href = toPlayHref(verifyRes.playUrl);
      return; // keep button disabled while navigating away
    } catch (err) {
      let msg;
      if (isUserRejection(err)) {
        msg = 'Signature request was declined in the wallet. Nothing was sent — try again when you are ready.';
      } else if (err && err.status === 409) {
        msg = `"${name}" is already claimed by a different wallet — pick another username.`;
      } else if (err && err.network) {
        msg = err.message;
      } else {
        msg = (err && err.message) || 'Something went wrong — please try again.';
      }
      const box = $('sign-error');
      box.textContent = msg;
      show(box);
      btn.textContent = originalLabel;
      btn.disabled = false;
    } finally {
      signing = false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Wallet card — MUCHU token economy (SPEC-TOKEN.md "Wallet UI")     *
   * Shown only when a session is active AND /api/token/status is 200. *
   * 404/501 mean the token economy is not configured: keep it hidden. *
   * Amount math uses BigInt raw units (10^decimals) — never floats.   *
   * ---------------------------------------------------------------- */

  const TERMINAL_STATES = ['confirmed', 'failed', 'refunded'];
  const WITHDRAW_POLL_MS = 3000;

  const tokenState = {
    token: null,      // session token for Authorization
    status: null,     // last GET /api/token/status payload
    decimals: 6,      // MUCHU_DECIMALS default; overridden by status when present
    cluster: 'devnet',
    pollTimer: 0,
    watchId: null,    // withdrawal id we are waiting on
    submitting: false,
  };

  function tokenHeaders(extra) {
    const headers = { Authorization: `Bearer ${tokenState.token}` };
    return extra ? Object.assign(headers, extra) : headers;
  }

  /** First present (non-null/undefined) property among candidate key spellings. */
  function firstDefined(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return undefined;
  }

  /** Decimal string -> BigInt raw units. null when malformed or too many dp. */
  function toRaw(value, decimals) {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value === undefined || value === null ? '' : value).trim());
    if (!match) return null;
    const frac = match[2] || '';
    if (frac.length > decimals) return null;
    const padded = frac.length < decimals ? frac + '0'.repeat(decimals - frac.length) : frac;
    return BigInt(match[1]) * (10n ** BigInt(decimals)) + BigInt(padded || '0');
  }

  /** BigInt raw units -> decimal string without trailing zeros. */
  function formatRaw(raw, decimals) {
    const base = 10n ** BigInt(decimals);
    const whole = (raw / base).toString();
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }

  /** Normalize a decimal-string amount for display (strip trailing zeros). */
  function formatAmount(value) {
    const raw = toRaw(value, tokenState.decimals);
    return raw === null ? String(value) : formatRaw(raw, tokenState.decimals);
  }

  /** Cluster-aware Solana explorer link for a transaction signature. */
  function explorerTxUrl(signature) {
    const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
    const cluster = tokenState.cluster || 'devnet';
    if (/^mainnet/i.test(cluster)) return base; // mainnet(-beta): no cluster param
    return `${base}?cluster=${encodeURIComponent(cluster)}`;
  }

  /** status.withdrawable may be a bool (+ sibling reason) or {ok, reason}. */
  function parseWithdrawable(status) {
    const w = status ? status.withdrawable : undefined;
    if (w && typeof w === 'object') {
      const ok = firstDefined(w, ['ok', 'withdrawable', 'value', 'enabled']);
      return { ok: !!ok, reason: String(w.reason || '') };
    }
    const reason = firstDefined(status || {}, ['reason', 'withdrawableReason', 'withdrawable_reason', 'pausedReason']);
    return { ok: !!w, reason: String(reason || '') };
  }

  function setWithdrawStatus(text, kind, link) {
    const el = $('withdraw-status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ` status-${kind}` : '');
    if (link && link.href) {
      el.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label || 'View on Solana Explorer ↗';
      el.appendChild(a);
    }
  }

  function showWithdrawError(message) {
    const box = $('withdraw-error');
    box.textContent = message;
    show(box);
    setWithdrawStatus('', '');
  }

  function updateWithdrawButton() {
    const withdrawable = parseWithdrawable(tokenState.status);
    $('btn-withdraw').disabled = tokenState.submitting || !withdrawable.ok;
  }

  function renderWalletStatus(status) {
    tokenState.status = status;
    const decimals = Number(firstDefined(status, ['decimals', 'mintDecimals']));
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 12) tokenState.decimals = decimals;
    if (status.cluster) tokenState.cluster = String(status.cluster);

    const balance = firstDefined(status, ['balance', 'ingameBalance']) || '0';
    $('wallet-balance').textContent = `${formatAmount(balance)} MUCHU`;

    const boundWallet = String(firstDefined(status, ['boundWallet', 'bound_wallet', 'wallet']) || '');
    const boundEl = $('wallet-bound');
    boundEl.textContent = shortAddress(boundWallet);
    boundEl.title = boundWallet;

    const clusterEl = $('wallet-cluster');
    clusterEl.textContent = tokenState.cluster;
    show(clusterEl);

    // Paused / treasury notice
    const withdrawable = parseWithdrawable(status);
    const treasuryOk = !(status.treasury && status.treasury.ok === false);
    const paused = $('wallet-paused');
    if (!withdrawable.ok || !treasuryOk) {
      paused.textContent = withdrawable.reason
        ? `Withdrawals are paused — ${withdrawable.reason}`
        : !treasuryOk
          ? 'Withdrawals are paused — the treasury is temporarily unavailable. Your in-game balance is safe.'
          : 'Withdrawals are currently paused. Your in-game balance is safe — try again later.';
      show(paused);
    } else {
      hide(paused);
    }
    updateWithdrawButton();

    // Min / max / caps hints
    const caps = status.caps || {};
    const min = firstDefined(caps, ['min', 'withdrawMin', 'perTxMin', 'minPerTx']);
    const max = firstDefined(caps, ['max', 'maxPerTx', 'perTxMax', 'withdrawMax']);
    const daily = firstDefined(caps, ['dailyPerUser', 'perUserDaily', 'userDailyCap', 'dailyCapPerUser']);
    const remaining = firstDefined(caps, ['userDailyRemaining', 'remainingToday', 'userRemainingToday', 'dailyRemaining']);
    const parts = [];
    if (min !== undefined) parts.push(`min ${formatAmount(min)}`);
    if (max !== undefined) parts.push(`max ${formatAmount(max)} per withdrawal`);
    if (daily !== undefined) parts.push(`daily limit ${formatAmount(daily)}`);
    if (remaining !== undefined) parts.push(`${formatAmount(remaining)} left today`);
    $('withdraw-hints').textContent = parts.length ? `MUCHU · ${parts.join(' · ')}` : '';
  }

  async function refreshWalletStatus() {
    if (!tokenState.token) return;
    try {
      renderWalletStatus(await api('/api/token/status', { headers: tokenHeaders() }));
    } catch { /* transient — keep last rendered state */ }
  }

  /* ----- withdrawals list ----- */

  async function fetchWithdrawals() {
    const data = await api('/api/token/withdrawals', { headers: tokenHeaders() });
    const list = Array.isArray(data) ? data : firstDefined(data, ['withdrawals', 'items', 'rows']);
    return Array.isArray(list) ? list : [];
  }

  function rowAmountText(row) {
    const amount = firstDefined(row, ['amount', 'amountDecimal']);
    if (amount !== undefined) return formatAmount(amount);
    const raw = firstDefined(row, ['amountRaw', 'amount_raw', 'rawAmount']);
    if (raw !== undefined) {
      try { return formatRaw(BigInt(raw), tokenState.decimals); } catch { /* fall through */ }
    }
    return '?';
  }

  function rowTimeText(row) {
    const value = firstDefined(row, ['createdAt', 'created_at', 'updatedAt', 'updated_at']);
    if (value === undefined) return '';
    let ms = value;
    if (typeof value === 'string' && /^\d+$/.test(value)) ms = Number(value);
    if (typeof ms === 'number' && ms < 1e12) ms *= 1000; // epoch seconds -> ms
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderWithdrawals(rows) {
    const history = $('withdraw-history');
    const list = $('withdrawal-list');
    list.textContent = '';
    if (!rows.length) {
      hide(history);
      return;
    }
    for (const row of rows.slice(0, 8)) {
      const item = document.createElement('li');
      item.className = 'wd-item';

      const top = document.createElement('div');
      top.className = 'wd-row';
      const amount = document.createElement('span');
      amount.className = 'wd-amount';
      amount.textContent = `${rowAmountText(row)} MUCHU`;
      top.appendChild(amount);
      const state = document.createElement('span');
      const stateName = String(row.state || 'pending');
      state.className = 'wd-state ' + (TERMINAL_STATES.includes(stateName) ? `wd-state-${stateName}` : 'wd-state-pending');
      state.textContent = stateName;
      top.appendChild(state);
      item.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'wd-meta';
      const time = document.createElement('span');
      time.textContent = rowTimeText(row);
      meta.appendChild(time);
      if (row.signature) {
        const link = document.createElement('a');
        link.className = 'wd-link';
        link.href = explorerTxUrl(String(row.signature));
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Explorer ↗';
        meta.appendChild(link);
      }
      item.appendChild(meta);

      if (row.error && stateName !== 'confirmed') {
        const errLine = document.createElement('p');
        errLine.className = 'wd-error';
        errLine.textContent = String(row.error);
        item.appendChild(errLine);
      }
      list.appendChild(item);
    }
    show(history);
  }

  /* ----- polling until the watched withdrawal reaches a terminal state ----- */

  function stopWithdrawalPolling() {
    clearInterval(tokenState.pollTimer);
    tokenState.pollTimer = 0;
  }

  function startWithdrawalPolling() {
    stopWithdrawalPolling();
    tokenState.pollTimer = setInterval(pollWithdrawals, WITHDRAW_POLL_MS);
    pollWithdrawals();
  }

  const PENDING_STATE_LABELS = {
    requested: 'Queued — waiting for the withdrawal worker…',
    debited: 'In-game balance debited — preparing the on-chain transfer…',
    signed: 'Transaction signed — sending to Solana…',
    submitted: 'Transaction submitted — waiting for confirmation…',
  };

  async function pollWithdrawals() {
    if (!tokenState.token) {
      stopWithdrawalPolling();
      return;
    }
    let rows;
    try {
      rows = await fetchWithdrawals();
    } catch {
      return; // transient failure — keep polling
    }
    renderWithdrawals(rows);

    if (tokenState.watchId !== null) {
      const watched = rows.find((row) => String(row.id) === String(tokenState.watchId));
      if (watched) {
        const stateName = String(watched.state || '');
        if (TERMINAL_STATES.includes(stateName)) {
          tokenState.watchId = null;
          finishWatchedWithdrawal(watched, stateName);
          refreshWalletStatus(); // balance changed (or was refunded)
        } else {
          setWithdrawStatus(PENDING_STATE_LABELS[stateName] || `Processing (${stateName})…`, 'pending');
        }
      }
      // Row not visible yet (list may lag the 202): keep polling.
    }

    const anyPending = rows.some((row) => row && row.state && !TERMINAL_STATES.includes(String(row.state)));
    if (tokenState.watchId === null && !anyPending) stopWithdrawalPolling();
  }

  function finishWatchedWithdrawal(row, stateName) {
    const link = row.signature ? { href: explorerTxUrl(String(row.signature)), label: 'View on Solana Explorer ↗' } : null;
    if (stateName === 'confirmed') {
      setWithdrawStatus(`Withdrawal confirmed ✓ ${rowAmountText(row)} MUCHU sent to your wallet.`, 'good', link);
      hide($('withdraw-error'));
    } else if (stateName === 'refunded') {
      setWithdrawStatus('', '');
      showWithdrawError(
        'The on-chain transfer failed, so your MUCHU was refunded to your in-game balance. Nothing was lost — try again later.'
        + (row.error ? ` (${row.error})` : ''),
      );
    } else { // failed
      setWithdrawStatus('', '');
      showWithdrawError(
        'The withdrawal failed. If your in-game balance was debited it will be refunded shortly.'
        + (row.error ? ` (${row.error})` : ''),
      );
    }
  }

  /* ----- submit ----- */

  /** Friendly copy for withdraw errors; prefers the gateway's own message. */
  function withdrawErrorCopy(err) {
    const generic = !err || err.network || !err.message
      || /^Request failed \(HTTP \d+\)\.$/.test(err.message)
      || /^Too many requests/.test(err.message);
    const serverMessage = generic ? '' : err.message;
    switch (err && err.status) {
      case 400: return serverMessage || 'That amount is not valid — check the minimum, maximum and decimal places.';
      case 409: return serverMessage || 'Withdrawal rejected — your balance may be too low, or another withdrawal is still in flight. Wait for it to finish and try again.';
      case 429: return serverMessage || 'Daily withdrawal limit reached — try again tomorrow.';
      case 503: return serverMessage || 'Withdrawals are paused right now. Your in-game balance is safe — try again later.';
      case 401:
      case 403: return 'Your session expired — refresh the page and sign in again.';
      default:
        if (err && err.network) return err.message;
        return serverMessage || 'Something went wrong submitting the withdrawal — please try again.';
    }
  }

  async function onWithdrawSubmit(event) {
    event.preventDefault();
    if (tokenState.submitting || !tokenState.token) return;
    hide($('withdraw-error'));

    const input = $('withdraw-amount');
    const amount = input.value.trim();
    const raw = toRaw(amount, tokenState.decimals);
    if (raw === null || raw <= 0n) {
      showWithdrawError(`Enter a positive amount with at most ${tokenState.decimals} decimal places — for example 25 or 12.5.`);
      return;
    }

    // Advisory pre-checks from the last /status (the gateway is authoritative).
    const status = tokenState.status || {};
    const caps = status.caps || {};
    const minRaw = toRaw(firstDefined(caps, ['min', 'withdrawMin', 'perTxMin', 'minPerTx']), tokenState.decimals);
    const maxRaw = toRaw(firstDefined(caps, ['max', 'maxPerTx', 'perTxMax', 'withdrawMax']), tokenState.decimals);
    const balanceRaw = toRaw(firstDefined(status, ['balance', 'ingameBalance']), tokenState.decimals);
    if (minRaw !== null && raw < minRaw) {
      showWithdrawError(`The minimum withdrawal is ${formatRaw(minRaw, tokenState.decimals)} MUCHU.`);
      return;
    }
    if (maxRaw !== null && raw > maxRaw) {
      showWithdrawError(`The maximum per withdrawal is ${formatRaw(maxRaw, tokenState.decimals)} MUCHU.`);
      return;
    }
    if (balanceRaw !== null && raw > balanceRaw) {
      showWithdrawError(`That is more than your in-game balance of ${formatRaw(balanceRaw, tokenState.decimals)} MUCHU.`);
      return;
    }

    tokenState.submitting = true;
    updateWithdrawButton();
    setWithdrawStatus('Sending withdrawal request…', 'pending');
    try {
      const res = await api('/api/token/withdraw', {
        method: 'POST',
        headers: tokenHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ amount }),
      });
      const id = firstDefined(res, ['withdrawalId', 'withdrawal_id', 'id']);
      input.value = '';
      tokenState.watchId = id === undefined ? null : id;
      setWithdrawStatus('Withdrawal accepted — processing on-chain…', 'pending');
      startWithdrawalPolling();
    } catch (err) {
      showWithdrawError(withdrawErrorCopy(err));
      refreshWalletStatus(); // caps/paused state may explain the rejection
    } finally {
      tokenState.submitting = false;
      updateWithdrawButton();
    }
  }

  /* ----- init / teardown ----- */

  async function initWalletCard(sessionToken) {
    tokenState.token = sessionToken;
    let status;
    try {
      status = await api('/api/token/status', {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
    } catch (err) {
      // 404/501: token economy not configured — the card simply stays hidden.
      if (!(err && (err.status === 404 || err.status === 501))) {
        console.warn('[login] token status unavailable', err);
      }
      teardownWalletCard();
      return;
    }
    renderWalletStatus(status);
    show($('wallet-card'));
    try {
      const rows = await fetchWithdrawals();
      renderWithdrawals(rows);
      // Resume watching if a withdrawal is still in flight from a previous visit.
      if (rows.some((row) => row && row.state && !TERMINAL_STATES.includes(String(row.state)))) {
        startWithdrawalPolling();
      }
    } catch { /* history is non-essential at load time */ }
  }

  function teardownWalletCard() {
    stopWithdrawalPolling();
    tokenState.token = null;
    tokenState.status = null;
    tokenState.watchId = null;
    tokenState.submitting = false;
    hide($('wallet-card'));
    $('withdraw-amount').value = '';
    $('withdrawal-list').textContent = '';
    hide($('withdraw-history'));
    hide($('withdraw-error'));
    setWithdrawStatus('', '');
  }

  /* ---------------------------------------------------------------- *
   * Skin picker (SPEC-PHASE3 §4)                                      *
   * The gateway stores "name:<mcname>" | "url:<https .png>"; the user *
   * types just the username or URL and we add the prefix. Applied by  *
   * the gateway on every join (and immediately when already online).  *
   * ---------------------------------------------------------------- */

  const SKIN_MAX_LEN = 300;
  const skinState = { token: null, current: null, saving: false };

  function setSkinStatus(text, kind) {
    const el = $('skin-status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ` status-${kind}` : '');
  }

  /** Stored descriptor -> what the input shows (prefix stripped). */
  function skinDisplayValue(stored) {
    if (typeof stored !== 'string') return '';
    if (stored.startsWith('name:')) return stored.slice(5);
    if (stored.startsWith('url:')) return stored.slice(4);
    return stored;
  }

  /**
   * Input text -> stored descriptor. Mirrors the gateway's validation
   * (the gateway is authoritative). Returns {value} (null value = clear)
   * or {error}.
   */
  function skinDescriptorFromInput(text) {
    const v = String(text || '').trim();
    if (v.length === 0) return { value: null };
    if (/^https?:\/\//i.test(v)) {
      if (!/^https:\/\//i.test(v)) return { error: 'Skin URLs must use https.' };
      if (/\s/.test(v)) return { error: 'Skin URLs cannot contain spaces.' };
      if (!/\.png$/i.test(v)) return { error: 'Skin URLs must end in .png.' };
      if (v.length + 4 > SKIN_MAX_LEN) return { error: 'That URL is too long (300 characters max).' };
      return { value: `url:${v}` };
    }
    if (!USERNAME_RE.test(v)) {
      return { error: 'Use a Minecraft username (3–16 letters, numbers, _) or an https URL ending in .png.' };
    }
    return { value: `name:${v}` };
  }

  function renderSkinControls(sessionToken, storedSkin) {
    skinState.token = sessionToken;
    skinState.current = typeof storedSkin === 'string' && storedSkin ? storedSkin : null;
    skinState.saving = false;
    $('skin-input').value = skinDisplayValue(skinState.current);
    setSkinStatus(skinState.current ? 'Current skin shown above — applies when you join.' : '', '');
  }

  async function onSkinSave() {
    if (skinState.saving || !skinState.token) return;
    const parsed = skinDescriptorFromInput($('skin-input').value);
    if (parsed.error) {
      setSkinStatus(parsed.error, 'bad');
      return;
    }
    if (parsed.value === null && skinState.current === null) {
      setSkinStatus('Type a Minecraft username or an https PNG URL first.', 'warn');
      return;
    }
    skinState.saving = true;
    const btn = $('btn-skin-save');
    btn.disabled = true;
    setSkinStatus('Saving skin…', 'pending');
    try {
      const data = await api('/api/auth/skin', {
        method: 'POST',
        headers: { Authorization: `Bearer ${skinState.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ skin: parsed.value }),
      });
      skinState.current = data && typeof data.skin === 'string' ? data.skin : null;
      setSkinStatus(
        skinState.current ? 'Skin saved ✓ — applies when you join.' : 'Skin cleared ✓ — back to the default.',
        'good',
      );
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        setSkinStatus('Your session expired — refresh the page and sign in again.', 'bad');
      } else {
        setSkinStatus((err && err.message) || 'Could not save the skin — please try again.', 'bad');
      }
    } finally {
      skinState.saving = false;
      btn.disabled = false;
    }
  }

  function wireSkinControls() {
    $('btn-skin-save').addEventListener('click', onSkinSave);
    $('skin-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onSkinSave();
    });
    for (const btn of document.querySelectorAll('.skin-preset')) {
      btn.addEventListener('click', () => {
        $('skin-input').value = skinDisplayValue(btn.dataset.skin);
        setSkinStatus(`Preset "${btn.textContent.trim()}" selected — press Save skin.`, 'pending');
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Session resume & view wiring                                      *
   * ---------------------------------------------------------------- */

  function buildPlayUrl() {
    const stored = lsGet(LS.playUrl);
    if (stored) return stored;
    // Fallback if playUrl was never stored: the gateway proxies to the real
    // server regardless of the requested destination, so username+token are
    // the essential parameters.
    const username = lsGet(LS.username) || '';
    const token = lsGet(LS.token) || '';
    return `/?username=${encodeURIComponent(username)}&token=${encodeURIComponent(token)}&autoConnect=true&lockConnect=true`;
  }

  function enterWalletsView() {
    showView('view-wallets');
    startDiscovery();
  }

  async function init() {
    const token = lsGet(LS.token);
    if (!token) {
      enterWalletsView();
      return;
    }
    showView('view-loading');
    try {
      const session = await api('/api/auth/session', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!session || !session.username) {
        const err = new Error('Invalid session response.');
        err.status = 401;
        throw err;
      }
      lsSet(LS.username, session.username);
      $('session-name').textContent = session.username;
      renderSkinControls(token, session.skin);
      showView('view-session');
      initWalletCard(token); // fire-and-forget: card appears only if token economy is live
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        lsClear();
        enterWalletsView();
        setBanner('Your session expired — connect your wallet to sign in again.', 'warn');
      } else {
        enterWalletsView();
        setBanner(
          err && err.network ? err.message : `Could not check your session: ${(err && err.message) || err}`,
          'error',
        );
      }
    }
  }

  function wireEvents() {
    $('username').addEventListener('input', onUsernameInput);
    $('username').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !$('btn-sign').disabled) onSignAndPlay();
    });
    $('btn-sign').addEventListener('click', onSignAndPlay);
    $('btn-play').addEventListener('click', () => { location.href = toPlayHref(buildPlayUrl()); });
    $('btn-logout').addEventListener('click', () => {
      lsClear();
      resetConnection();
      teardownWalletCard();
      renderSkinControls(null, null);
      setBanner('');
      enterWalletsView();
    });
    $('withdraw-form').addEventListener('submit', onWithdrawSubmit);
    $('btn-disconnect').addEventListener('click', () => {
      resetConnection();
      enterWalletsView();
    });
    $('btn-rescan').addEventListener('click', () => startDiscovery());
  }

  wireEvents();
  wireSkinControls();
  init();
})();
