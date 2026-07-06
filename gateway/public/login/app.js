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

  /** fetch wrapper: JSON in/out, friendly network errors, {error} bodies surfaced. */
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, opts);
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
      location.href = verifyRes.playUrl;
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
      showView('view-session');
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
    $('btn-play').addEventListener('click', () => { location.href = buildPlayUrl(); });
    $('btn-logout').addEventListener('click', () => {
      lsClear();
      resetConnection();
      setBanner('');
      enterWalletsView();
    });
    $('btn-disconnect').addEventListener('click', () => {
      resetConnection();
      enterWalletsView();
    });
    $('btn-rescan').addEventListener('click', () => startDiscovery());
  }

  wireEvents();
  init();
})();
