// routes.js — /api/token router (session Bearer required) + token config
// loader + production composition root for the whole token module.
import express from 'express';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createLedger,
  formatRawAmount,
  parseAmountToRaw,
  parseLooseAmountToRaw,
} from './ledger.js';
import { createBridgeClient } from './bridge-client.js';
import { createChain } from './solana.js';
import { createWorker } from './worker.js';

/**
 * Read the token .env keys (config.js is owned by the auth area — token env
 * lives here). Cap values are whole-MUCHU decimal strings in .env; raw BigInt
 * equivalents are precomputed.
 * @param {string} [rootDir] repo root containing .env
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadTokenConfig(rootDir, env = process.env) {
  if (rootDir) {
    try {
      process.loadEnvFile(path.join(rootDir, '.env')); // no-op for already-set keys
    } catch {
      // no .env — rely on process.env / defaults
    }
  }
  const decimals = toInt(env.MUCHU_DECIMALS, 6);
  const caps = {
    withdrawMin: env.WITHDRAW_MIN || '10',
    withdrawMaxPerTx: env.WITHDRAW_MAX_PER_TX || '1000',
    dailyCapPerUser: env.WITHDRAW_DAILY_CAP_PER_USER || '500',
    globalDailyCap: env.WITHDRAW_GLOBAL_DAILY_CAP || '5000',
  };
  return {
    cluster: env.SOLANA_CLUSTER || 'devnet',
    rpcUrl: env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    mint: env.MUCHU_MINT || null,
    decimals,
    treasuryKeypairPath: env.TREASURY_KEYPAIR_PATH || '',
    bridgeUrl: `http://127.0.0.1:${toInt(env.BRIDGE_PORT, 8091)}`,
    bridgeToken: env.BRIDGE_TOKEN || '',
    withdrawalsEnabled: (env.WITHDRAWALS_ENABLED ?? 'true').toLowerCase() !== 'false',
    ...caps,
    withdrawMinRaw: parseAmountToRaw(caps.withdrawMin, decimals),
    withdrawMaxPerTxRaw: parseAmountToRaw(caps.withdrawMaxPerTx, decimals),
    dailyCapPerUserRaw: parseAmountToRaw(caps.dailyCapPerUser, decimals),
    globalDailyCapRaw: parseAmountToRaw(caps.globalDailyCap, decimals),
  };
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return m ? m[1].trim() : null;
}

/** Express 4 does not forward async rejections — route them to the JSON 500. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * @param {{db: object, ledger: object, bridge: object, worker: object, tokenConfig: object}} deps
 * @returns {import('express').Router}
 */
export function createTokenRoutes({ db, ledger, bridge, worker, tokenConfig }) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  // Every token route needs a valid wallet-backed session — except that a
  // GET /status carrying NO Bearer at all answers with a PUBLIC subset
  // (cluster + mint: no balances, wallets, or caps) so the landing page can
  // render its honest "devnet beta" badge (SPEC-PHASE3 §3). When deposits are
  // attached, their router additionally merges the public {deposit: {address,
  // minimum, gateThreshold}} block into this subset for the /deposit page
  // (see deposits.js createDepositRoutes). A presented but invalid/expired
  // token still 401s (the launcher relies on that).
  router.use((req, res, next) => {
    const token = bearerToken(req);
    const info = token ? db.getSessionInfo(token) : null;
    if (!info) {
      if (!token && req.method === 'GET' && req.path === '/status') {
        return res.json({ cluster: tokenConfig.cluster, mint: tokenConfig.mint });
      }
      return res.status(401).json({ error: 'Missing, expired, or revoked session token.' });
    }
    req.session = info;
    next();
  });

  const dec = tokenConfig.decimals;
  const fmt = (raw) => formatRawAmount(raw, dec);

  // GET /status — balance, withdrawability, caps, treasury health.
  router.get('/status', asyncRoute(async (req, res) => {
    const { userId, username, address } = req.session;
    const nowMs = Date.now();
    let balance = null;
    let bridgeOk = true;
    try {
      balance = await bridge.balance(username);
    } catch (err) {
      if (err?.code === 'NOT_FOUND') balance = '0'; // never joined yet
      else bridgeOk = false;
    }
    const userUsed = ledger.userDailyTotalRaw(userId, nowMs);
    const globalUsed = ledger.globalDailyTotalRaw(nowMs);
    const ws = worker.status();

    let withdrawable = true;
    let reason = null;
    if (ws.paused) {
      withdrawable = false;
      reason = ws.reason ?? 'withdrawals are paused';
    } else if (!bridgeOk) {
      withdrawable = false;
      reason = 'in-game bridge unreachable';
    } else if (ledger.hasInFlight(userId)) {
      withdrawable = false;
      reason = 'a withdrawal is already in progress';
    } else if (userUsed >= tokenConfig.dailyCapPerUserRaw) {
      withdrawable = false;
      reason = 'daily withdrawal cap reached';
    } else if (globalUsed >= tokenConfig.globalDailyCapRaw) {
      withdrawable = false;
      reason = 'global daily withdrawal cap reached';
    }

    res.json({
      balance,
      withdrawable,
      ...(reason ? { reason } : {}),
      caps: {
        min: tokenConfig.withdrawMin,
        maxPerTx: tokenConfig.withdrawMaxPerTx,
        dailyPerUser: tokenConfig.dailyCapPerUser,
        globalDaily: tokenConfig.globalDailyCap,
        userUsedToday: fmt(userUsed),
        globalUsedToday: fmt(globalUsed),
      },
      treasury: { ok: ws.solvent !== false },
      cluster: tokenConfig.cluster,
      mint: tokenConfig.mint,
      boundWallet: address,
    });
  }));

  // POST /withdraw {amount:"25"} → 202 {withdrawalId}. Destination is ALWAYS
  // the session's bound wallet — nothing in the body can redirect it.
  router.post('/withdraw', asyncRoute(async (req, res) => {
    const { userId, username, address } = req.session;
    const nowMs = Date.now();

    let raw;
    try {
      raw = parseAmountToRaw(req.body?.amount, tokenConfig.decimals);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (raw <= 0n) {
      return res.status(400).json({ error: 'amount must be greater than zero' });
    }

    // Idempotent replay: a known key returns the ORIGINAL withdrawal (202)
    // before any freshness checks — retries must not 409 on themselves.
    const headerKey = req.get('idempotency-key');
    const bodyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null;
    const providedKey = headerKey || bodyKey || null;
    if (providedKey) {
      const existing = ledger.getWithdrawalByKey(providedKey);
      if (existing) {
        if (existing.userId !== userId || existing.amountRaw !== raw) {
          return res.status(409).json({ error: 'idempotency key already used with different parameters' });
        }
        return res.status(202).json({ withdrawalId: existing.id, state: existing.state });
      }
    }

    const ws = worker.status();
    if (ws.paused) {
      return res.status(503).json({ error: `withdrawals are paused: ${ws.reason}` });
    }

    // Balance first (409 insufficient), then min/max (400), then caps (429).
    let balRaw;
    try {
      balRaw = parseLooseAmountToRaw(await bridge.balance(username), tokenConfig.decimals);
    } catch (err) {
      if (err?.code === 'NOT_FOUND') balRaw = 0n;
      else return res.status(503).json({ error: 'in-game bridge unreachable, try again shortly' });
    }
    if (balRaw < raw) {
      return res.status(409).json({ error: 'insufficient in-game balance' });
    }
    if (raw < tokenConfig.withdrawMinRaw) {
      return res.status(400).json({ error: `minimum withdrawal is ${tokenConfig.withdrawMin} MUCHU` });
    }
    if (raw > tokenConfig.withdrawMaxPerTxRaw) {
      return res.status(400).json({
        error: `maximum per withdrawal is ${tokenConfig.withdrawMaxPerTx} MUCHU`,
      });
    }
    if (ledger.userDailyTotalRaw(userId, nowMs) + raw > tokenConfig.dailyCapPerUserRaw) {
      return res.status(429).json({
        error: `daily withdrawal cap is ${tokenConfig.dailyCapPerUser} MUCHU per player`,
      });
    }
    if (ledger.globalDailyTotalRaw(nowMs) + raw > tokenConfig.globalDailyCapRaw) {
      return res.status(429).json({ error: 'global daily withdrawal cap reached, try tomorrow' });
    }
    if (ledger.hasInFlight(userId)) {
      return res.status(409).json({ error: 'a withdrawal is already in progress' });
    }

    const idempotencyKey = providedKey || randomBytes(16).toString('hex');
    let created;
    try {
      created = ledger.createWithdrawal({
        idempotencyKey,
        userId,
        destAddress: address, // bound wallet, by construction
        amountRaw: raw,
        at: nowMs,
      });
    } catch (err) {
      if (err?.code === 'IN_FLIGHT') {
        return res.status(409).json({ error: 'a withdrawal is already in progress' });
      }
      throw err;
    }
    const { withdrawal, deduped } = created;
    if (deduped && (withdrawal.userId !== userId || withdrawal.amountRaw !== raw)) {
      return res.status(409).json({ error: 'idempotency key already used with different parameters' });
    }
    if (!deduped) worker.kick();
    res.status(202).json({ withdrawalId: withdrawal.id, state: withdrawal.state });
  }));

  // GET /withdrawals — recent list incl. state + signature (newest first).
  // Body is a JSON ARRAY (a "recent list", decimal strings at the boundary).
  router.get('/withdrawals', (req, res) => {
    const rows = ledger.listWithdrawals(req.session.userId, 20);
    res.json(rows.map((r) => ({
      id: r.id,
      amount: fmt(r.amountRaw),
      amountRaw: r.amountRaw.toString(),
      state: r.state,
      signature: r.signature,
      destAddress: r.destAddress,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })));
  });

  // Async error safety net (JSON, never HTML).
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[token] route error:', err.message);
    res.status(500).json({ error: 'internal token service error' });
  });

  return router;
}

/**
 * Production wiring: ledger (own WAL connection on the shared db file) +
 * bridge client + chain + worker + router.
 * @param {{config: {dbPath: string}, tokenConfig: object, db: object}} deps
 */
export function createTokenModule({ config, tokenConfig, db }) {
  const ledger = createLedger({ dbPath: config.dbPath });
  const bridge = createBridgeClient({
    baseUrl: tokenConfig.bridgeUrl,
    token: tokenConfig.bridgeToken,
  });
  const chain = createChain(tokenConfig);
  const worker = createWorker({ ledger, bridge, chain, tokenConfig });
  const router = createTokenRoutes({ db, ledger, bridge, worker, tokenConfig });
  return {
    router,
    worker,
    ledger,
    close() {
      worker.stop();
      ledger.close();
    },
  };
}
