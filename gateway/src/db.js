// db.js — node:sqlite (DatabaseSync) storage: users, nonces, sessions.
// All timestamps are ms epoch. No ORM: small explicit functions only.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT UNIQUE COLLATE NOCASE,
  address       TEXT NOT NULL,
  created_at    INTEGER,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  username   TEXT,
  address    TEXT,
  message    TEXT,
  expires_at INTEGER,
  used       INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  created_at INTEGER,
  expires_at INTEGER,
  revoked    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_nonces_expires  ON nonces(expires_at);
`;

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Open (or create) the database and return small explicit accessor functions.
 * @param {string} dbPath file path, or ':memory:' for tests
 */
export function createDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // :memory: or FS without WAL support — non-fatal
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  // --- additive migrations (guarded, idempotent) ----------------------------
  // SPEC-PHASE3.md §4: users.skin holds "name:<mcname>" | "url:<https .png>"
  // or NULL. ALTER TABLE only when the column is missing (PRAGMA table_info
  // check), so re-opening an already-migrated DB is a no-op.
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((col) => col.name === 'skin')) {
    db.exec('ALTER TABLE users ADD COLUMN skin TEXT NULL');
  }

  const stmt = {
    insertNonce: db.prepare(
      'INSERT INTO nonces (nonce, username, address, message, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)',
    ),
    getNonce: db.prepare('SELECT * FROM nonces WHERE nonce = ?'),
    // Atomic single-use consumption: only one caller can flip used 0 -> 1.
    useNonce: db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0'),
    getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, address, created_at) VALUES (?, ?, ?)'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)',
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    getSessionInfo: db.prepare(
      `SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username AS username, u.address AS address, u.skin AS skin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.revoked = 0 AND s.expires_at > ?`,
    ),
    setSkin: db.prepare('UPDATE users SET skin = ? WHERE id = ?'),
    revokeSession: db.prepare('UPDATE sessions SET revoked = 1 WHERE token = ?'),
    cleanNonces: db.prepare('DELETE FROM nonces WHERE expires_at <= ? OR used = 1'),
    cleanSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked = 1'),
  };

  // --- nonces -------------------------------------------------------------

  function createNonce({ nonce, username, address, message, expiresAt }) {
    stmt.insertNonce.run(nonce, username, address, message, expiresAt);
    return { nonce, username, address, message, expiresAt };
  }

  /**
   * Atomically consume a nonce (single use). Returns the nonce row if this
   * caller won the consume race AND the nonce is not expired; otherwise null.
   */
  function consumeNonce(nonce, now = Date.now()) {
    if (typeof nonce !== 'string' || nonce.length === 0) return null;
    const { changes } = stmt.useNonce.run(nonce);
    if (changes !== 1) return null; // unknown or already used
    const row = stmt.getNonce.get(nonce);
    if (!row || row.expires_at <= now) return null; // consumed but expired
    return row;
  }

  // --- users --------------------------------------------------------------

  function getUserByName(username) {
    return stmt.getUserByName.get(username) ?? null;
  }

  /**
   * First successful verify claims the username for that wallet (unique,
   * case-insensitive). Returns the user row, or null if the username is
   * already bound to a different wallet.
   */
  function claimUsername(username, address, now = Date.now()) {
    const existing = getUserByName(username);
    if (existing) {
      return existing.address === address ? existing : null;
    }
    try {
      const { lastInsertRowid } = stmt.insertUser.run(username, address, now);
      return stmt.getUserById.get(lastInsertRowid);
    } catch {
      // Lost a UNIQUE race — re-check ownership.
      const raced = getUserByName(username);
      return raced && raced.address === address ? raced : null;
    }
  }

  /**
   * Store (or clear with null) the user's skin descriptor — already validated
   * by the caller (auth-routes validateSkin). Returns true iff a row changed.
   */
  function setUserSkin(userId, skin) {
    return stmt.setSkin.run(skin ?? null, userId).changes === 1;
  }

  /**
   * Bump users.last_login_at. Returns { firstLogin } — true only on the very
   * first login of that user. Synchronous (proxy contract).
   */
  function markLogin(userId, now = Date.now()) {
    const user = stmt.getUserById.get(userId);
    if (!user) return { firstLogin: false };
    stmt.touchLogin.run(now, userId);
    return { firstLogin: user.last_login_at == null };
  }

  // --- sessions -----------------------------------------------------------

  function createSession(userId, ttlMs, now = Date.now()) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + ttlMs;
    stmt.insertSession.run(token, userId, now, expiresAt);
    return { token, expiresAt };
  }

  function getSession(token) {
    return stmt.getSession.get(token) ?? null;
  }

  /**
   * Proxy-facing lookup: null | { userId, username, address, skin, expiresAt }.
   * Already checks expiry + revocation. Synchronous (proxy contract).
   */
  function getSessionInfo(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length === 0) return null;
    return stmt.getSessionInfo.get(token, now) ?? null;
  }

  function revokeSession(token) {
    return stmt.revokeSession.run(token).changes === 1;
  }

  // --- maintenance ----------------------------------------------------------

  function cleanup(now = Date.now()) {
    const nonces = stmt.cleanNonces.run(now).changes;
    const sessions = stmt.cleanSessions.run(now).changes;
    return { nonces, sessions };
  }

  const timer = setInterval(() => {
    try {
      cleanup();
    } catch (err) {
      console.warn('[auth] db cleanup failed:', err.message);
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();

  function close() {
    clearInterval(timer);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return {
    createNonce,
    consumeNonce,
    getUserByName,
    claimUsername,
    setUserSkin,
    markLogin,
    createSession,
    getSession,
    getSessionInfo,
    revokeSession,
    cleanup,
    close,
  };
}
