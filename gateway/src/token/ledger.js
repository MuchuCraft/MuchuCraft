// ledger.js — double-entry token ledger + withdrawal state machine storage.
//
// All monetary values are RAW UNITS (BigInt, 10^MUCHU_DECIMALS raw = 1 MUCHU)
// internally; decimal STRINGS only at API boundaries (see parseAmountToRaw /
// formatRawAmount). Opens its own node:sqlite connection on the shared gateway
// db file (WAL makes the second connection safe) or accepts an existing
// DatabaseSync instance (tests).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const WITHDRAWAL_STATES = [
  'requested', 'debited', 'signed', 'submitted', 'confirmed', 'failed', 'refunded',
];

// Terminal for the one-in-flight rule: confirmed | failed | refunded.
// ('failed' rows may still owe the player a refund; that is tracked via the
// journal refs, not via the in-flight rule.)
export const NON_TERMINAL_STATES = ['requested', 'debited', 'signed', 'submitted'];

/** Legal state-machine transitions (see SPEC-TOKEN.md). */
const TRANSITIONS = {
  requested: new Set(['debited', 'failed']),
  debited: new Set(['signed', 'failed']),
  // signed → debited / submitted → debited: blockhash provably expired with a
  // null signature status ⇒ safe to re-sign. signed → confirmed: crash
  // recovery discovered the send actually landed.
  signed: new Set(['submitted', 'confirmed', 'debited', 'failed']),
  submitted: new Set(['confirmed', 'debited', 'failed']),
  failed: new Set(['refunded']),
  confirmed: new Set(),
  refunded: new Set(),
};

const SYSTEM_ACCOUNTS = ['ingame_liability', 'onchain_outflow', 'adjustments'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL,
  user_id INTEGER,
  name    TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id         INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS journal_legs (
  entry_id   INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
  delta      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id                      INTEGER PRIMARY KEY,
  idempotency_key         TEXT UNIQUE,
  user_id                 INTEGER NOT NULL,
  dest_address            TEXT NOT NULL,
  amount_raw              INTEGER NOT NULL,
  state                   TEXT NOT NULL CHECK (state IN
    ('requested','debited','signed','submitted','confirmed','failed','refunded')),
  signature               TEXT,
  last_valid_block_height INTEGER,
  error                   TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
-- One non-terminal withdrawal per user, enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_one_in_flight
  ON withdrawals(user_id)
  WHERE state NOT IN ('confirmed','failed','refunded');
CREATE INDEX IF NOT EXISTS idx_withdrawals_state ON withdrawals(state);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_created ON withdrawals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_journal_legs_entry ON journal_legs(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_legs_account ON journal_legs(account_id);
`;

export class LedgerError extends Error {
  constructor(message, code = 'LEDGER_ERROR') {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- amounts

/**
 * STRICT boundary conversion: decimal string → raw BigInt units.
 * Rejects: non-strings, negatives, exponent notation, missing digits
 * (".5" / "5."), more than `decimals` fractional digits, absurd lengths.
 * @throws {LedgerError} code 'BAD_AMOUNT'
 */
export function parseAmountToRaw(value, decimals) {
  if (typeof value !== 'string') {
    throw new LedgerError('amount must be a decimal string, e.g. "25" or "12.5"', 'BAD_AMOUNT');
  }
  if (value.length === 0 || value.length > 30) {
    throw new LedgerError('amount must be a decimal string of sane length', 'BAD_AMOUNT');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) {
    throw new LedgerError(
      'amount must be a plain positive decimal (no sign, no exponent notation)', 'BAD_AMOUNT');
  }
  const [, whole, frac = ''] = m;
  if (frac.length > decimals) {
    throw new LedgerError(`amount supports at most ${decimals} decimal places`, 'BAD_AMOUNT');
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * LENIENT conversion for values we did not mint ourselves (bridge balances):
 * accepts any number of decimal places and rounds UP past `decimals`
 * (conservative for solvency math). Still no signs/exponents.
 */
export function parseLooseAmountToRaw(value, decimals) {
  const str = typeof value === 'number' ? value.toFixed(decimals + 2) : String(value ?? '');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) throw new LedgerError(`unparseable balance ${JSON.stringify(value)}`, 'BAD_AMOUNT');
  const [, whole, frac = ''] = m;
  const kept = frac.slice(0, decimals);
  const rest = frac.slice(decimals);
  let raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept.padEnd(decimals, '0') || '0');
  if (/[1-9]/.test(rest)) raw += 1n; // round up: never under-count a liability
  return raw;
}

/** Raw BigInt units → decimal string (trailing zeros trimmed). */
export function formatRawAmount(raw, decimals) {
  let v = BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const pow = 10n ** BigInt(decimals);
  const whole = (v / pow).toString();
  const frac = (v % pow).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ---------------------------------------------------------------- ledger

/**
 * @param {{dbPath?: string, database?: import('node:sqlite').DatabaseSync, now?: () => number}} opts
 */
export function createLedger({ dbPath, database, now = Date.now } = {}) {
  let db = database;
  const ownDb = !db;
  if (ownDb) {
    if (!dbPath) throw new LedgerError('createLedger needs dbPath or database');
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
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const name of SYSTEM_ACCOUNTS) {
    db.prepare(
      'INSERT OR IGNORE INTO ledger_accounts (kind, user_id, name) VALUES (?, NULL, ?)',
    ).run('system', name);
  }

  /** Prepare a statement that reads SQLite INTEGERs as BigInt (raw units). */
  function prepareBig(sql) {
    const s = db.prepare(sql);
    s.setReadBigInts(true);
    return s;
  }

  const stmt = {
    getAccountByName: db.prepare('SELECT id FROM ledger_accounts WHERE name = ?'),
    insertEntry: db.prepare('INSERT INTO journal_entries (created_at, reason, ref) VALUES (?, ?, ?)'),
    getEntryByRef: db.prepare('SELECT id FROM journal_entries WHERE ref = ?'),
    insertLeg: db.prepare('INSERT INTO journal_legs (entry_id, account_id, delta) VALUES (?, ?, ?)'),
    sumLegs: prepareBig('SELECT COALESCE(SUM(delta), 0) AS total FROM journal_legs WHERE entry_id = ?'),
    accountBalance: prepareBig(
      `SELECT COALESCE(SUM(l.delta), 0) AS total FROM journal_legs l
       JOIN ledger_accounts a ON a.id = l.account_id WHERE a.name = ?`,
    ),
    insertWithdrawal: db.prepare(
      `INSERT INTO withdrawals
        (idempotency_key, user_id, dest_address, amount_raw, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'requested', ?, ?)`,
    ),
    getWithdrawal: prepareBig('SELECT * FROM withdrawals WHERE id = ?'),
    getWithdrawalByKey: prepareBig('SELECT * FROM withdrawals WHERE idempotency_key = ?'),
    updateWithdrawal: db.prepare(
      `UPDATE withdrawals SET state = ?, signature = ?, last_valid_block_height = ?,
        error = ?, updated_at = ? WHERE id = ?`,
    ),
    inFlight: db.prepare(
      `SELECT id FROM withdrawals
       WHERE user_id = ? AND state NOT IN ('confirmed','failed','refunded') LIMIT 1`,
    ),
    userDaily: prepareBig(
      `SELECT COALESCE(SUM(amount_raw), 0) AS total FROM withdrawals
       WHERE user_id = ? AND created_at > ? AND state NOT IN ('failed','refunded')`,
    ),
    globalDaily: prepareBig(
      `SELECT COALESCE(SUM(amount_raw), 0) AS total FROM withdrawals
       WHERE created_at > ? AND state NOT IN ('failed','refunded')`,
    ),
    pendingTotal: prepareBig(
      `SELECT COALESCE(SUM(amount_raw), 0) AS total FROM withdrawals
       WHERE state IN ('requested','debited','signed','submitted')`,
    ),
    listForUser: prepareBig(
      'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    ),
  };

  let inTxn = false;
  /** Run `fn` inside a transaction (flat: nested calls join the outer txn). */
  function inTransaction(fn) {
    if (inTxn) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTxn = true;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      inTxn = false;
    }
  }

  function rowToWithdrawal(r) {
    if (!r) return null;
    return {
      id: Number(r.id),
      idempotencyKey: r.idempotency_key,
      userId: Number(r.user_id),
      destAddress: r.dest_address,
      amountRaw: BigInt(r.amount_raw),
      state: r.state,
      signature: r.signature ?? null,
      lastValidBlockHeight:
        r.last_valid_block_height == null ? null : BigInt(r.last_valid_block_height),
      error: r.error ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // --- journal --------------------------------------------------------------

  /**
   * Post a balanced journal entry. `ref` (UNIQUE) provides idempotency: a
   * duplicate ref is a no-op returning {deduped: true}. Legs must sum to 0.
   * @param {{reason: string, ref?: string|null, legs: {account: string, delta: bigint}[], at?: number}} entry
   */
  function postEntry({ reason, ref = null, legs, at = now() }) {
    return inTransaction(() => {
      if (ref != null) {
        const existing = stmt.getEntryByRef.get(ref);
        if (existing) return { entryId: Number(existing.id), deduped: true };
      }
      if (!Array.isArray(legs) || legs.length < 2) {
        throw new LedgerError('journal entry needs at least two legs', 'UNBALANCED');
      }
      const { lastInsertRowid } = stmt.insertEntry.run(at, reason, ref);
      const entryId = Number(lastInsertRowid);
      for (const leg of legs) {
        const acc = stmt.getAccountByName.get(leg.account);
        if (!acc) throw new LedgerError(`unknown ledger account ${leg.account}`, 'NO_ACCOUNT');
        stmt.insertLeg.run(entryId, acc.id, BigInt(leg.delta));
      }
      const { total } = stmt.sumLegs.get(entryId);
      if (total !== 0n) {
        throw new LedgerError(`journal entry legs must sum to zero (got ${total})`, 'UNBALANCED');
      }
      return { entryId, deduped: false };
    });
  }

  function hasEntry(ref) {
    return stmt.getEntryByRef.get(ref) != null;
  }

  /** Net balance of a named account (BigInt raw units). */
  function accountBalance(name) {
    return stmt.accountBalance.get(name).total;
  }

  // --- withdrawals ----------------------------------------------------------

  /**
   * Create a 'requested' withdrawal. Same idempotency key → the existing row
   * ({deduped:true}). A second non-terminal withdrawal for the user throws
   * LedgerError code 'IN_FLIGHT' (partial unique index).
   */
  function createWithdrawal({ idempotencyKey = null, userId, destAddress, amountRaw, at = now() }) {
    const raw = BigInt(amountRaw);
    if (raw <= 0n) throw new LedgerError('withdrawal amount must be positive', 'BAD_AMOUNT');
    if (idempotencyKey != null) {
      const existing = rowToWithdrawal(stmt.getWithdrawalByKey.get(idempotencyKey));
      if (existing) return { withdrawal: existing, deduped: true };
    }
    try {
      const { lastInsertRowid } = stmt.insertWithdrawal.run(
        idempotencyKey, userId, destAddress, raw, at, at,
      );
      return { withdrawal: getWithdrawal(Number(lastInsertRowid)), deduped: false };
    } catch (err) {
      if (/idempotency_key/.test(err.message) && idempotencyKey != null) {
        const raced = rowToWithdrawal(stmt.getWithdrawalByKey.get(idempotencyKey));
        if (raced) return { withdrawal: raced, deduped: true };
      }
      if (/UNIQUE constraint failed: withdrawals\.user_id/.test(err.message)) {
        throw new LedgerError('user already has a withdrawal in flight', 'IN_FLIGHT');
      }
      throw err;
    }
  }

  function getWithdrawal(id) {
    return rowToWithdrawal(stmt.getWithdrawal.get(id));
  }

  function getWithdrawalByKey(idempotencyKey) {
    if (idempotencyKey == null) return null;
    return rowToWithdrawal(stmt.getWithdrawalByKey.get(idempotencyKey));
  }

  /**
   * State-machine transition with validation. Extra fields (signature,
   * lastValidBlockHeight, error) are persisted alongside. Returns the row.
   * @throws {LedgerError} code 'BAD_TRANSITION' on an illegal move.
   */
  function transition(id, nextState, { signature, lastValidBlockHeight, error } = {}) {
    return inTransaction(() => {
      const row = getWithdrawal(id);
      if (!row) throw new LedgerError(`withdrawal ${id} not found`, 'NOT_FOUND');
      if (!TRANSITIONS[row.state]?.has(nextState)) {
        throw new LedgerError(
          `illegal withdrawal transition ${row.state} -> ${nextState} (id ${id})`,
          'BAD_TRANSITION',
        );
      }
      stmt.updateWithdrawal.run(
        nextState,
        signature ?? row.signature,
        lastValidBlockHeight != null ? BigInt(lastValidBlockHeight) : row.lastValidBlockHeight,
        error ?? row.error,
        now(),
        id,
      );
      return getWithdrawal(id);
    });
  }

  /** Atomic: bridge debit succeeded ⇒ state 'debited' + journal in one txn. */
  function recordDebit(id) {
    return inTransaction(() => {
      const row = transition(id, 'debited');
      postEntry({
        reason: `withdrawal ${id}: in-game debit for on-chain payout`,
        ref: `withdraw:${id}:debit`,
        legs: [
          { account: 'ingame_liability', delta: -row.amountRaw },
          { account: 'onchain_outflow', delta: row.amountRaw },
        ],
      });
      return row;
    });
  }

  /** Atomic: bridge credit (refund) succeeded ⇒ reversal entry + 'refunded'. */
  function recordRefund(id) {
    return inTransaction(() => {
      const row = getWithdrawal(id);
      if (!row) throw new LedgerError(`withdrawal ${id} not found`, 'NOT_FOUND');
      postEntry({
        reason: `withdrawal ${id}: refund after permanent failure`,
        ref: `withdraw:${id}:refund`,
        legs: [
          { account: 'ingame_liability', delta: row.amountRaw },
          { account: 'onchain_outflow', delta: -row.amountRaw },
        ],
      });
      return transition(id, 'refunded');
    });
  }

  function hasInFlight(userId) {
    return stmt.inFlight.get(userId) != null;
  }

  /** Σ withdrawals for the user in the trailing 24h (excl. failed/refunded). */
  function userDailyTotalRaw(userId, at = now()) {
    return stmt.userDaily.get(userId, at - DAY_MS).total;
  }

  /** Σ all withdrawals in the trailing 24h (excl. failed/refunded). */
  function globalDailyTotalRaw(at = now()) {
    return stmt.globalDaily.get(at - DAY_MS).total;
  }

  /** Σ non-terminal withdrawal amounts (solvency: still-owed outflow). */
  function pendingTotalRaw() {
    return stmt.pendingTotal.get().total;
  }

  function rowsInStates(states) {
    for (const s of states) {
      if (!WITHDRAWAL_STATES.includes(s)) throw new LedgerError(`unknown state ${s}`);
    }
    const q = prepareBig(
      `SELECT * FROM withdrawals WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`,
    );
    return q.all(...states).map(rowToWithdrawal);
  }

  function listWithdrawals(userId, limit = 20) {
    return stmt.listForUser.all(userId, limit).map(rowToWithdrawal);
  }

  // --- users (shared gateway db; guarded — table may be absent in tests) -----

  function getUsername(userId) {
    try {
      const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
      return row?.username ?? null;
    } catch {
      return null;
    }
  }

  function listUsernames() {
    try {
      return db.prepare('SELECT username FROM users').all().map((r) => r.username);
    } catch {
      return [];
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
    // journal
    postEntry,
    hasEntry,
    accountBalance,
    // withdrawals
    createWithdrawal,
    getWithdrawal,
    getWithdrawalByKey,
    transition,
    recordDebit,
    recordRefund,
    hasInFlight,
    userDailyTotalRaw,
    globalDailyTotalRaw,
    pendingTotalRaw,
    rowsInStates,
    listWithdrawals,
    // users
    getUsername,
    listUsernames,
    close,
  };
}
