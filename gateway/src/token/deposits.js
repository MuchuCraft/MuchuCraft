// deposits.js — poll-based deposit watcher over the treasury ATA + deposit
// routes + bridge deposit-info push (SPEC-PHASE3 §1).
//
// Players send MUCHU from their BOUND wallet to the treasury owner address;
// no memos — correlation is by SOURCE ADDRESS. Every DEPOSIT_POLL_SECONDS the
// watcher runs getSignaturesForAddress(treasuryATA, {until: <cursor>}) on the
// configured RPC, fetches each new transaction (jsonParsed) and classifies
// every incoming SPL transfer of MUCHU_MINT into the treasury ATA (the source
// token account's OWNER is the depositor address):
//
//   owner == users.address, amount ≥ DEPOSIT_MIN → 'credited'  (bridge POST
//       /credit + balanced journal entry: +ingame_liability / −deposits_in,
//       ref = deposit:<signature> — deposits INCREASE liability but the
//       tokens arrived in the treasury, so solvency stays balanced)
//   owner == users.address, amount < DEPOSIT_MIN → 'dust'      (no credit)
//   owner unknown                                → 'unmatched' (LOUD log)
//   owner == treasury owner (self-deposit /
//       withdrawal-change tx)                    → skipped entirely
//   bridge/RPC failure mid-credit               → 'pending_retry' (next tick)
//
// Idempotency: deposits.signature is the PRIMARY KEY (a re-scan can never
// double-credit) and the journal ref is the deposit signature (postEntry
// dedupes on ref). The cursor (last processed signature) is persisted, so a
// restart scans back only until the last stored signature.
//
// Earn gate: after every successful credit, if the user's cumulative credited
// deposits ≥ DEPOSIT_GATE_MIN the injected promoteToDepositor(username)
// callback fires — both when the gate is first crossed AND on every later
// matched deposit for already-unlocked users (idempotent insurance). The
// default is a no-op; the gate agent's RCON implementation
// (`lp user <name> parent add depositor`) is injected via attachDeposits().
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { address, createSolanaRpc } from '@solana/kit';
import * as splToken from '@solana-program/token';
import * as splToken2022 from '@solana-program/token-2022';
import { formatRawAmount, parseAmountToRaw } from './ledger.js';
import { createBridgeClient } from './bridge-client.js';
import { loadTreasury, TOKEN_2022_PROGRAM_ADDRESS } from './solana.js';

export const DEPOSIT_STATES = ['credited', 'unmatched', 'dust', 'pending_retry'];

/** System ledger account the player-liability leg is posted against. */
export const DEPOSITS_IN_ACCOUNT = 'deposits_in';

const SIGNATURE_PAGE_LIMIT = 1000;
const PUSH_BACKOFF_MIN_MS = 2_000;
const PUSH_BACKOFF_MAX_MS = 60_000;

// ---------------------------------------------------------------- config

/**
 * Deposit .env keys (values already present in root .env; token env loading
 * itself is owned by routes.js/loadTokenConfig which runs first).
 * Amounts are whole-MUCHU decimal strings; raw BigInt precomputed.
 * @param {{decimals: number}} tokenConfig
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadDepositConfig(tokenConfig, env = process.env) {
  const min = env.DEPOSIT_MIN || '1';
  const gateMin = env.DEPOSIT_GATE_MIN || '25';
  const pollSeconds = toInt(env.DEPOSIT_POLL_SECONDS, 20);
  return {
    min,
    gateMin,
    pollSeconds,
    pageUrl: depositPageUrl(env.SIWS_URI),
    minRaw: parseAmountToRaw(min, tokenConfig.decimals),
    gateMinRaw: parseAmountToRaw(gateMin, tokenConfig.decimals),
  };
}

/**
 * Public /deposit page URL, derived from SIWS_URI's origin (SIWS_URI is the
 * launcher URL, e.g. https://web.muchu.app/login/ → https://web.muchu.app/deposit).
 * null when SIWS_URI is unset/unparseable — the push then omits pageUrl and
 * the in-game /deposit command simply skips its "open the page" line.
 */
function depositPageUrl(siwsUri) {
  if (!siwsUri) return null;
  try {
    const origin = new URL(siwsUri).origin;
    return origin && origin !== 'null' ? `${origin}/deposit` : null;
  } catch {
    return null;
  }
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------- store

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deposits (
  signature    TEXT PRIMARY KEY,
  slot         INTEGER,
  block_time   INTEGER,
  from_address TEXT NOT NULL,
  amount_raw   INTEGER NOT NULL,
  user_id      INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('credited','unmatched','dust','pending_retry')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deposits_user_created ON deposits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE TABLE IF NOT EXISTS deposit_cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  signature  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Same DDL as ledger.js (IF NOT EXISTS): whichever module opens the shared
-- db file first creates it; we only need to seed the deposits_in account.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL,
  user_id INTEGER,
  name    TEXT NOT NULL UNIQUE
);
`;

export class DepositError extends Error {
  constructor(message, code = 'DEPOSIT_ERROR') {
    super(message);
    this.name = 'DepositError';
    this.code = code;
  }
}

/**
 * Deposit persistence: own node:sqlite connection on the shared gateway db
 * file (WAL makes additional connections safe) or an existing DatabaseSync
 * instance (tests). Mirrors createLedger's construction contract.
 * @param {{dbPath?: string, database?: import('node:sqlite').DatabaseSync, now?: () => number}} opts
 */
export function createDepositStore({ dbPath, database, now = Date.now } = {}) {
  let db = database;
  const ownDb = !db;
  if (ownDb) {
    if (!dbPath) throw new DepositError('createDepositStore needs dbPath or database');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // :memory: — non-fatal
    }
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
  } catch {
    /* non-fatal */
  }
  db.exec(SCHEMA);
  db.prepare(
    'INSERT OR IGNORE INTO ledger_accounts (kind, user_id, name) VALUES (?, NULL, ?)',
  ).run('system', DEPOSITS_IN_ACCOUNT);

  /** Prepare a statement that reads SQLite INTEGERs as BigInt (raw units). */
  function prepareBig(sql) {
    const s = db.prepare(sql);
    s.setReadBigInts(true);
    return s;
  }

  const stmt = {
    insert: db.prepare(
      `INSERT INTO deposits
        (signature, slot, block_time, from_address, amount_raw, user_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    get: prepareBig('SELECT * FROM deposits WHERE signature = ?'),
    setStatus: db.prepare('UPDATE deposits SET status = ? WHERE signature = ?'),
    listForUser: prepareBig(
      'SELECT * FROM deposits WHERE user_id = ? ORDER BY rowid DESC LIMIT ?',
    ),
    inStatus: prepareBig('SELECT * FROM deposits WHERE status = ? ORDER BY rowid'),
    cumulativeCredited: prepareBig(
      `SELECT COALESCE(SUM(amount_raw), 0) AS total FROM deposits
       WHERE user_id = ? AND status = 'credited'`,
    ),
    getCursor: db.prepare('SELECT signature FROM deposit_cursor WHERE id = 1'),
    setCursor: db.prepare(
      `INSERT INTO deposit_cursor (id, signature, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET signature = excluded.signature, updated_at = excluded.updated_at`,
    ),
  };

  function rowToDeposit(r) {
    if (!r) return null;
    return {
      signature: r.signature,
      slot: r.slot == null ? null : Number(r.slot),
      blockTime: r.block_time == null ? null : Number(r.block_time),
      fromAddress: r.from_address,
      amountRaw: BigInt(r.amount_raw),
      userId: r.user_id == null ? null : Number(r.user_id),
      status: r.status,
      createdAt: Number(r.created_at),
    };
  }

  /**
   * Insert a deposit; the signature PRIMARY KEY makes this idempotent —
   * a duplicate returns the EXISTING row with {deduped: true}.
   */
  function insertDeposit({ signature, slot = null, blockTime = null, fromAddress, amountRaw, userId = null, status, at = now() }) {
    if (!DEPOSIT_STATES.includes(status)) {
      throw new DepositError(`unknown deposit status ${status}`, 'BAD_STATUS');
    }
    try {
      stmt.insert.run(
        signature,
        slot == null ? null : Number(slot),
        blockTime == null ? null : Number(blockTime),
        fromAddress,
        BigInt(amountRaw),
        userId,
        status,
        at,
      );
      return { deposit: getDeposit(signature), deduped: false };
    } catch (err) {
      if (/UNIQUE constraint failed: deposits\.signature|PRIMARY KEY/i.test(err.message)) {
        return { deposit: getDeposit(signature), deduped: true };
      }
      throw err;
    }
  }

  function getDeposit(signature) {
    return rowToDeposit(stmt.get.get(signature));
  }

  function setStatus(signature, status) {
    if (!DEPOSIT_STATES.includes(status)) {
      throw new DepositError(`unknown deposit status ${status}`, 'BAD_STATUS');
    }
    stmt.setStatus.run(status, signature);
    return getDeposit(signature);
  }

  function listForUser(userId, limit = 20) {
    return stmt.listForUser.all(userId, limit).map(rowToDeposit);
  }

  function rowsInStatus(status) {
    return stmt.inStatus.all(status).map(rowToDeposit);
  }

  /** Σ credited deposit amounts for the user (BigInt raw units) — the gate. */
  function cumulativeCreditedRaw(userId) {
    return stmt.cumulativeCredited.get(userId).total;
  }

  function getCursor() {
    return stmt.getCursor.get()?.signature ?? null;
  }

  function setCursor(signature, at = now()) {
    stmt.setCursor.run(signature, at);
  }

  // --- users (shared gateway db; guarded — table may be absent in tests) -----

  function getUserByAddress(addr) {
    try {
      const row = db.prepare(
        `SELECT id, username FROM users WHERE address = ?
         ORDER BY (last_login_at IS NULL), last_login_at DESC, id LIMIT 1`,
      ).get(addr);
      return row ? { id: Number(row.id), username: row.username } : null;
    } catch {
      return null;
    }
  }

  function getUsername(userId) {
    try {
      const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
      return row?.username ?? null;
    } catch {
      return null;
    }
  }

  function close() {
    if (!ownDb) return; // caller owns the connection
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return {
    insertDeposit,
    getDeposit,
    setStatus,
    listForUser,
    rowsInStatus,
    cumulativeCreditedRaw,
    getCursor,
    setCursor,
    getUserByAddress,
    getUsername,
    close,
  };
}

// ------------------------------------------------------------ tx parsing

/** Owner of a token account, from the transaction's pre/post token balances. */
function ownerOfTokenAccount(tx, source) {
  if (!source) return null;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const idx = keys.findIndex((k) => String(k?.pubkey ?? k) === source);
  if (idx === -1) return null;
  for (const list of [tx.meta?.preTokenBalances, tx.meta?.postTokenBalances]) {
    for (const tb of list ?? []) {
      if (Number(tb.accountIndex) === idx && tb.owner) return String(tb.owner);
    }
  }
  return null;
}

/**
 * All incoming SPL transfers of `mint` into `treasuryAta` in a jsonParsed
 * transaction — both `transferChecked` and plain `transfer` instruction
 * forms, top-level and inner. → [{owner, source, amountRaw}]
 *
 * A plain `transfer` carries no mint field, but the destination IS the
 * treasury's MUCHU ATA and the token program enforces source/destination
 * mint equality, so a successful transfer into it must be MUCHU.
 */
export function extractIncomingTransfers(tx, treasuryAta, mint) {
  const instructions = [...(tx.transaction?.message?.instructions ?? [])];
  for (const inner of tx.meta?.innerInstructions ?? []) {
    instructions.push(...(inner.instructions ?? []));
  }
  const out = [];
  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    if (typeof ix.program === 'string' && !ix.program.startsWith('spl-token')) continue;
    const { type, info } = parsed;
    if (!info || (type !== 'transfer' && type !== 'transferChecked')) continue;
    if (String(info.destination ?? '') !== treasuryAta) continue;
    if (type === 'transferChecked' && info.mint && String(info.mint) !== mint) continue;
    const amountStr = type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
    let amountRaw;
    try {
      amountRaw = BigInt(amountStr);
    } catch {
      continue; // not a token amount (e.g. a system transfer) — skip
    }
    if (amountRaw <= 0n) continue;
    const source = String(info.source ?? '');
    const owner =
      ownerOfTokenAccount(tx, source) ??
      (info.authority ? String(info.authority) : null) ??
      (info.multisigAuthority ? String(info.multisigAuthority) : null);
    out.push({ owner, source, amountRaw });
  }
  return out;
}

// ---------------------------------------------------------------- watcher

/**
 * @param {{
 *   store: ReturnType<typeof createDepositStore>,
 *   ledger: ReturnType<import('./ledger.js').createLedger>,
 *   bridge: ReturnType<import('./bridge-client.js').createBridgeClient>,
 *   tokenConfig: object, depositConfig: ReturnType<typeof loadDepositConfig>,
 *   rpc?: object,                                          // kit rpc (mock in tests)
 *   resolveTreasury?: () => Promise<{ownerAddress: string, ataAddress: string}>,
 *   getUserByAddress?: (address: string) => {id: number, username: string}|null,
 *   getUsername?: (userId: number) => string|null,
 *   promoteToDepositor?: (username: string) => any,        // gate seam, default no-op
 *   postDepositInfo?: (body: object) => Promise<any>,      // bridge push, default fetch
 *   log?: Console, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number, pageLimit?: number,
 * }} deps
 */
export function createDepositWatcher({
  store,
  ledger,
  bridge,
  tokenConfig,
  depositConfig,
  rpc = null,
  resolveTreasury = null,
  getUserByAddress = (addr) => store.getUserByAddress(addr),
  getUsername = (userId) => store.getUsername(userId),
  promoteToDepositor = () => {}, // filled by the gate agent's RCON implementation
  postDepositInfo = null,
  log = console,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  pollMs = depositConfig.pollSeconds * 1000,
  pageLimit = SIGNATURE_PAGE_LIMIT,
}) {
  rpc ??= createSolanaRpc(tokenConfig.rpcUrl);
  const fmt = (raw) => formatRawAmount(raw, tokenConfig.decimals);

  let treasury = null; // {ownerAddress, ataAddress} once resolved
  let treasuryPromise = null;
  let ticking = null; // single-flight tick promise
  let stopped = false;
  let timer = null;
  let lastTickAt = null;
  let infoPushed = false;

  // --- treasury resolution ---------------------------------------------------

  /**
   * Deposit address = treasury OWNER address (from the keypair file); the
   * watched account is its MUCHU ATA (derived with the mint's actual owner
   * program, so a Token-2022 mint works unchanged — mirrors solana.js).
   */
  async function defaultResolveTreasury() {
    if (!tokenConfig.mint) throw new DepositError('MUCHU_MINT is not configured');
    const signer = await loadTreasury(tokenConfig.treasuryKeypairPath);
    const ownerAddress = String(signer.address);
    let res;
    try {
      res = await rpc.getAccountInfo(address(tokenConfig.mint), { encoding: 'base64' }).send();
    } catch (err) {
      throw new DepositError(`getAccountInfo(mint) failed: ${err?.message ?? err}`, 'RPC_UNAVAILABLE');
    }
    if (!res?.value) throw new DepositError(`mint ${tokenConfig.mint} not found on-chain`);
    const programAddress = String(res.value.owner);
    const mod = programAddress === String(TOKEN_2022_PROGRAM_ADDRESS) ? splToken2022 : splToken;
    const [ata] = await mod.findAssociatedTokenPda({
      owner: address(ownerAddress),
      mint: address(tokenConfig.mint),
      tokenProgram: address(programAddress),
    });
    return { ownerAddress, ataAddress: String(ata) };
  }

  function ensureTreasury() {
    if (treasury) return Promise.resolve(treasury);
    if (!treasuryPromise) {
      treasuryPromise = (resolveTreasury ?? defaultResolveTreasury)()
        .then((t) => {
          treasury = t;
          log.log(`[deposits] watching treasury ATA ${t.ataAddress} (deposit address ${t.ownerAddress})`);
          return t;
        })
        .catch((err) => {
          treasuryPromise = null; // retry on the next tick
          throw err;
        });
    }
    return treasuryPromise;
  }

  /** Treasury OWNER address (what players deposit to), or null until resolved. */
  function depositAddress() {
    return treasury?.ownerAddress ?? null;
  }

  // --- deposit-info push ------------------------------------------------------

  async function defaultPostDepositInfo(body) {
    const root = String(tokenConfig.bridgeUrl).replace(/\/+$/, '');
    const res = await fetch(`${root}/deposit-info`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenConfig.bridgeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new DepositError(`bridge /deposit-info → HTTP ${res.status}`);
  }

  /**
   * Push {address, minimum, gateThreshold, pageUrl} to the bridge so /deposit
   * works in-game (pageUrl powers its clickable "open the deposit page" line;
   * omitted when SIWS_URI is unset). Retries with exponential backoff until it
   * lands (bridge routinely comes up after the gateway) — all values are
   * env-derived, so "on change" means "on (re)boot"; one successful push per
   * start() suffices.
   * @returns {Promise<boolean>} true once pushed, false if stopped first
   */
  async function pushDepositInfo() {
    let delayMs = PUSH_BACKOFF_MIN_MS;
    while (!stopped) {
      const addr = depositAddress();
      if (addr) {
        const body = {
          address: addr,
          minimum: depositConfig.min,
          gateThreshold: depositConfig.gateMin,
          ...(depositConfig.pageUrl ? { pageUrl: depositConfig.pageUrl } : {}),
        };
        try {
          await (postDepositInfo ?? defaultPostDepositInfo)(body);
          infoPushed = true;
          log.log(`[deposits] deposit-info pushed to bridge (address ${addr}, min ${body.minimum}, gate ${body.gateThreshold})`);
          return true;
        } catch (err) {
          log.warn(`[deposits] deposit-info push failed (${err.message}) — retrying in ${Math.round(delayMs / 1000)}s`);
        }
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PUSH_BACKOFF_MAX_MS);
    }
    return false;
  }

  // --- credit path -------------------------------------------------------------

  /**
   * Journal + bridge credit + gate check for a matched deposit row. Journal
   * first (ref = deposit signature ⇒ idempotent), then the in-game credit;
   * a bridge failure leaves the row 'pending_retry' for the next tick.
   * @returns {Promise<boolean>} credited?
   */
  async function settle(dep) {
    const username = getUsername(dep.userId);
    if (!username) {
      log.error(`[deposits] ${dep.signature}: user ${dep.userId} not found — leaving pending_retry`);
      return false;
    }
    const ref = `deposit:${dep.signature}`;
    ledger.postEntry({
      reason: `deposit ${dep.signature}: on-chain deposit from ${dep.fromAddress}`,
      ref,
      legs: [
        { account: 'ingame_liability', delta: dep.amountRaw },
        { account: DEPOSITS_IN_ACCOUNT, delta: -dep.amountRaw },
      ],
    });
    try {
      await bridge.credit({ player: username, amount: fmt(dep.amountRaw), ref });
    } catch (err) {
      log.warn(`[deposits] ${dep.signature}: in-game credit failed (${err.message}); will retry next tick`);
      return false;
    }
    store.setStatus(dep.signature, 'credited');
    log.log(`[deposits] credited ${fmt(dep.amountRaw)} MUCHU to ${username} (${dep.signature})`);
    const cumulative = store.cumulativeCreditedRaw(dep.userId);
    if (cumulative >= depositConfig.gateMinRaw) {
      // Fires on the gate-crossing deposit AND on every later credited
      // deposit for already-unlocked users (idempotent insurance).
      try {
        await promoteToDepositor(username);
      } catch (err) {
        log.warn(`[deposits] promoteToDepositor(${username}) failed: ${err.message}`);
      }
    }
    return true;
  }

  /** Rows left 'pending_retry' by a bridge/RPC failure — retried every tick. */
  async function retryPending() {
    for (const dep of store.rowsInStatus('pending_retry')) {
      if (stopped) return;
      await settle(dep);
    }
  }

  // --- scan -------------------------------------------------------------------

  async function getParsedTransaction(signature) {
    try {
      return await rpc
        .getTransaction(signature, {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
        .send();
    } catch (err) {
      throw new DepositError(`getTransaction(${signature}) failed: ${err?.message ?? err}`, 'RPC_UNAVAILABLE');
    }
  }

  /**
   * Classify one signature. Idempotent: an existing deposits row (signature
   * PK) short-circuits. Throws only on RPC failure — the caller aborts the
   * scan WITHOUT advancing the cursor, so the signature is retried next tick.
   */
  async function processSignature(info) {
    const signature = String(info.signature);
    if (store.getDeposit(signature)) return; // already recorded — never re-credit
    if (info.err) return; // failed tx moved nothing
    const tx = await getParsedTransaction(signature);
    if (!tx || tx.meta?.err) return;
    const incoming = extractIncomingTransfers(tx, treasury.ataAddress, tokenConfig.mint);
    if (incoming.length === 0) return; // outgoing withdrawal / unrelated tx

    // One row per signature (PK): attribute to the first source owner.
    const fromAddress = incoming[0].owner ?? incoming[0].source ?? 'unknown';
    let amountRaw = 0n;
    for (const t of incoming) {
      const owner = t.owner ?? t.source ?? 'unknown';
      if (owner === fromAddress) amountRaw += t.amountRaw;
      else log.warn(`[deposits] ${signature}: extra transfer from ${owner} ignored (multi-source tx)`);
    }
    if (amountRaw <= 0n) return;
    if (fromAddress === treasury.ownerAddress) {
      log.log(`[deposits] ${signature}: treasury self-transfer — excluded`);
      return;
    }

    const slot = info.slot ?? tx.slot ?? null;
    const blockTime = info.blockTime ?? tx.blockTime ?? null;
    const base = { signature, slot, blockTime, fromAddress, amountRaw };
    const user = getUserByAddress(fromAddress);
    if (!user) {
      store.insertDeposit({ ...base, userId: null, status: 'unmatched' });
      log.error(
        `[deposits] *** UNMATCHED DEPOSIT *** ${fmt(amountRaw)} MUCHU from unknown address ` +
        `${fromAddress} (${signature}) — needs manual handling`,
      );
      return;
    }
    if (amountRaw < depositConfig.minRaw) {
      store.insertDeposit({ ...base, userId: user.id, status: 'dust' });
      log.warn(
        `[deposits] dust deposit of ${fmt(amountRaw)} MUCHU from ${user.username} ` +
        `(< DEPOSIT_MIN ${depositConfig.min}) — not credited (${signature})`,
      );
      return;
    }
    const { deposit } = store.insertDeposit({ ...base, userId: user.id, status: 'pending_retry' });
    await settle(deposit);
  }

  /**
   * New signatures since the persisted cursor, oldest first. The cursor
   * advances only past PROCESSED signatures, so a crash/RPC failure mid-scan
   * resumes exactly where it stopped (and the signature PK absorbs overlap).
   */
  async function scan() {
    const cursor = store.getCursor();
    const infos = [];
    let before;
    for (;;) {
      let page;
      try {
        page = await rpc
          .getSignaturesForAddress(treasury.ataAddress, {
            commitment: 'confirmed',
            limit: pageLimit,
            ...(cursor ? { until: cursor } : {}),
            ...(before ? { before } : {}),
          })
          .send();
      } catch (err) {
        throw new DepositError(`getSignaturesForAddress failed: ${err?.message ?? err}`, 'RPC_UNAVAILABLE');
      }
      if (!Array.isArray(page) || page.length === 0) break;
      infos.push(...page);
      if (page.length < pageLimit) break;
      before = String(page[page.length - 1].signature);
    }
    for (let i = infos.length - 1; i >= 0; i--) {
      if (stopped) return;
      await processSignature(infos[i]);
      store.setCursor(String(infos[i].signature), now());
    }
  }

  // --- tick loop -----------------------------------------------------------------

  /** Single-flight poll pass: resolve treasury → retry pending → scan. */
  function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        await ensureTreasury();
        await retryPending();
        await scan();
        lastTickAt = now();
      } catch (err) {
        log.warn(`[deposits] poll tick failed (${err.message}); retrying next tick`);
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }

  function start() {
    stopped = false;
    void (async () => {
      await tick(); // resolves the treasury and backfills since the cursor
      void pushDepositInfo(); // needs the resolved deposit address; retries with backoff
    })();
    timer = setInterval(() => void tick(), pollMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function status() {
    return {
      treasuryAddress: depositAddress(),
      treasuryAta: treasury?.ataAddress ?? null,
      cursor: store.getCursor(),
      lastTickAt,
      infoPushed,
    };
  }

  return { start, stop, tick, pushDepositInfo, depositAddress, status };
}

// ---------------------------------------------------------------- routes

function bearerSession(db, req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const token = m ? m[1].trim() : null;
  return token ? db.getSessionInfo(token) : null;
}

/**
 * Router mounted at /api/token BEFORE the main token router:
 *   - GET /deposits — recent deposits for the session user (array, same
 *     style as /withdrawals).
 *   - GET /status — pass-through middleware that merges a {deposit: {...}}
 *     block into the token router's response body.
 * @param {{db: object, store: object, tokenConfig: object, depositConfig: object, getDepositAddress: () => string|null}} deps
 */
export function createDepositRoutes({ db, store, tokenConfig, depositConfig, getDepositAddress }) {
  const router = express.Router();
  const dec = tokenConfig.decimals;

  function gateFor(userId) {
    const cumulative = store.cumulativeCreditedRaw(userId);
    return {
      threshold: depositConfig.gateMin,
      cumulativeRaw: cumulative.toString(),
      unlocked: cumulative >= depositConfig.gateMinRaw,
    };
  }

  // GET /status is answered by the token router mounted after this one; wrap
  // res.json so successful bodies gain the deposit block (401s untouched).
  // The block's {address, minimum, gateThreshold} are PUBLIC by design —
  // players share the treasury deposit address, and the unauthenticated
  // status subset feeds the /deposit page — while the per-user `gate`
  // progress stays session-scoped.
  router.get('/status', (req, res, next) => {
    const original = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400 && body && typeof body === 'object' && !Array.isArray(body)) {
        const session = bearerSession(db, req);
        body = {
          ...body,
          deposit: {
            address: getDepositAddress(),
            minimum: depositConfig.min,
            gateThreshold: depositConfig.gateMin,
            ...(session ? { gate: gateFor(session.userId) } : {}),
          },
        };
      }
      return original(body);
    };
    next();
  });

  // GET /deposits — recent deposits for that user (newest first).
  router.get('/deposits', (req, res) => {
    const session = bearerSession(db, req);
    if (!session) {
      return res.status(401).json({ error: 'Missing, expired, or revoked session token.' });
    }
    const rows = store.listForUser(session.userId, 20);
    res.json(rows.map((r) => ({
      signature: r.signature,
      amount: formatRawAmount(r.amountRaw, dec),
      amountRaw: r.amountRaw.toString(),
      status: r.status,
      fromAddress: r.fromAddress,
      slot: r.slot,
      blockTime: r.blockTime,
      createdAt: r.createdAt,
    })));
  });

  return router;
}

// ---------------------------------------------------------- composition root

/**
 * Wire deposits into an existing token module IN PLACE (single index.js call):
 *   - tokenModule.router  → deposit routes + status augmentation + old router
 *   - tokenModule.worker.start() also starts the watcher (same lifecycle)
 *   - tokenModule.close() also stops the watcher and closes the store
 *
 * `promoteToDepositor` is the earn-gate seam (SPEC-PHASE3 §2): the gate
 * agent's RCON implementation replaces the default no-op.
 * `overrides` are test seams (mock rpc/bridge/store/etc.), mirroring
 * createChain(tokenConfig, overrides) in solana.js.
 *
 * @param {{tokenModule: object, config: {dbPath: string}, tokenConfig: object, db: object,
 *          promoteToDepositor?: (username: string) => any, overrides?: object}} deps
 */
export function attachDeposits({ tokenModule, config, tokenConfig, db, promoteToDepositor, overrides = {} }) {
  const depositConfig = loadDepositConfig(tokenConfig, overrides.env ?? process.env);
  const store = overrides.store ?? createDepositStore(
    overrides.database ? { database: overrides.database } : { dbPath: config.dbPath },
  );
  const bridge = overrides.bridge ?? createBridgeClient({
    baseUrl: tokenConfig.bridgeUrl,
    token: tokenConfig.bridgeToken,
  });
  const watcher = createDepositWatcher({
    store,
    ledger: tokenModule.ledger,
    bridge,
    tokenConfig,
    depositConfig,
    promoteToDepositor,
    rpc: overrides.rpc,
    resolveTreasury: overrides.resolveTreasury,
    postDepositInfo: overrides.postDepositInfo,
    getUserByAddress: overrides.getUserByAddress,
    getUsername: overrides.getUsername,
    log: overrides.log,
    now: overrides.now,
    sleep: overrides.sleep,
    ...(overrides.pollMs != null ? { pollMs: overrides.pollMs } : {}),
  });

  const router = express.Router();
  router.use(createDepositRoutes({
    db,
    store,
    tokenConfig,
    depositConfig,
    getDepositAddress: watcher.depositAddress,
  }));
  router.use(tokenModule.router);
  tokenModule.router = router;

  const workerStart = tokenModule.worker.start.bind(tokenModule.worker);
  tokenModule.worker.start = (...args) => {
    workerStart(...args); // withdrawal worker first (unchanged behavior)
    watcher.start(); // deposit watcher alongside it (SPEC-PHASE3 §1)
  };
  const close = tokenModule.close.bind(tokenModule);
  tokenModule.close = () => {
    watcher.stop();
    close();
    store.close();
  };

  const deposits = { store, watcher, depositConfig, router };
  tokenModule.deposits = deposits;
  return deposits;
}
