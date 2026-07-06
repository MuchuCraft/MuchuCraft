// token-worker.test.js — withdrawal worker with a MOCK chain and MOCK bridge:
// full state machine incl. refund path, crash recovery from persisted
// signatures, circuit breaker (env / solvency / global cap), solvency monitor.
// No network, no timers (drain()/checkSolvency() driven explicitly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, formatRawAmount } from '../src/token/ledger.js';
import { createWorker } from '../src/token/worker.js';
import { BridgeError } from '../src/token/bridge-client.js';

const MUCHU = 10n ** 6n;
const DEST = 'DestWa11etAddress11111111111111111111111111';
const QUIET = { log() {}, warn() {}, error() {} };

function baseTokenConfig(extra = {}) {
  return {
    cluster: 'devnet',
    mint: 'MintAddr',
    decimals: 6,
    withdrawalsEnabled: true,
    withdrawMin: '10', withdrawMinRaw: 10n * MUCHU,
    withdrawMaxPerTx: '1000', withdrawMaxPerTxRaw: 1000n * MUCHU,
    dailyCapPerUser: '500', dailyCapPerUserRaw: 500n * MUCHU,
    globalDailyCap: '5000', globalDailyCapRaw: 5000n * MUCHU,
    ...extra,
  };
}

/** Mock bridge with scripted balances and failure injection. */
function mockBridge({ balances = { Alice: '100' }, failDebit = null, failCredit = null } = {}) {
  const calls = { debit: [], credit: [], balances: [] };
  return {
    calls,
    setFailDebit(err) { failDebit = err; },
    setFailCredit(err) { failCredit = err; },
    async balance(player) {
      if (!(player in balances)) throw new BridgeError('never joined', { code: 'NOT_FOUND', status: 404 });
      return balances[player];
    },
    async balances(players) {
      calls.balances.push(players);
      return Object.fromEntries(players.filter((p) => p in balances).map((p) => [p, balances[p]]));
    },
    async debit(args) {
      if (failDebit) throw failDebit;
      calls.debit.push(args);
      return { ok: true, newBalance: '0' };
    },
    async credit(args) {
      if (failCredit) throw failCredit;
      calls.credit.push(args);
      return { ok: true, newBalance: '0' };
    },
  };
}

/**
 * Mock chain. `script` is an array of behaviors consumed per sendWithdrawal
 * call: 'confirm' | 'expire' | 'rpc-down-after-sign' | {failCode}.
 */
function mockChain({ script = ['confirm'], statuses = {}, blockHeight = 100n, treasury = { sol: 10n ** 9n, tokenRaw: 10n ** 12n } } = {}) {
  const state = { script: [...script], statuses, blockHeight, treasury, sigCounter: 0 };
  const calls = { send: [], statusChecks: [] };
  return {
    state,
    calls,
    async getTreasuryState() {
      if (state.treasury instanceof Error) throw state.treasury;
      return state.treasury;
    },
    async getSignatureStatus(sig) {
      calls.statusChecks.push(sig);
      const s = state.statuses[sig];
      if (s instanceof Error) throw s;
      return s ?? null;
    },
    async getCurrentBlockHeight() {
      if (state.blockHeight instanceof Error) throw state.blockHeight;
      return state.blockHeight;
    },
    async sendWithdrawal({ destAddress, rawAmount, onPersistSignature, onSubmitted }) {
      const behavior = state.script.length > 1 ? state.script.shift() : state.script[0];
      const signature = `sig-${++state.sigCounter}`;
      calls.send.push({ destAddress, rawAmount, signature, behavior });
      await onPersistSignature({ signature, lastValidBlockHeight: 150n });
      if (behavior === 'expire') {
        const err = new Error('blockhash expired');
        err.code = 'BLOCKHASH_EXPIRED';
        throw err;
      }
      if (behavior === 'rpc-down-after-sign') {
        const err = new Error('rpc unreachable');
        err.code = 'RPC_UNAVAILABLE';
        throw err;
      }
      await onSubmitted?.();
      if (behavior && behavior.failCode) {
        const err = new Error(behavior.message ?? 'tx failed on-chain');
        err.code = behavior.failCode;
        throw err;
      }
      return { signature, slot: 42n };
    },
  };
}

function fixture(t, { bridge, chain, tokenConfig, usernames = { 1: 'Alice' } } = {}) {
  const ledger = createLedger({ dbPath: ':memory:' });
  t.after(() => ledger.close());
  bridge ??= mockBridge();
  chain ??= mockChain();
  tokenConfig ??= baseTokenConfig();
  const worker = createWorker({
    ledger,
    bridge,
    chain,
    tokenConfig,
    getUsername: (id) => usernames[id] ?? null,
    getUsernames: () => Object.values(usernames),
    log: QUIET,
  });
  return { ledger, bridge, chain, worker, tokenConfig };
}

function requestWithdrawal(ledger, { userId = 1, amount = 25n * MUCHU, key = 'k1' } = {}) {
  return ledger.createWithdrawal({
    idempotencyKey: key, userId, destAddress: DEST, amountRaw: amount,
  }).withdrawal;
}

// ------------------------------------------------------------- happy path

test('happy path: requested → debited(+journal) → signed → submitted → confirmed', async (t) => {
  const { ledger, bridge, chain, worker } = fixture(t);
  const stateLog = [];
  const w = requestWithdrawal(ledger);
  // Snapshot the persisted state at each chain callback moment.
  const origSend = chain.sendWithdrawal;
  chain.sendWithdrawal = (args) => origSend({
    ...args,
    onPersistSignature: async (p) => {
      await args.onPersistSignature(p);
      stateLog.push(`persisted:${ledger.getWithdrawal(w.id).state}`);
    },
    onSubmitted: async () => {
      await args.onSubmitted();
      stateLog.push(`submitted:${ledger.getWithdrawal(w.id).state}`);
    },
  });

  await worker.drain();

  const done = ledger.getWithdrawal(w.id);
  assert.equal(done.state, 'confirmed');
  assert.equal(done.signature, 'sig-1');
  assert.equal(done.lastValidBlockHeight, 150n);
  // signature + lastValidBlockHeight were durably persisted BEFORE first send
  assert.deepEqual(stateLog, ['persisted:signed', 'submitted:submitted']);
  // bridge debit exactly once, with decimal-string amount and audit ref
  assert.equal(bridge.calls.debit.length, 1);
  assert.deepEqual(bridge.calls.debit[0], { player: 'Alice', amount: '25', ref: `withdraw:${w.id}` });
  assert.equal(bridge.calls.credit.length, 0, 'no refund on success');
  // double-entry journal reflects the payout
  assert.ok(ledger.hasEntry(`withdraw:${w.id}:debit`));
  assert.equal(ledger.accountBalance('ingame_liability'), -25n * MUCHU);
  assert.equal(ledger.accountBalance('onchain_outflow'), 25n * MUCHU);
  // chain got the bound destination and raw units
  assert.equal(chain.calls.send[0].destAddress, DEST);
  assert.equal(chain.calls.send[0].rawAmount, 25n * MUCHU);
});

// ------------------------------------------------------------- failure paths

test('insufficient in-game balance at debit time → failed, no refund, no journal', async (t) => {
  const bridge = mockBridge();
  bridge.setFailDebit(new BridgeError('insufficient', { code: 'INSUFFICIENT', status: 409 }));
  const { ledger, worker, chain } = fixture(t, { bridge });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  const row = ledger.getWithdrawal(w.id);
  assert.equal(row.state, 'failed');
  assert.match(row.error, /insufficient/);
  assert.equal(chain.calls.send.length, 0, 'never reached the chain');
  assert.equal(bridge.calls.credit.length, 0, 'nothing was debited ⇒ nothing to refund');
  assert.equal(ledger.hasEntry(`withdraw:${w.id}:debit`), false);
});

test('permanent on-chain failure after debit → refund credit + reversal entry → refunded', async (t) => {
  const chain = mockChain({ script: [{ failCode: 'TX_FAILED', message: 'custom program error' }] });
  const { ledger, bridge, worker } = fixture(t, { chain });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  const row = ledger.getWithdrawal(w.id);
  assert.equal(row.state, 'refunded');
  assert.match(row.error, /custom program error/);
  assert.equal(bridge.calls.credit.length, 1);
  assert.deepEqual(bridge.calls.credit[0], { player: 'Alice', amount: '25', ref: `withdraw:${w.id}:refund` });
  assert.ok(ledger.hasEntry(`withdraw:${w.id}:refund`));
  assert.equal(ledger.accountBalance('ingame_liability'), 0n, 'books back to zero');
  assert.equal(ledger.accountBalance('onchain_outflow'), 0n);
});

test('refund is retried when the bridge is down, and posts exactly once', async (t) => {
  const chain = mockChain({ script: [{ failCode: 'TX_FAILED' }] });
  const bridge = mockBridge();
  bridge.setFailCredit(new BridgeError('bridge down', { code: 'UNAVAILABLE', retryable: true }));
  const { ledger, worker } = fixture(t, { chain, bridge });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'failed', 'refund pending while bridge is down');
  // bridge comes back — next drain completes the refund
  bridge.setFailCredit(null);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'refunded');
  assert.equal(bridge.calls.credit.length, 1);
  // further drains must not double-credit
  await worker.drain();
  assert.equal(bridge.calls.credit.length, 1);
  assert.equal(ledger.accountBalance('ingame_liability'), 0n);
});

test('bridge down at debit time: row stays requested and succeeds later', async (t) => {
  const bridge = mockBridge();
  bridge.setFailDebit(new BridgeError('timeout', { code: 'UNAVAILABLE', retryable: true }));
  const { ledger, worker } = fixture(t, { bridge });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'requested');
  bridge.setFailDebit(null);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'confirmed');
});

// ------------------------------------------------------------- re-sign rules

test('blockhash provably expired → re-sign once with a fresh transaction', async (t) => {
  const chain = mockChain({ script: ['expire', 'confirm'] });
  const { ledger, worker } = fixture(t, { chain });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  const row = ledger.getWithdrawal(w.id);
  assert.equal(row.state, 'confirmed');
  assert.equal(chain.calls.send.length, 2, 'exactly one re-sign');
  assert.equal(row.signature, 'sig-2', 'second signature is the one that landed');
});

test('rpc dies after signing: row parks as signed, recovery confirms from the stored signature', async (t) => {
  const chain = mockChain({ script: ['rpc-down-after-sign'] });
  const { ledger, worker } = fixture(t, { chain });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  let row = ledger.getWithdrawal(w.id);
  assert.equal(row.state, 'signed', 'unknown outcome ⇒ do NOT re-sign, keep the signature');
  assert.equal(row.signature, 'sig-1');
  // Recovery: the stored signature actually landed while we were offline.
  chain.state.statuses['sig-1'] = { slot: 7n, err: null, confirmationStatus: 'finalized' };
  await worker.drain();
  row = ledger.getWithdrawal(w.id);
  assert.equal(row.state, 'confirmed');
  assert.equal(chain.calls.send.length, 1, 'never re-signed');
});

// ------------------------------------------------------------- crash recovery

function seedCrashedRow(ledger, { state = 'submitted', signature = 'crash-sig', lvbh = 150n } = {}) {
  const w = requestWithdrawal(ledger);
  ledger.recordDebit(w.id);
  ledger.transition(w.id, 'signed', { signature, lastValidBlockHeight: lvbh });
  if (state === 'submitted') ledger.transition(w.id, 'submitted');
  return ledger.getWithdrawal(w.id);
}

test('crash recovery: stored signature is checked FIRST; confirmed on-chain ⇒ confirmed', async (t) => {
  const chain = mockChain({
    statuses: { 'crash-sig': { slot: 5n, err: null, confirmationStatus: 'confirmed' } },
  });
  const { ledger, worker, bridge } = fixture(t, { chain });
  const w = seedCrashedRow(ledger);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'confirmed');
  assert.equal(chain.calls.statusChecks[0], 'crash-sig', 'signature checked before anything else');
  assert.equal(chain.calls.send.length, 0, 'no new transaction was signed');
  assert.equal(bridge.calls.credit.length, 0);
});

test('crash recovery: on-chain failure ⇒ failed → refunded', async (t) => {
  const chain = mockChain({
    statuses: { 'crash-sig': { slot: 5n, err: { InstructionError: [1, 'Custom'] }, confirmationStatus: 'confirmed' } },
  });
  const { ledger, worker, bridge } = fixture(t, { chain });
  const w = seedCrashedRow(ledger);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'refunded');
  assert.equal(bridge.calls.credit.length, 1);
});

test('crash recovery: null status + expired blockhash ⇒ safe re-sign and confirm', async (t) => {
  const chain = mockChain({ blockHeight: 151n, script: ['confirm'] }); // 151 > lvbh 150
  const { ledger, worker } = fixture(t, { chain });
  const w = seedCrashedRow(ledger);
  await worker.drain();
  const row = ledger.getWithdrawal(w.id);
  assert.equal(row.state, 'confirmed');
  assert.equal(chain.calls.send.length, 1, 're-signed exactly once after proven expiry');
  assert.equal(row.signature, 'sig-1');
});

test('crash recovery: null status but blockhash still valid ⇒ wait, NEVER re-sign', async (t) => {
  const chain = mockChain({ blockHeight: 149n }); // 149 <= lvbh 150 — not expired
  const { ledger, worker } = fixture(t, { chain });
  const w = seedCrashedRow(ledger);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'submitted', 'left in flight');
  assert.equal(chain.calls.send.length, 0, 'no re-sign while the blockhash may still land');
});

// ------------------------------------------------------------- circuit breaker

test('WITHDRAWALS_ENABLED=false pauses the worker; rows stay requested', async (t) => {
  const { ledger, worker, bridge, chain } = fixture(t, {
    tokenConfig: baseTokenConfig({ withdrawalsEnabled: false }),
  });
  const w = requestWithdrawal(ledger);
  await worker.drain();
  assert.equal(worker.status().paused, true);
  assert.match(worker.status().reason, /disabled/);
  assert.equal(ledger.getWithdrawal(w.id).state, 'requested');
  assert.equal(bridge.calls.debit.length, 0);
  assert.equal(chain.calls.send.length, 0);
});

test('global daily cap trips the breaker mid-drain and rows stay requested', async (t) => {
  const { ledger, worker, bridge } = fixture(t, {
    tokenConfig: baseTokenConfig({ globalDailyCap: '30', globalDailyCapRaw: 30n * MUCHU }),
    usernames: { 1: 'Alice', 2: 'Bob' },
    bridge: mockBridge({ balances: { Alice: '100', Bob: '100' } }),
  });
  const w1 = requestWithdrawal(ledger, { userId: 1, amount: 25n * MUCHU, key: 'a' });
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w1.id).state, 'confirmed', '25 ≤ 30 passes');

  const w2 = requestWithdrawal(ledger, { userId: 2, amount: 25n * MUCHU, key: 'b' });
  await worker.drain();
  assert.equal(worker.status().paused, true, '50 > 30 trips the global cap');
  assert.ok(worker.status().reasons['global-cap']);
  assert.equal(ledger.getWithdrawal(w2.id).state, 'requested');
});

// ------------------------------------------------------------- solvency monitor

test('solvency: treasury < Σ balances + pending ⇒ pause + /status flag; recovery resumes', async (t) => {
  const chain = mockChain({ treasury: { sol: 10n ** 9n, tokenRaw: 90n * MUCHU } });
  const bridge = mockBridge({ balances: { Alice: '80', Bob: '30.5' } }); // liability 110.5
  const { ledger, worker } = fixture(t, { chain, bridge, usernames: { 1: 'Alice', 2: 'Bob' } });

  const res = await worker.checkSolvency();
  assert.equal(res.ok, false);
  assert.equal(res.liabilityRaw, 110_500_000n);
  assert.equal(worker.status().paused, true);
  assert.equal(worker.status().solvent, false);
  assert.match(worker.status().reason, /insolvent/);

  // paused ⇒ requested rows do not move
  const w = requestWithdrawal(ledger);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'requested');

  // treasury topped up ⇒ next check resumes (25 pending + 110.5 = 135.5)
  chain.state.treasury = { sol: 10n ** 9n, tokenRaw: 1_000n * MUCHU };
  const res2 = await worker.checkSolvency();
  assert.equal(res2.ok, true);
  assert.equal(res2.liabilityRaw, 135_500_000n, 'pending withdrawal counted as liability');
  assert.equal(worker.status().paused, false);
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'confirmed');
});

test('solvency check failure (bridge/rpc down) keeps the previous verdict', async (t) => {
  const chain = mockChain();
  chain.state.treasury = new Error('rpc down');
  const { worker } = fixture(t, { chain });
  const res = await worker.checkSolvency();
  assert.equal(res.ok, null);
  assert.equal(worker.status().paused, false, 'no false alarm');
  assert.equal(worker.status().solvent, true);
});

test('amounts are decimal strings at the bridge boundary (fractional withdrawal)', async (t) => {
  const { ledger, worker, bridge } = fixture(t);
  const w = requestWithdrawal(ledger, { amount: 12_500_000n }); // 12.5 MUCHU
  await worker.drain();
  assert.equal(ledger.getWithdrawal(w.id).state, 'confirmed');
  assert.equal(bridge.calls.debit[0].amount, '12.5');
  assert.equal(formatRawAmount(ledger.accountBalance('onchain_outflow'), 6), '12.5');
});
