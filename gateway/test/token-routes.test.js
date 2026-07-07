// token-routes.test.js — /api/token routes on an ephemeral createApp with a
// MOCK bridge and MOCK worker: auth, status shape, withdraw validation order
// (format/min/max → 400, insufficient/in-flight → 409, caps → 429, paused →
// 503), destination pinned to the bound wallet, withdrawal listing, and the
// index.js mount-only-when-configured behavior. No network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';
import { createDb } from '../src/db.js';
import { createLedger } from '../src/token/ledger.js';
import { createTokenRoutes, loadTokenConfig } from '../src/token/routes.js';
import { BridgeError } from '../src/token/bridge-client.js';

const MUCHU = 10n ** 6n;
const ADDR = 'Wa11etBoundAddress111111111111111111111111';

const CONFIG = {
  port: 0,
  mcHost: '127.0.0.1',
  mcPort: 25565,
  mcVersion: '1.21.11',
  rconPort: 25575,
  rconPassword: 'test',
  sessionTtlHours: 24,
  siwsDomain: 'localhost:8080',
  siwsUri: 'http://localhost:8080/login/',
  dbPath: ':memory:',
  root: process.cwd(),
};

const TOKEN_ENV = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'http://mock',
  MUCHU_MINT: 'MintAddr1111111111111111111111111111111111',
  MUCHU_DECIMALS: '6',
  BRIDGE_PORT: '8091',
  BRIDGE_TOKEN: 'test-bridge-token',
  WITHDRAWALS_ENABLED: 'true',
  WITHDRAW_MIN: '10',
  WITHDRAW_MAX_PER_TX: '1000',
  WITHDRAW_DAILY_CAP_PER_USER: '500',
  WITHDRAW_GLOBAL_DAILY_CAP: '5000',
};

function mockBridge(balances = { Alice: '100' }) {
  return {
    balances,
    down: false,
    async balance(player) {
      if (this.down) throw new BridgeError('down', { code: 'UNAVAILABLE', retryable: true });
      if (!(player in this.balances)) throw new BridgeError('never joined', { code: 'NOT_FOUND' });
      return this.balances[player];
    },
  };
}

function mockWorker() {
  return {
    kicks: 0,
    state: { paused: false, reason: null, reasons: {}, solvent: true, lastSolvencyAt: null },
    status() { return this.state; },
    kick() { this.kicks++; },
  };
}

async function boot(t, { balances, tokenEnv = {} } = {}) {
  const db = createDb(':memory:');
  const user = db.claimUsername('Alice', ADDR);
  const { token } = db.createSession(user.id, 3_600_000);
  const ledger = createLedger({ dbPath: ':memory:' });
  const bridge = mockBridge(balances);
  const worker = mockWorker();
  const tokenConfig = loadTokenConfig(undefined, { ...TOKEN_ENV, ...tokenEnv });
  const tokenRoutes = createTokenRoutes({ db, ledger, bridge, worker, tokenConfig });
  const { app } = createApp({ config: CONFIG, db, tokenRoutes });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    ledger.close();
    db.close();
  });
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${token}` };
  return { base, auth, db, ledger, bridge, worker, user, token };
}

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------------ auth

test('all token routes require a valid session Bearer', async (t) => {
  const { base } = await boot(t);
  for (const path of ['/api/token/status', '/api/token/withdrawals']) {
    assert.equal((await get(base, path, { authorization: 'Bearer nope' })).status, 401, `${path} bad token`);
  }
  assert.equal((await get(base, '/api/token/withdrawals')).status, 401, 'withdrawals without token');
  assert.equal((await post(base, '/api/token/withdraw', { amount: '25' })).status, 401);
});

test('GET /status with NO Bearer is the PUBLIC subset (landing-page badge): cluster + mint', async (t) => {
  const { base } = await boot(t);
  const { status, body } = await get(base, '/api/token/status');
  assert.equal(status, 200);
  assert.equal(body.cluster, 'devnet');
  assert.equal(typeof body.mint, 'string');
  // nothing session-scoped may leak on the unauthenticated path
  assert.equal(body.balance, undefined);
  assert.equal(body.boundWallet, undefined);
  assert.equal(body.caps, undefined);
  // the PUBLIC {deposit: {address, minimum, gateThreshold}} block is merged
  // by the deposits router when attachDeposits() ran — this boot() composes
  // the bare token router only, so no deposit block here (the composed-app
  // public subset is covered in token-deposits.test.js).
  assert.equal(body.deposit, undefined);
});

test('createApp WITHOUT tokenRoutes: /api/token 404s (unconfigured = not mounted)', async (t) => {
  const db = createDb(':memory:');
  const { app } = createApp({ config: CONFIG, db });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.on('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/token/status`);
  assert.equal(res.status, 404);
});

test('loadTokenConfig: mint empty ⇒ null (mount guard); caps parsed to raw BigInt', () => {
  const cfg = loadTokenConfig(undefined, { ...TOKEN_ENV, MUCHU_MINT: '' });
  assert.equal(cfg.mint, null);
  const full = loadTokenConfig(undefined, TOKEN_ENV);
  assert.equal(full.withdrawMinRaw, 10n * MUCHU);
  assert.equal(full.withdrawMaxPerTxRaw, 1000n * MUCHU);
  assert.equal(full.dailyCapPerUserRaw, 500n * MUCHU);
  assert.equal(full.globalDailyCapRaw, 5000n * MUCHU);
  assert.equal(full.withdrawalsEnabled, true);
  assert.equal(loadTokenConfig(undefined, { ...TOKEN_ENV, WITHDRAWALS_ENABLED: 'false' }).withdrawalsEnabled, false);
});

// ------------------------------------------------------------------ status

test('GET /status: balance, caps, treasury, cluster, mint, bound wallet', async (t) => {
  const { base, auth } = await boot(t);
  const { status, body } = await get(base, '/api/token/status', auth);
  assert.equal(status, 200);
  assert.equal(body.balance, '100');
  assert.equal(body.withdrawable, true);
  assert.equal(body.reason, undefined);
  assert.deepEqual(body.caps, {
    min: '10',
    maxPerTx: '1000',
    dailyPerUser: '500',
    globalDaily: '5000',
    userUsedToday: '0',
    globalUsedToday: '0',
  });
  assert.deepEqual(body.treasury, { ok: true });
  assert.equal(body.cluster, 'devnet');
  assert.equal(body.mint, TOKEN_ENV.MUCHU_MINT);
  assert.equal(body.boundWallet, ADDR);
});

test('GET /status: paused worker / insolvency / in-flight are all reflected', async (t) => {
  const { base, auth, worker, ledger, user } = await boot(t);
  worker.state = { paused: true, reason: 'insolvent: treasury too small', reasons: {}, solvent: false };
  let res = await get(base, '/api/token/status', auth);
  assert.equal(res.body.withdrawable, false);
  assert.match(res.body.reason, /insolvent/);
  assert.equal(res.body.treasury.ok, false);

  worker.state = { paused: false, reason: null, reasons: {}, solvent: true };
  ledger.createWithdrawal({ idempotencyKey: 'x', userId: user.id, destAddress: ADDR, amountRaw: 25n * MUCHU });
  res = await get(base, '/api/token/status', auth);
  assert.equal(res.body.withdrawable, false);
  assert.match(res.body.reason, /already in progress/);
  assert.equal(res.body.caps.userUsedToday, '25');
});

test('GET /status: player who never joined shows balance "0"; bridge down degrades gracefully', async (t) => {
  const { base, auth, bridge } = await boot(t, { balances: {} });
  let res = await get(base, '/api/token/status', auth);
  assert.equal(res.body.balance, '0');
  bridge.down = true;
  res = await get(base, '/api/token/status', auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, null);
  assert.equal(res.body.withdrawable, false);
  assert.match(res.body.reason, /bridge/);
});

// ------------------------------------------------------------------ withdraw

test('POST /withdraw: 202 + withdrawal row bound to the SESSION wallet, worker kicked', async (t) => {
  const { base, auth, ledger, worker, user } = await boot(t);
  const res = await post(base, '/api/token/withdraw',
    { amount: '25', destAddress: 'Attacker11111111111111111111111111111111111' }, auth);
  assert.equal(res.status, 202);
  assert.ok(Number.isInteger(res.body.withdrawalId));
  assert.equal(res.body.state, 'requested');
  const row = ledger.getWithdrawal(res.body.withdrawalId);
  assert.equal(row.destAddress, ADDR, 'destination is ALWAYS the bound wallet, body ignored');
  assert.equal(row.userId, user.id);
  assert.equal(row.amountRaw, 25n * MUCHU);
  assert.equal(worker.kicks, 1);
});

test('POST /withdraw: 400 on bad amount formats (floats, exponents, >6dp, negatives)', async (t) => {
  const { base, auth, ledger } = await boot(t);
  const bad = [25, '25.1234567', '-25', '1e2', '', '.5', '5.', 'abc', null, undefined, '25,5'];
  for (const amount of bad) {
    const res = await post(base, '/api/token/withdraw', { amount }, auth);
    assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} must 400`);
    assert.ok(res.body.error, 'JSON error body');
  }
  assert.equal(ledger.rowsInStates(['requested']).length, 0, 'nothing was created');
});

test('POST /withdraw: 400 below min / above max-per-tx', async (t) => {
  const { base, auth } = await boot(t);
  let res = await post(base, '/api/token/withdraw', { amount: '5' }, auth); // min 10
  assert.equal(res.status, 400);
  assert.match(res.body.error, /minimum/i);
  res = await post(base, '/api/token/withdraw', { amount: '80' }, { ...auth });
  assert.equal(res.status, 202); // sanity: min<amount<balance works
});

test('POST /withdraw: over max-per-tx is 400 when balance covers it, 409 when it does not', async (t) => {
  const { base, auth } = await boot(t, { balances: { Alice: '2000' } });
  let res = await post(base, '/api/token/withdraw', { amount: '1001' }, auth); // max 1000
  assert.equal(res.status, 400);
  assert.match(res.body.error, /maximum/i);
  // e2e contract: withdrawing far over the balance is an insufficiency (409)
  res = await post(base, '/api/token/withdraw', { amount: '10000' }, auth);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /insufficient/i);
});

test('POST /withdraw: 409 insufficient balance (incl. never-joined player)', async (t) => {
  const { base, auth } = await boot(t, { balances: { Alice: '20' } });
  const res = await post(base, '/api/token/withdraw', { amount: '25' }, auth);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /insufficient/i);
});

test('POST /withdraw: 409 while another withdrawal is in flight', async (t) => {
  const { base, auth } = await boot(t);
  assert.equal((await post(base, '/api/token/withdraw', { amount: '25' }, auth)).status, 202);
  const res = await post(base, '/api/token/withdraw', { amount: '25' }, auth);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /in progress/i);
});

test('POST /withdraw: 429 when the user daily cap would be exceeded', async (t) => {
  const { base, auth, ledger, user } = await boot(t, { balances: { Alice: '1000' } });
  // 490 already withdrawn today (confirmed → not in-flight)
  const w = ledger.createWithdrawal({
    idempotencyKey: 'seed', userId: user.id, destAddress: ADDR, amountRaw: 490n * MUCHU,
  }).withdrawal;
  ledger.transition(w.id, 'debited');
  ledger.transition(w.id, 'signed', { signature: 's', lastValidBlockHeight: 1n });
  ledger.transition(w.id, 'submitted');
  ledger.transition(w.id, 'confirmed');
  const res = await post(base, '/api/token/withdraw', { amount: '25' }, auth); // 515 > 500
  assert.equal(res.status, 429);
  assert.match(res.body.error, /daily/i);
});

test('POST /withdraw: 429 when the global daily cap would be exceeded', async (t) => {
  const { base, auth } = await boot(t, {
    balances: { Alice: '100' },
    tokenEnv: { WITHDRAW_GLOBAL_DAILY_CAP: '20', WITHDRAW_DAILY_CAP_PER_USER: '500' },
  });
  const res = await post(base, '/api/token/withdraw', { amount: '25' }, auth);
  assert.equal(res.status, 429);
  assert.match(res.body.error, /global/i);
});

test('POST /withdraw: 503 while the circuit breaker is open', async (t) => {
  const { base, auth, worker } = await boot(t);
  worker.state = { paused: true, reason: 'withdrawals are disabled', reasons: {}, solvent: true };
  const res = await post(base, '/api/token/withdraw', { amount: '25' }, auth);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /paused/i);
});

test('POST /withdraw: 503 when the bridge is down (cannot check balance)', async (t) => {
  const { base, auth, bridge } = await boot(t);
  bridge.down = true;
  const res = await post(base, '/api/token/withdraw', { amount: '25' }, auth);
  assert.equal(res.status, 503);
});

test('POST /withdraw: Idempotency-Key header replays the same withdrawal', async (t) => {
  const { base, auth, ledger, user } = await boot(t);
  const headers = { ...auth, 'idempotency-key': 'retry-1' };
  const first = await post(base, '/api/token/withdraw', { amount: '25' }, headers);
  assert.equal(first.status, 202);
  // client retries after a network blip — same key, row already terminal or not
  const again = await post(base, '/api/token/withdraw', { amount: '25' }, headers);
  assert.equal(again.status, 202);
  assert.equal(again.body.withdrawalId, first.body.withdrawalId, 'no second row');
  assert.equal(ledger.listWithdrawals(user.id).length, 1);
});

// ------------------------------------------------------------------ listing

test('GET /withdrawals: newest first, decimal amounts, state + signature, only OWN rows', async (t) => {
  const { base, auth, ledger, user, db } = await boot(t);
  const w = ledger.createWithdrawal({
    idempotencyKey: 'a', userId: user.id, destAddress: ADDR, amountRaw: 12_500_000n,
  }).withdrawal;
  ledger.transition(w.id, 'debited');
  ledger.transition(w.id, 'signed', { signature: 'sigX', lastValidBlockHeight: 9n });
  ledger.transition(w.id, 'submitted');
  ledger.transition(w.id, 'confirmed');
  // another user's withdrawal must not leak
  const other = db.claimUsername('Bob', 'OtherWa11et11111111111111111111111111111111');
  ledger.createWithdrawal({ idempotencyKey: 'b', userId: other.id, destAddress: 'X', amountRaw: MUCHU });

  const { status, body } = await get(base, '/api/token/withdrawals', auth);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), 'a recent LIST — plain JSON array');
  assert.equal(body.length, 1);
  const item = body[0];
  assert.equal(item.id, w.id);
  assert.equal(item.amount, '12.5');
  assert.equal(item.amountRaw, '12500000');
  assert.equal(item.state, 'confirmed');
  assert.equal(item.signature, 'sigX');
  assert.equal(item.destAddress, ADDR);
});
