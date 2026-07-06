// token-deposits.test.js — deposit watcher with MOCK RPC fixtures and a MOCK
// bridge: jsonParsed parsing (transferChecked + transfer forms), signature-PK
// dedupe, dust/unmatched/pending_retry states, cursor persistence across
// restarts, journal refs, treasury self-transfer exclusion, gate accounting
// (promoteToDepositor), deposit-info push with backoff, and the /api/token
// routes additions (status deposit block + GET /deposits). No network, no
// timers (tick()/pushDepositInfo() driven explicitly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/index.js';
import { createDb } from '../src/db.js';
import { createLedger } from '../src/token/ledger.js';
import { createTokenRoutes, loadTokenConfig } from '../src/token/routes.js';
import { BridgeError } from '../src/token/bridge-client.js';
import {
  attachDeposits,
  createDepositStore,
  createDepositWatcher,
  extractIncomingTransfers,
  loadDepositConfig,
  DEPOSITS_IN_ACCOUNT,
} from '../src/token/deposits.js';

const MUCHU = 10n ** 6n;
const MINT = 'MintAddr1111111111111111111111111111111111';
const OTHER_MINT = 'OtherMint111111111111111111111111111111111';
const TREASURY_OWNER = 'TreasuryOwner11111111111111111111111111111';
const TREASURY_ATA = 'TreasuryAta1111111111111111111111111111111';
const ALICE_ADDR = 'A1iceWa11etAddress111111111111111111111111';
const ALICE_ATA = 'A1iceAta1111111111111111111111111111111111';
const STRANGER_ADDR = 'StrangerWa11et1111111111111111111111111111';

function baseTokenConfig(extra = {}) {
  return {
    cluster: 'devnet',
    rpcUrl: 'http://mock',
    mint: MINT,
    decimals: 6,
    treasuryKeypairPath: '/nonexistent/treasury.json',
    bridgeUrl: 'http://127.0.0.1:8091',
    bridgeToken: 'test-bridge-token',
    ...extra,
  };
}

const DEPOSIT_ENV = { DEPOSIT_MIN: '1', DEPOSIT_GATE_MIN: '25', DEPOSIT_POLL_SECONDS: '20' };

function recordingLog() {
  const rec = { logs: [], warns: [], errors: [] };
  return {
    rec,
    log: (...a) => rec.logs.push(a.join(' ')),
    warn: (...a) => rec.warns.push(a.join(' ')),
    error: (...a) => rec.errors.push(a.join(' ')),
  };
}

/** Mock bridge (worker-test style): successful credits recorded, failure injectable. */
function mockBridge({ failCredit = null } = {}) {
  const calls = { credit: [] };
  return {
    calls,
    setFailCredit(err) { failCredit = err; },
    async credit(args) {
      if (failCredit) throw failCredit;
      calls.credit.push(args);
      return { ok: true, newBalance: '0' };
    },
  };
}

/**
 * Mock kit rpc. `signatures` is NEWEST FIRST (like the real
 * getSignaturesForAddress); `transactions` maps signature → jsonParsed tx
 * fixture (or an Error to simulate RPC failure).
 */
function mockRpc({ signatures = [], transactions = {} } = {}) {
  const state = { signatures, transactions };
  const calls = { sigRequests: [], txRequests: [] };
  return {
    state,
    calls,
    getSignaturesForAddress(addr, opts = {}) {
      return {
        send: async () => {
          calls.sigRequests.push({
            address: String(addr),
            until: opts.until ?? null,
            before: opts.before ?? null,
            limit: opts.limit ?? null,
          });
          if (state.signatures instanceof Error) throw state.signatures;
          let list = state.signatures;
          if (opts.until) {
            const i = list.findIndex((s) => s.signature === opts.until);
            if (i !== -1) list = list.slice(0, i);
          }
          if (opts.before) {
            const i = list.findIndex((s) => s.signature === opts.before);
            list = i === -1 ? [] : list.slice(i + 1);
          }
          return list.slice(0, opts.limit ?? 1000);
        },
      };
    },
    getTransaction(sig, opts = {}) {
      return {
        send: async () => {
          calls.txRequests.push({ signature: String(sig), encoding: opts.encoding });
          const tx = state.transactions[String(sig)];
          if (tx instanceof Error) throw tx;
          return tx ?? null;
        },
      };
    },
  };
}

function sigInfo(signature, { slot = 100, blockTime = 1_751_000_000, err = null } = {}) {
  return { signature, slot, blockTime, err };
}

/** jsonParsed transferChecked fixture (owner resolvable via preTokenBalances). */
function transferCheckedTx({
  owner = ALICE_ADDR,
  source = ALICE_ATA,
  destination = TREASURY_ATA,
  amount = '25000000',
  mint = MINT,
  slot = 100,
  blockTime = 1_751_000_000,
} = {}) {
  return {
    slot,
    blockTime,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint, owner, uiTokenAmount: { amount } }],
      postTokenBalances: [],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: owner, signer: true, writable: true },
          { pubkey: source, signer: false, writable: true },
          { pubkey: destination, signer: false, writable: true },
        ],
        instructions: [{
          program: 'spl-token',
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          parsed: {
            type: 'transferChecked',
            info: {
              source,
              destination,
              mint,
              authority: owner,
              tokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: '' },
            },
          },
        }],
      },
    },
  };
}

/** jsonParsed plain-transfer fixture (no mint field; owner from authority). */
function transferTx({
  owner = ALICE_ADDR,
  source = ALICE_ATA,
  destination = TREASURY_ATA,
  amount = '25000000',
  slot = 100,
  blockTime = 1_751_000_000,
} = {}) {
  return {
    slot,
    blockTime,
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: owner, signer: true, writable: true },
          { pubkey: source, signer: false, writable: true },
          { pubkey: destination, signer: false, writable: true },
        ],
        instructions: [{
          program: 'spl-token',
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          parsed: {
            type: 'transfer',
            info: { source, destination, amount, authority: owner },
          },
        }],
      },
    },
  };
}

function fixture(t, {
  users = { [ALICE_ADDR]: { id: 1, username: 'Alice' } },
  signatures = [],
  transactions = {},
  bridge,
  depositEnv = {},
  pageLimit,
} = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => { try { database.close(); } catch { /* closed */ } });
  const ledger = createLedger({ database });
  const store = createDepositStore({ database });
  bridge ??= mockBridge();
  const rpc = mockRpc({ signatures, transactions });
  const tokenConfig = baseTokenConfig();
  const depositConfig = loadDepositConfig(tokenConfig, { ...DEPOSIT_ENV, ...depositEnv });
  const promoteCalls = [];
  const pushed = [];
  const sleeps = [];
  const log = recordingLog();
  const watcher = createDepositWatcher({
    store,
    ledger,
    bridge,
    tokenConfig,
    depositConfig,
    rpc,
    resolveTreasury: async () => ({ ownerAddress: TREASURY_OWNER, ataAddress: TREASURY_ATA }),
    getUserByAddress: (addr) => users[addr] ?? null,
    getUsername: (id) => Object.values(users).find((u) => u.id === id)?.username ?? null,
    promoteToDepositor: (name) => { promoteCalls.push(name); },
    postDepositInfo: async (body) => { pushed.push(body); },
    log,
    sleep: async (ms) => { sleeps.push(ms); },
    ...(pageLimit ? { pageLimit } : {}),
  });
  return { database, ledger, store, bridge, rpc, watcher, depositConfig, promoteCalls, pushed, sleeps, log };
}

// ------------------------------------------------------------- config

test('loadDepositConfig: env values parsed to raw BigInt, defaults applied', () => {
  const cfg = loadDepositConfig({ decimals: 6 }, DEPOSIT_ENV);
  assert.equal(cfg.min, '1');
  assert.equal(cfg.minRaw, 1n * MUCHU);
  assert.equal(cfg.gateMin, '25');
  assert.equal(cfg.gateMinRaw, 25n * MUCHU);
  assert.equal(cfg.pollSeconds, 20);
  const defaults = loadDepositConfig({ decimals: 6 }, {});
  assert.equal(defaults.min, '1');
  assert.equal(defaults.gateMin, '25');
  assert.equal(defaults.pollSeconds, 20);
});

// ------------------------------------------------------------- parsing + credit

test('transferChecked deposit from a bound wallet → credited: bridge credit + journal ref', async (t) => {
  const { store, ledger, bridge, watcher } = fixture(t, {
    signatures: [sigInfo('dep-1', { slot: 111, blockTime: 1_751_000_123 })],
    transactions: { 'dep-1': transferCheckedTx({ amount: '25000000' }) },
  });
  await watcher.tick();

  const dep = store.getDeposit('dep-1');
  assert.equal(dep.status, 'credited');
  assert.equal(dep.userId, 1);
  assert.equal(dep.fromAddress, ALICE_ADDR);
  assert.equal(dep.amountRaw, 25n * MUCHU);
  assert.equal(dep.slot, 111);
  assert.equal(dep.blockTime, 1_751_000_123);
  // decimal-string amount + deposit-signature ref at the bridge boundary
  assert.deepEqual(bridge.calls.credit, [{ player: 'Alice', amount: '25', ref: 'deposit:dep-1' }]);
  // journal: +player liability against deposits_in, ref = deposit signature
  assert.ok(ledger.hasEntry('deposit:dep-1'));
  assert.equal(ledger.accountBalance('ingame_liability'), 25n * MUCHU);
  assert.equal(ledger.accountBalance(DEPOSITS_IN_ACCOUNT), -25n * MUCHU);
  assert.equal(store.getCursor(), 'dep-1');
});

test('plain transfer form (no mint field, owner from authority) is parsed too', async (t) => {
  const { store, bridge, watcher } = fixture(t, {
    signatures: [sigInfo('dep-2')],
    transactions: { 'dep-2': transferTx({ amount: '12500000' }) },
  });
  await watcher.tick();
  const dep = store.getDeposit('dep-2');
  assert.equal(dep.status, 'credited');
  assert.equal(dep.fromAddress, ALICE_ADDR);
  assert.equal(dep.amountRaw, 12_500_000n);
  assert.equal(bridge.calls.credit[0].amount, '12.5', 'decimal string, trailing zeros trimmed');
});

test('extractIncomingTransfers: inner instructions count; system/other-program parsed ixs do not', () => {
  const tx = transferCheckedTx({ amount: '5000000' });
  // a system-program parsed instruction aimed at the ATA must be ignored
  tx.transaction.message.instructions.unshift({
    program: 'system',
    programId: '11111111111111111111111111111111',
    parsed: { type: 'transfer', info: { source: ALICE_ADDR, destination: TREASURY_ATA, lamports: 5000 } },
  });
  // an inner spl-token transfer INTO the treasury ATA must be found
  tx.meta.innerInstructions = [{
    index: 0,
    instructions: [{
      program: 'spl-token',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      parsed: { type: 'transfer', info: { source: ALICE_ATA, destination: TREASURY_ATA, amount: '1000000', authority: ALICE_ADDR } },
    }],
  }];
  const found = extractIncomingTransfers(tx, TREASURY_ATA, MINT);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.amountRaw), [5_000_000n, 1_000_000n]);
  assert.ok(found.every((f) => f.owner === ALICE_ADDR));
});

// ------------------------------------------------------------- idempotency

test('signature PK dedupe: a re-scan (lost/older cursor) can never double-credit', async (t) => {
  const { store, ledger, bridge, watcher } = fixture(t, {
    signatures: [sigInfo('dep-1')],
    transactions: { 'dep-1': transferCheckedTx() },
  });
  await watcher.tick();
  assert.equal(bridge.calls.credit.length, 1);
  // Simulate a cursor reset (e.g. restored older backup): full history rescan.
  store.setCursor('some-forgotten-sig');
  await watcher.tick();
  await watcher.tick();
  assert.equal(bridge.calls.credit.length, 1, 'no double credit');
  assert.equal(ledger.accountBalance('ingame_liability'), 25n * MUCHU, 'journal posted once');
  assert.equal(store.listForUser(1).length, 1, 'one row per signature');
});

test('store.insertDeposit is idempotent on the signature primary key', (t) => {
  const { store } = fixture(t);
  const first = store.insertDeposit({
    signature: 'sig-x', fromAddress: ALICE_ADDR, amountRaw: 5n * MUCHU, userId: 1, status: 'credited',
  });
  assert.equal(first.deduped, false);
  const again = store.insertDeposit({
    signature: 'sig-x', fromAddress: ALICE_ADDR, amountRaw: 999n * MUCHU, userId: 1, status: 'unmatched',
  });
  assert.equal(again.deduped, true);
  assert.equal(again.deposit.amountRaw, 5n * MUCHU, 'original row kept');
  assert.equal(again.deposit.status, 'credited');
});

// ------------------------------------------------------------- dust / unmatched

test('below DEPOSIT_MIN → dust: matched to the user, listed, but never credited', async (t) => {
  const { store, ledger, bridge, watcher, log } = fixture(t, {
    signatures: [sigInfo('dust-1')],
    transactions: { 'dust-1': transferCheckedTx({ amount: '500000' }) }, // 0.5 < min 1
  });
  await watcher.tick();
  const dep = store.getDeposit('dust-1');
  assert.equal(dep.status, 'dust');
  assert.equal(dep.userId, 1, 'dust is still attributed to the matched user');
  assert.equal(bridge.calls.credit.length, 0, 'no in-game credit');
  assert.equal(ledger.hasEntry('deposit:dust-1'), false, 'no journal entry');
  assert.equal(store.listForUser(1)[0].signature, 'dust-1', 'visible via the user deposit list');
  assert.ok(log.rec.warns.some((w) => /dust/.test(w)));
});

test('unknown source owner → unmatched, loud log, no credit', async (t) => {
  const { store, ledger, bridge, watcher, log } = fixture(t, {
    signatures: [sigInfo('mystery-1')],
    transactions: {
      'mystery-1': transferCheckedTx({ owner: STRANGER_ADDR, source: 'StrangerAta111111111111111111111111111111', amount: '10000000' }),
    },
  });
  await watcher.tick();
  const dep = store.getDeposit('mystery-1');
  assert.equal(dep.status, 'unmatched');
  assert.equal(dep.userId, null);
  assert.equal(dep.fromAddress, STRANGER_ADDR);
  assert.equal(bridge.calls.credit.length, 0);
  assert.equal(ledger.hasEntry('deposit:mystery-1'), false);
  assert.ok(log.rec.errors.some((e) => /UNMATCHED DEPOSIT/.test(e)), 'logged loudly');
});

// ------------------------------------------------------------- retry path

test('bridge down mid-credit → pending_retry, retried next tick; journal posts exactly once', async (t) => {
  const bridge = mockBridge();
  bridge.setFailCredit(new BridgeError('bridge down', { code: 'UNAVAILABLE', retryable: true }));
  const { store, ledger, watcher } = fixture(t, {
    bridge,
    signatures: [sigInfo('retry-1')],
    transactions: { 'retry-1': transferCheckedTx({ amount: '25000000' }) },
  });
  await watcher.tick();
  assert.equal(store.getDeposit('retry-1').status, 'pending_retry');
  assert.ok(ledger.hasEntry('deposit:retry-1'), 'journal ref exists before the credit lands');
  assert.equal(store.getCursor(), 'retry-1', 'cursor advances — the ROW carries the retry');

  bridge.setFailCredit(null);
  await watcher.tick();
  assert.equal(store.getDeposit('retry-1').status, 'credited');
  assert.equal(bridge.calls.credit.length, 1);
  assert.equal(ledger.accountBalance('ingame_liability'), 25n * MUCHU, 'ref dedupe: single entry');

  await watcher.tick();
  assert.equal(bridge.calls.credit.length, 1, 'no further credits once credited');
});

test('RPC failure on getTransaction aborts the scan without advancing the cursor', async (t) => {
  const { store, bridge, rpc, watcher } = fixture(t, {
    signatures: [sigInfo('ok-2'), sigInfo('ok-1')], // newest first
    transactions: { 'ok-1': transferCheckedTx({ amount: '2000000' }), 'ok-2': new Error('rpc down') },
  });
  await watcher.tick();
  assert.equal(store.getDeposit('ok-1').status, 'credited', 'older tx processed first');
  assert.equal(store.getCursor(), 'ok-1', 'cursor stops before the failed signature');
  assert.equal(store.getDeposit('ok-2'), null);

  rpc.state.transactions['ok-2'] = transferCheckedTx({ amount: '3000000' });
  await watcher.tick();
  assert.equal(store.getDeposit('ok-2').status, 'credited');
  assert.equal(store.getCursor(), 'ok-2');
  assert.equal(bridge.calls.credit.length, 2);
});

// ------------------------------------------------------------- exclusions

test('treasury self-transfers and withdrawal-change txs are excluded entirely', async (t) => {
  const { store, bridge, watcher, log } = fixture(t, {
    signatures: [sigInfo('self-1')],
    transactions: {
      'self-1': transferCheckedTx({ owner: TREASURY_OWNER, source: 'TreasuryOtherAta11111111111111111111111111' }),
    },
  });
  await watcher.tick();
  assert.equal(store.getDeposit('self-1'), null, 'no row at all');
  assert.equal(bridge.calls.credit.length, 0);
  assert.equal(store.getCursor(), 'self-1', 'cursor still advances');
  assert.ok(log.rec.logs.some((l) => /self-transfer/.test(l)));
});

test('failed txs, other-mint transferChecked and outgoing transfers are skipped', async (t) => {
  const { store, bridge, rpc, watcher } = fixture(t, {
    signatures: [
      sigInfo('failed-1', { err: { InstructionError: [0, 'Custom'] } }),
      sigInfo('othermint-1'),
      sigInfo('outgoing-1'),
    ],
    transactions: {
      'othermint-1': transferCheckedTx({ mint: OTHER_MINT }),
      'outgoing-1': transferCheckedTx({
        owner: TREASURY_OWNER, source: TREASURY_ATA, destination: ALICE_ATA,
      }),
    },
  });
  await watcher.tick();
  assert.equal(store.getDeposit('failed-1'), null);
  assert.equal(store.getDeposit('othermint-1'), null);
  assert.equal(store.getDeposit('outgoing-1'), null);
  assert.equal(bridge.calls.credit.length, 0);
  assert.equal(store.getCursor(), 'failed-1', 'cursor at the newest signature');
  // the failed signature was never even fetched
  assert.ok(!rpc.calls.txRequests.some((r) => r.signature === 'failed-1'));
});

// ------------------------------------------------------------- cursor persistence

test('cursor persists: a restarted watcher scans back only until the stored signature', async (t) => {
  const shared = fixture(t, {
    signatures: [sigInfo('b'), sigInfo('a')], // newest first
    transactions: {
      a: transferCheckedTx({ amount: '2000000' }),
      b: transferCheckedTx({ amount: '3000000' }),
    },
  });
  await shared.watcher.tick();
  assert.equal(shared.store.getCursor(), 'b');
  assert.equal(shared.bridge.calls.credit.length, 2);

  // "Restart": a brand-new watcher + rpc over the SAME store.
  const rpc2 = mockRpc({
    signatures: [sigInfo('c'), sigInfo('b'), sigInfo('a')],
    transactions: { c: transferCheckedTx({ amount: '4000000' }) },
  });
  const bridge2 = mockBridge();
  const watcher2 = createDepositWatcher({
    store: shared.store,
    ledger: shared.ledger,
    bridge: bridge2,
    tokenConfig: baseTokenConfig(),
    depositConfig: shared.depositConfig,
    rpc: rpc2,
    resolveTreasury: async () => ({ ownerAddress: TREASURY_OWNER, ataAddress: TREASURY_ATA }),
    getUserByAddress: (addr) => (addr === ALICE_ADDR ? { id: 1, username: 'Alice' } : null),
    getUsername: () => 'Alice',
    postDepositInfo: async () => {},
    log: recordingLog(),
    sleep: async () => {},
  });
  await watcher2.tick();
  assert.equal(rpc2.calls.sigRequests[0].until, 'b', 'resumes from the persisted cursor');
  assert.equal(rpc2.calls.txRequests.length, 1, 'only the new signature is fetched');
  assert.deepEqual(bridge2.calls.credit, [{ player: 'Alice', amount: '4', ref: 'deposit:c' }]);
  assert.equal(shared.store.getCursor(), 'c');
});

test('backfill paginates with `before` until the page is short', async (t) => {
  const txs = {};
  const sigs = [];
  for (let i = 5; i >= 1; i--) { // newest (e5) first
    sigs.push(sigInfo(`e${i}`));
    txs[`e${i}`] = transferCheckedTx({ amount: `${i}000000` });
  }
  const { bridge, rpc, watcher, store } = fixture(t, {
    signatures: sigs, transactions: txs, pageLimit: 2,
  });
  await watcher.tick();
  assert.equal(bridge.calls.credit.length, 5);
  assert.deepEqual(
    bridge.calls.credit.map((c) => c.ref),
    ['deposit:e1', 'deposit:e2', 'deposit:e3', 'deposit:e4', 'deposit:e5'],
    'processed oldest first',
  );
  assert.deepEqual(rpc.calls.sigRequests.map((r) => r.before), [null, 'e4', 'e2']);
  assert.equal(store.getCursor(), 'e5');
});

// ------------------------------------------------------------- gate accounting

test('gate: promote fires when cumulative crosses the threshold AND on every later deposit', async (t) => {
  const { rpc, watcher, promoteCalls, store } = fixture(t, {
    signatures: [sigInfo('g1')],
    transactions: {
      g1: transferCheckedTx({ amount: '10000000' }), // 10
      g2: transferCheckedTx({ amount: '20000000' }), // 20 → cumulative 30 ≥ 25
      g3: transferCheckedTx({ amount: '5000000' }), //  5 → cumulative 35 (already unlocked)
    },
  });
  await watcher.tick();
  assert.deepEqual(promoteCalls, [], '10 < 25: gate stays locked');
  assert.equal(store.cumulativeCreditedRaw(1), 10n * MUCHU);

  rpc.state.signatures = [sigInfo('g2'), sigInfo('g1')];
  await watcher.tick();
  assert.deepEqual(promoteCalls, ['Alice'], 'crossing the gate promotes');
  assert.equal(store.cumulativeCreditedRaw(1), 30n * MUCHU);

  rpc.state.signatures = [sigInfo('g3'), sigInfo('g2'), sigInfo('g1')];
  await watcher.tick();
  assert.deepEqual(promoteCalls, ['Alice', 'Alice'], 'idempotent insurance on every later deposit');
});

test('gate: dust never counts toward the cumulative total', async (t) => {
  const { watcher, promoteCalls, store } = fixture(t, {
    signatures: [sigInfo('d1')],
    transactions: { d1: transferCheckedTx({ amount: '500000' }) }, // dust
  });
  await watcher.tick();
  assert.equal(store.cumulativeCreditedRaw(1), 0n);
  assert.deepEqual(promoteCalls, []);
});

test('promoteToDepositor failures are contained (deposit still credited)', async (t) => {
  const database = new DatabaseSync(':memory:');
  t.after(() => { try { database.close(); } catch { /* closed */ } });
  const ledger = createLedger({ database });
  const store = createDepositStore({ database });
  const bridge = mockBridge();
  const log = recordingLog();
  const watcher = createDepositWatcher({
    store, ledger, bridge,
    tokenConfig: baseTokenConfig(),
    depositConfig: loadDepositConfig({ decimals: 6 }, DEPOSIT_ENV),
    rpc: mockRpc({ signatures: [sigInfo('p1')], transactions: { p1: transferCheckedTx({ amount: '30000000' }) } }),
    resolveTreasury: async () => ({ ownerAddress: TREASURY_OWNER, ataAddress: TREASURY_ATA }),
    getUserByAddress: () => ({ id: 1, username: 'Alice' }),
    getUsername: () => 'Alice',
    promoteToDepositor: () => { throw new Error('rcon down'); },
    postDepositInfo: async () => {},
    log,
    sleep: async () => {},
  });
  await watcher.tick();
  assert.equal(store.getDeposit('p1').status, 'credited');
  assert.ok(log.rec.warns.some((w) => /promoteToDepositor.*rcon down/.test(w)));
});

// ------------------------------------------------------------- deposit-info push

test('deposit-info push: waits for the resolved address, retries with backoff, then lands', async (t) => {
  const attempts = [];
  let failures = 2;
  const database = new DatabaseSync(':memory:');
  t.after(() => { try { database.close(); } catch { /* closed */ } });
  const ledger = createLedger({ database });
  const store = createDepositStore({ database });
  const sleeps = [];
  const watcher = createDepositWatcher({
    store, ledger, bridge: mockBridge(),
    tokenConfig: baseTokenConfig(),
    depositConfig: loadDepositConfig({ decimals: 6 }, DEPOSIT_ENV),
    rpc: mockRpc(),
    resolveTreasury: async () => ({ ownerAddress: TREASURY_OWNER, ataAddress: TREASURY_ATA }),
    getUserByAddress: () => null,
    getUsername: () => null,
    postDepositInfo: async (body) => {
      attempts.push(body);
      if (failures-- > 0) throw new Error('bridge not up yet');
    },
    log: recordingLog(),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await watcher.tick(); // resolves the treasury (deposit address)
  const pushed = await watcher.pushDepositInfo();
  assert.equal(pushed, true);
  assert.equal(attempts.length, 3, 'two failures then success');
  assert.deepEqual(attempts[2], { address: TREASURY_OWNER, minimum: '1', gateThreshold: '25' });
  assert.deepEqual(sleeps, [2000, 4000], 'exponential backoff between attempts');
});

// ------------------------------------------------------------- routes (attachDeposits)

const APP_CONFIG = {
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
  MUCHU_MINT: MINT,
  MUCHU_DECIMALS: '6',
  BRIDGE_PORT: '8091',
  BRIDGE_TOKEN: 'test-bridge-token',
  WITHDRAWALS_ENABLED: 'true',
  WITHDRAW_MIN: '10',
  WITHDRAW_MAX_PER_TX: '1000',
  WITHDRAW_DAILY_CAP_PER_USER: '500',
  WITHDRAW_GLOBAL_DAILY_CAP: '5000',
};

function mockStatusBridge(balances = { Alice: '100' }) {
  return {
    async balance(player) {
      if (!(player in balances)) throw new BridgeError('never joined', { code: 'NOT_FOUND' });
      return balances[player];
    },
    async credit() { return { ok: true, newBalance: '0' }; },
  };
}

function mockWorker() {
  return {
    kicks: 0,
    started: 0,
    state: { paused: false, reason: null, reasons: {}, solvent: true, lastSolvencyAt: null },
    status() { return this.state; },
    kick() { this.kicks++; },
    start() { this.started++; },
    stop() {},
  };
}

/** Boot an ephemeral app with the REAL token routes + attachDeposits composition. */
async function bootApp(t) {
  const db = createDb(':memory:');
  const user = db.claimUsername('Alice', ALICE_ADDR);
  const { token } = db.createSession(user.id, 3_600_000);
  const database = new DatabaseSync(':memory:');
  const ledger = createLedger({ database });
  const tokenConfig = loadTokenConfig(undefined, TOKEN_ENV);
  const worker = mockWorker();
  const tokenModule = {
    router: createTokenRoutes({ db, ledger, bridge: mockStatusBridge(), worker, tokenConfig }),
    worker,
    ledger,
    close() {},
  };
  const deposits = attachDeposits({
    tokenModule,
    config: APP_CONFIG,
    tokenConfig,
    db,
    overrides: {
      database,
      bridge: mockBridge(),
      rpc: mockRpc(),
      resolveTreasury: async () => ({ ownerAddress: TREASURY_OWNER, ataAddress: TREASURY_ATA }),
      postDepositInfo: async () => {},
      log: recordingLog(),
      sleep: async () => {},
      env: DEPOSIT_ENV,
    },
  });
  const { app } = createApp({ config: APP_CONFIG, db, tokenRoutes: tokenModule.router });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    db.close();
    try { database.close(); } catch { /* closed */ }
  });
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${token}` };
  return { base, auth, db, user, deposits, tokenModule };
}

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}

test('GET /api/token/status gains the deposit block (address, minimum, gate)', async (t) => {
  const { base, auth, deposits } = await bootApp(t);
  await deposits.watcher.tick(); // resolves the treasury → deposit address known
  const { status, body } = await get(base, '/api/token/status', auth);
  assert.equal(status, 200);
  assert.equal(body.balance, '100', 'existing status fields intact');
  assert.deepEqual(body.deposit, {
    address: TREASURY_OWNER,
    minimum: '1',
    gate: { threshold: '25', cumulativeRaw: '0', unlocked: false },
  });
});

test('deposit block gate flips once cumulative credited deposits reach the threshold', async (t) => {
  const { base, auth, deposits, user } = await bootApp(t);
  await deposits.watcher.tick();
  deposits.store.insertDeposit({
    signature: 'seed-1', fromAddress: ALICE_ADDR, amountRaw: 10n * MUCHU, userId: user.id, status: 'credited',
  });
  deposits.store.insertDeposit({
    signature: 'seed-2', fromAddress: ALICE_ADDR, amountRaw: 20n * MUCHU, userId: user.id, status: 'credited',
  });
  deposits.store.insertDeposit({ // pending_retry must NOT count yet
    signature: 'seed-3', fromAddress: ALICE_ADDR, amountRaw: 40n * MUCHU, userId: user.id, status: 'pending_retry',
  });
  const { body } = await get(base, '/api/token/status', auth);
  assert.deepEqual(body.deposit.gate, {
    threshold: '25', cumulativeRaw: (30n * MUCHU).toString(), unlocked: true,
  });
});

test('401 status responses are NOT augmented with a deposit block', async (t) => {
  const { base } = await bootApp(t);
  const { status, body } = await get(base, '/api/token/status', { authorization: 'Bearer nope' });
  assert.equal(status, 401);
  assert.equal(body.deposit, undefined);
  assert.ok(body.error);
});

test('GET /api/token/deposits: session required; newest first; only OWN rows; withdrawal-list style', async (t) => {
  const { base, auth, deposits, user, db } = await bootApp(t);
  assert.equal((await get(base, '/api/token/deposits')).status, 401);
  assert.equal((await get(base, '/api/token/deposits', { authorization: 'Bearer nope' })).status, 401);

  const other = db.claimUsername('Bob', STRANGER_ADDR);
  deposits.store.insertDeposit({
    signature: 'mine-1', slot: 5, blockTime: 1_751_000_001, fromAddress: ALICE_ADDR,
    amountRaw: 12_500_000n, userId: user.id, status: 'credited',
  });
  deposits.store.insertDeposit({
    signature: 'mine-2', slot: 6, blockTime: 1_751_000_002, fromAddress: ALICE_ADDR,
    amountRaw: 500_000n, userId: user.id, status: 'dust',
  });
  deposits.store.insertDeposit({
    signature: 'theirs-1', fromAddress: STRANGER_ADDR, amountRaw: 99n * MUCHU, userId: other.id, status: 'credited',
  });

  const { status, body } = await get(base, '/api/token/deposits', auth);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), 'a recent LIST — plain JSON array');
  assert.equal(body.length, 2, 'other users’ deposits do not leak');
  assert.deepEqual(body.map((d) => d.signature), ['mine-2', 'mine-1'], 'newest first');
  const [dust, credited] = body;
  assert.equal(dust.status, 'dust');
  assert.equal(dust.amount, '0.5');
  assert.equal(dust.amountRaw, '500000');
  assert.equal(credited.status, 'credited');
  assert.equal(credited.amount, '12.5');
  assert.equal(credited.fromAddress, ALICE_ADDR);
  assert.equal(credited.slot, 5);
  assert.equal(credited.blockTime, 1_751_000_001);
});

test('attachDeposits wires lifecycle: worker.start() also starts the watcher; close() stops it', async (t) => {
  const { deposits, tokenModule } = await bootApp(t);
  const originalStart = deposits.watcher.start;
  let watcherStarted = 0;
  deposits.watcher.start = (...args) => { watcherStarted++; return originalStart(...args); };
  tokenModule.worker.start();
  assert.equal(tokenModule.worker.started, 1, 'withdrawal worker still starts');
  assert.equal(watcherStarted, 1, 'deposit watcher starts alongside it');
  tokenModule.close(); // must not throw; stops watcher timers
  assert.equal(tokenModule.deposits, deposits);
});
