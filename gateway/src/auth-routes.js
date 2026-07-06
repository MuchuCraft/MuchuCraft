// auth-routes.js — /api/auth router: nonce, verify, session, username lookup,
// skin (SPEC-PHASE3.md §4).
import express from 'express';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { buildMessage, verifySiws } from './siws.js';
import { createRcon } from './rcon.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const NONCE_TTL_MS = 5 * 60 * 1000;

const SKIN_MAX_LEN = 300;
const SKIN_NAME_RE = /^name:[A-Za-z0-9_]{3,16}$/;
const SKIN_ERROR =
  'Skin must be "name:<minecraft username>" or "url:<https url ending in .png>" (at most 300 characters).';

/**
 * Validate a skin descriptor (SPEC-PHASE3.md §4):
 *   "name:<mcname>"   — 3-16 chars of [A-Za-z0-9_]
 *   "url:<https url>" — https only, ending in .png, ≤300 chars total
 * The value is later interpolated into a space-delimited RCON console command
 * (`skin set <value> <player>` — see rcon.js buildSkinCommand), so whitespace
 * and non-printable characters are rejected outright.
 * @returns {string|null} the trimmed valid value, or null.
 */
export function validateSkin(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0 || v.length > SKIN_MAX_LEN) return null;
  if (SKIN_NAME_RE.test(v)) return v;
  if (!v.startsWith('url:')) return null;
  const raw = v.slice('url:'.length);
  if (!/^[\x21-\x7e]+$/.test(raw)) return null; // printable ASCII, no spaces
  if (!raw.toLowerCase().endsWith('.png')) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? v : null;
}

/** Tiny in-memory fixed-window rate limiter (per IP, per minute). */
function fixedWindow(limit, windowMs = 60_000) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    const bucket = Math.floor(Date.now() / windowMs);
    if (hits.size > 5000) {
      for (const key of hits.keys()) {
        if (!key.endsWith(`:${bucket}`)) hits.delete(key);
      }
    }
    const key = `${req.ip}:${bucket}`;
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    if (count > limit) {
      return res.status(429).json({ error: 'Too many requests, slow down and retry shortly.' });
    }
    next();
  };
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

function isValidAddress(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

/**
 * @param {{config: object, db: object, limits?: {strict?: number, relaxed?: number}, rcon?: {applySkin(username: string, skin: string): void}}} deps
 * `rcon` is an injection point for tests; production callers omit it and get
 * the best-effort default (lazy connect, never throws — see rcon.js).
 * @returns {import('express').Router}
 */
export function createAuthRoutes({ config, db, limits = {}, rcon = null }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // Used by POST /skin to apply a new skin immediately when the player is
  // already online (the join-time apply in netproxy.js covers everyone else).
  const skinRcon =
    rcon ?? createRcon({ host: '127.0.0.1', port: config.rconPort, password: config.rconPassword });

  // 10/min shared across nonce+verify; 60/min for the rest (per SPEC).
  const strictLimit = fixedWindow(limits.strict ?? 10);
  const relaxedLimit = fixedWindow(limits.relaxed ?? 60);

  // POST /nonce {username, address} -> {message, nonce, expiresAt, mode}
  router.post('/nonce', strictLimit, (req, res) => {
    const { username, address } = req.body ?? {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-16 characters: letters, digits, underscore.' });
    }
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Address must be a valid base58-encoded 32-byte Solana public key.' });
    }
    const existing = db.getUserByName(username);
    if (existing && existing.address !== address) {
      return res.status(409).json({ error: 'That username is already claimed by a different wallet.' });
    }
    const now = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = now + NONCE_TTL_MS;
    const message = buildMessage({
      domain: config.siwsDomain,
      uri: config.siwsUri,
      address,
      username,
      nonce,
      issuedAt: now,
      expiresAt,
    });
    db.createNonce({ nonce, username, address, message, expiresAt });
    res.json({ message, nonce, expiresAt, mode: existing ? 'login' : 'register' });
  });

  // POST /verify {nonce, address, signature, signedMessage?} -> session
  router.post('/verify', strictLimit, (req, res) => {
    const { nonce, address, signature, signedMessage } = req.body ?? {};
    if (typeof nonce !== 'string' || typeof address !== 'string' || signature == null) {
      return res.status(400).json({ error: 'nonce, address and signature are required.' });
    }
    // Single use: consumed atomically on the FIRST verify attempt, success OR failure.
    const record = db.consumeNonce(nonce);
    if (!record) {
      return res.status(400).json({ error: 'Nonce is unknown, expired, or already used. Request a new one.' });
    }
    if (record.address !== address) {
      return res.status(400).json({ error: 'Address does not match the wallet this nonce was issued to.' });
    }
    const ok = verifySiws({ message: record.message, address, signature, signedMessage });
    if (!ok) {
      return res.status(401).json({ error: 'Signature verification failed.' });
    }
    const user = db.claimUsername(record.username, address);
    if (!user) {
      return res.status(409).json({ error: 'That username was just claimed by a different wallet.' });
    }
    const { token, expiresAt } = db.createSession(user.id, config.sessionTtlHours * 3_600_000);
    const playUrl =
      `/?ip=${config.publicServerAddress || `${config.mcHost}:${config.mcPort}`}` +
      `&version=${encodeURIComponent(config.clientMcVersion || config.mcVersion)}` +
      `&username=${encodeURIComponent(user.username)}` +
      `&token=${token}&autoConnect=true&lockConnect=true`;
    console.log(`[auth] verified ${user.username} (${address.slice(0, 4)}…${address.slice(-4)})`);
    res.json({ token, username: user.username, address, expiresAt, playUrl });
  });

  // GET /session (Bearer) -> {username, address, expiresAt, skin} | 401
  router.get('/session', relaxedLimit, (req, res) => {
    const token = bearerToken(req);
    const info = token ? db.getSessionInfo(token) : null;
    if (!info) {
      return res.status(401).json({ error: 'Missing, expired, or revoked session token.' });
    }
    res.json({
      username: info.username,
      address: info.address,
      expiresAt: info.expiresAt,
      skin: info.skin ?? null,
    });
  });

  // POST /skin (Bearer) {skin: "name:<mcname>" | "url:<https .png>" | null}
  // -> {skin}. null (or "") clears the stored skin. On success the skin is
  // applied on every future join; if the player is online right now the RCON
  // command applies it immediately (best-effort).
  router.post('/skin', relaxedLimit, (req, res) => {
    const token = bearerToken(req);
    const info = token ? db.getSessionInfo(token) : null;
    if (!info) {
      return res.status(401).json({ error: 'Missing, expired, or revoked session token.' });
    }
    const { skin } = req.body ?? {};
    if (skin === null || skin === '') {
      db.setUserSkin(info.userId, null);
      return res.json({ skin: null });
    }
    const valid = validateSkin(skin);
    if (!valid) {
      return res.status(400).json({ error: SKIN_ERROR });
    }
    db.setUserSkin(info.userId, valid);
    console.log(`[auth] skin set for ${info.username}: ${valid}`);
    skinRcon.applySkin?.(info.username, valid); // fire-and-forget, never throws
    res.json({ skin: valid });
  });

  // GET /username/:name -> {status: available|taken|yours, registered}
  router.get('/username/:name', relaxedLimit, (req, res) => {
    const name = req.params.name;
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: 'Username must be 3-16 characters: letters, digits, underscore.' });
    }
    const user = db.getUserByName(name);
    if (!user) {
      return res.json({ status: 'available', registered: false });
    }
    const token = bearerToken(req);
    const info = token ? db.getSessionInfo(token) : null;
    const yours = info != null && info.userId === user.id;
    res.json({ status: yours ? 'yours' : 'taken', registered: true });
  });

  return router;
}
