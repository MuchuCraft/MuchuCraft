// token-ledger.test.js — ledger invariants: decimal-string <-> raw conversion,
// SUM=0 journal enforcement, ref/idempotency-key dedupe, one-in-flight rule,
// caps math, withdrawal state machine. In-memory sqlite, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger,
  parseAmountToRaw,
  parseLooseAmountToRaw,
  formatRawAmount,
  LedgerError,
} from '../src/token/ledger.js';

const DEC = 6;
const MUCHU = 10n ** 6n; // 1 MUCHU in raw units

function freshLedger(t) {
  const ledger = createLedger({ dbPath: ':memory:' });
  t.after(() => ledger.close());
  return ledger;
}

// ---------------------------------------------------------------- amounts

test('parseAmountToRaw accepts plain decimal strings', () => {
  assert.equal(parseAmountToRaw('25', DEC), 25n * MUCHU);
  assert.equal(parseAmountToRaw('12.5', DEC), 12_500_000n);
  assert.equal(parseAmountToRaw('0.000001', DEC), 1n);
  assert.equal(parseAmountToRaw('0', DEC), 0n);
  assert.equal(parseAmountToRaw('1000.123456', DEC), 1_000_123_456n);
  assert.equal(parseAmountToRaw('007', DEC), 7n * MUCHU);
});

test('parseAmountToRaw rejects floats-in-disguise and malformed input', () => {
  const bad = [
    25, // number, not a string — decimal STRINGS at boundaries
    25.5,
    null,
    undefined,
    {},
    '',
    '-5', // negative
    '+5',
    '1e5', // exponent notation
    '1E5',
    '2.5e-3',
    '25.1234567', // > 6 decimal places
    '.5',
    '5.',
    '5..5',
    '1,5',
    ' 25',
    '25 ',
    'abc',
    'Infinity',
    'NaN',
    '0x19',
    '1'.repeat(31), // absurd length
  ];
  for (const value of bad) {
    assert.throws(
      () => parseAmountToRaw(value, DEC),
      (err) => err instanceof LedgerError && err.code === 'BAD_AMOUNT',
      `should reject ${JSON.stringify(value)}`,
    );
  }
});

test('formatRawAmount renders decimal strings, trimming trailing zeros', () => {
  assert.equal(formatRawAmount(25n * MUCHU, DEC), '25');
  assert.equal(formatRawAmount(12_500_000n, DEC), '12.5');
  assert.equal(formatRawAmount(1n, DEC), '0.000001');
  assert.equal(formatRawAmount(0n, DEC), '0');
  assert.equal(formatRawAmount(-2_250_000n, DEC), '-2.25');
  // round trip
  for (const s of ['25', '12.5', '0.000001', '1000.123456']) {
    assert.equal(formatRawAmount(parseAmountToRaw(s, DEC), DEC), s);
  }
});

test('parseLooseAmountToRaw rounds UP past the mint decimals (solvency-safe)', () => {
  assert.equal(parseLooseAmountToRaw('12.3456789', DEC), 12_345_679n); // rounded up
  assert.equal(parseLooseAmountToRaw('12.3456780', DEC), 12_345_678n); // exact
  assert.equal(parseLooseAmountToRaw('50', DEC), 50n * MUCHU);
  assert.throws(() => parseLooseAmountToRaw('-1', DEC));
  assert.throws(() => parseLooseAmountToRaw('1e5', DEC));
});

// ---------------------------------------------------------------- journal

test('journal entries must sum to zero — unbalanced entry rolls back fully', (t) => {
  const ledger = freshLedger(t);
  assert.throws(
    () => ledger.postEntry({
      reason: 'bad',
      ref: 'bad:1',
      legs: [
        { account: 'ingame_liability', delta: -100n },
        { account: 'onchain_outflow', delta: 99n },
      ],
    }),
    (err) => err.code === 'UNBALANCED',
  );
  assert.equal(ledger.hasEntry('bad:1'), false, 'entry must be rolled back');
  assert.equal(ledger.accountBalance('ingame_liability'), 0n);
  assert.equal(ledger.accountBalance('onchain_outflow'), 0n);
  // single-leg zero entries are also rejected
  assert.throws(
    () => ledger.postEntry({ reason: 'bad', legs: [{ account: 'adjustments', delta: 0n }] }),
    (err) => err.code === 'UNBALANCED',
  );
});

test('journal ref is idempotent: duplicate ref is a no-op', (t) => {
  const ledger = freshLedger(t);
  const legs = [
    { account: 'ingame_liability', delta: -25n * MUCHU },
    { account: 'onchain_outflow', delta: 25n * MUCHU },
  ];
  const first = ledger.postEntry({ reason: 'debit', ref: 'w:1:debit', legs });
  const second = ledger.postEntry({ reason: 'debit', ref: 'w:1:debit', legs });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.entryId, first.entryId);
  assert.equal(ledger.accountBalance('ingame_liability'), -25n * MUCHU, 'posted exactly once');
  assert.equal(ledger.accountBalance('onchain_outflow'), 25n * MUCHU);
});

test('unknown ledger account is rejected', (t) => {
  const ledger = freshLedger(t);
  assert.throws(
    () => ledger.postEntry({
      reason: 'x',
      legs: [{ account: 'nope', delta: 1n }, { account: 'adjustments', delta: -1n }],
    }),
    (err) => err.code === 'NO_ACCOUNT',
  );
});

// ---------------------------------------------------------------- withdrawals

test('idempotency key dedupes withdrawal creation', (t) => {
  const ledger = freshLedger(t);
  const a = ledger.createWithdrawal({
    idempotencyKey: 'k1', userId: 1, destAddress: 'Dest111', amountRaw: 25n * MUCHU,
  });
  const b = ledger.createWithdrawal({
    idempotencyKey: 'k1', userId: 1, destAddress: 'Dest111', amountRaw: 25n * MUCHU,
  });
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(b.withdrawal.id, a.withdrawal.id);
  assert.equal(b.withdrawal.amountRaw, 25n * MUCHU);
});

test('one non-terminal withdrawal per user (partial unique index)', (t) => {
  const ledger = freshLedger(t);
  const { withdrawal } = ledger.createWithdrawal({
    idempotencyKey: 'k1', userId: 1, destAddress: 'D', amountRaw: 25n * MUCHU,
  });
  assert.equal(ledger.hasInFlight(1), true);
  assert.throws(
    () => ledger.createWithdrawal({
      idempotencyKey: 'k2', userId: 1, destAddress: 'D', amountRaw: 10n * MUCHU,
    }),
    (err) => err instanceof LedgerError && err.code === 'IN_FLIGHT',
  );
  // a different user is unaffected
  ledger.createWithdrawal({ idempotencyKey: 'k3', userId: 2, destAddress: 'D', amountRaw: 10n * MUCHU });
  // terminal state frees the slot
  ledger.transition(withdrawal.id, 'debited');
  ledger.transition(withdrawal.id, 'signed', { signature: 's', lastValidBlockHeight: 10n });
  ledger.transition(withdrawal.id, 'submitted');
  ledger.transition(withdrawal.id, 'confirmed');
  assert.equal(ledger.hasInFlight(1), false);
  const again = ledger.createWithdrawal({
    idempotencyKey: 'k4', userId: 1, destAddress: 'D', amountRaw: 10n * MUCHU,
  });
  assert.equal(again.deduped, false);
});

test('state machine: full happy path + persisted signature fields', (t) => {
  const ledger = freshLedger(t);
  const { withdrawal } = ledger.createWithdrawal({
    idempotencyKey: 'k', userId: 1, destAddress: 'D', amountRaw: 5n * MUCHU,
  });
  assert.equal(withdrawal.state, 'requested');
  ledger.transition(withdrawal.id, 'debited');
  const signed = ledger.transition(withdrawal.id, 'signed', {
    signature: 'sig123', lastValidBlockHeight: 4242n,
  });
  assert.equal(signed.signature, 'sig123');
  assert.equal(signed.lastValidBlockHeight, 4242n);
  ledger.transition(withdrawal.id, 'submitted');
  const done = ledger.transition(withdrawal.id, 'confirmed');
  assert.equal(done.state, 'confirmed');
  assert.equal(done.signature, 'sig123', 'signature survives transitions');
});

test('state machine rejects illegal transitions', (t) => {
  const ledger = freshLedger(t);
  const { withdrawal } = ledger.createWithdrawal({
    idempotencyKey: 'k', userId: 1, destAddress: 'D', amountRaw: 5n * MUCHU,
  });
  const id = withdrawal.id;
  for (const bad of ['signed', 'submitted', 'confirmed', 'refunded']) {
    assert.throws(() => ledger.transition(id, bad), (err) => err.code === 'BAD_TRANSITION');
  }
  ledger.transition(id, 'failed');
  assert.throws(() => ledger.transition(id, 'debited'), (err) => err.code === 'BAD_TRANSITION');
  ledger.transition(id, 'refunded'); // failed -> refunded is the refund path
  assert.throws(() => ledger.transition(id, 'confirmed'), (err) => err.code === 'BAD_TRANSITION');
});

test('expired-blockhash re-sign path: signed/submitted may fall back to debited', (t) => {
  const ledger = freshLedger(t);
  const { withdrawal } = ledger.createWithdrawal({
    idempotencyKey: 'k', userId: 1, destAddress: 'D', amountRaw: 5n * MUCHU,
  });
  ledger.transition(withdrawal.id, 'debited');
  ledger.transition(withdrawal.id, 'signed', { signature: 's1', lastValidBlockHeight: 10n });
  ledger.transition(withdrawal.id, 'submitted');
  const back = ledger.transition(withdrawal.id, 'debited'); // provably expired ⇒ re-sign
  assert.equal(back.state, 'debited');
  const resigned = ledger.transition(withdrawal.id, 'signed', { signature: 's2', lastValidBlockHeight: 20n });
  assert.equal(resigned.signature, 's2');
});

test('recordDebit/recordRefund post balanced entries and keep the books at zero', (t) => {
  const ledger = freshLedger(t);
  const { withdrawal } = ledger.createWithdrawal({
    idempotencyKey: 'k', userId: 1, destAddress: 'D', amountRaw: 25n * MUCHU,
  });
  ledger.recordDebit(withdrawal.id);
  assert.equal(ledger.getWithdrawal(withdrawal.id).state, 'debited');
  assert.equal(ledger.accountBalance('ingame_liability'), -25n * MUCHU);
  assert.equal(ledger.accountBalance('onchain_outflow'), 25n * MUCHU);
  assert.ok(ledger.hasEntry(`withdraw:${withdrawal.id}:debit`));

  ledger.transition(withdrawal.id, 'failed', { error: 'boom' });
  ledger.recordRefund(withdrawal.id);
  assert.equal(ledger.getWithdrawal(withdrawal.id).state, 'refunded');
  assert.equal(ledger.accountBalance('ingame_liability'), 0n, 'reversal restores the books');
  assert.equal(ledger.accountBalance('onchain_outflow'), 0n);
  assert.ok(ledger.hasEntry(`withdraw:${withdrawal.id}:refund`));
});

// ---------------------------------------------------------------- caps math

test('daily caps: per-user and global trailing-24h sums, excluding failed/refunded', (t) => {
  const ledger = freshLedger(t);
  const t0 = 1_000_000_000_000;
  const HOUR = 3_600_000;

  const w1 = ledger.createWithdrawal({
    idempotencyKey: 'a', userId: 1, destAddress: 'D', amountRaw: 25n * MUCHU, at: t0,
  }).withdrawal;
  ledger.transition(w1.id, 'debited');
  ledger.transition(w1.id, 'signed', { signature: 's', lastValidBlockHeight: 1n });
  ledger.transition(w1.id, 'submitted');
  ledger.transition(w1.id, 'confirmed');

  const w2 = ledger.createWithdrawal({
    idempotencyKey: 'b', userId: 1, destAddress: 'D', amountRaw: 30n * MUCHU, at: t0 + HOUR,
  }).withdrawal;

  ledger.createWithdrawal({
    idempotencyKey: 'c', userId: 2, destAddress: 'D', amountRaw: 40n * MUCHU, at: t0 + HOUR,
  });

  const at = t0 + 2 * HOUR;
  assert.equal(ledger.userDailyTotalRaw(1, at), 55n * MUCHU);
  assert.equal(ledger.userDailyTotalRaw(2, at), 40n * MUCHU);
  assert.equal(ledger.globalDailyTotalRaw(at), 95n * MUCHU);

  // failed/refunded rows stop counting against caps
  ledger.transition(w2.id, 'failed', { error: 'insufficient' });
  assert.equal(ledger.userDailyTotalRaw(1, at), 25n * MUCHU);
  assert.equal(ledger.globalDailyTotalRaw(at), 65n * MUCHU);

  // ...and the window rolls off after 24h
  assert.equal(ledger.userDailyTotalRaw(1, t0 + 25 * HOUR), 0n);
  assert.equal(ledger.globalDailyTotalRaw(t0 + 26 * HOUR), 0n);
});

test('pendingTotalRaw counts only non-terminal states (solvency input)', (t) => {
  const ledger = freshLedger(t);
  const a = ledger.createWithdrawal({
    idempotencyKey: 'a', userId: 1, destAddress: 'D', amountRaw: 10n * MUCHU,
  }).withdrawal;
  const b = ledger.createWithdrawal({
    idempotencyKey: 'b', userId: 2, destAddress: 'D', amountRaw: 20n * MUCHU,
  }).withdrawal;
  ledger.createWithdrawal({
    idempotencyKey: 'c', userId: 3, destAddress: 'D', amountRaw: 40n * MUCHU,
  });
  assert.equal(ledger.pendingTotalRaw(), 70n * MUCHU);
  ledger.transition(a.id, 'failed');
  assert.equal(ledger.pendingTotalRaw(), 60n * MUCHU);
  ledger.transition(b.id, 'debited');
  assert.equal(ledger.pendingTotalRaw(), 60n * MUCHU, 'debited is still pending outflow');
});

test('listWithdrawals returns the user rows newest first; rowsInStates filters', (t) => {
  const ledger = freshLedger(t);
  const a = ledger.createWithdrawal({
    idempotencyKey: 'a', userId: 1, destAddress: 'D', amountRaw: 10n * MUCHU,
  }).withdrawal;
  ledger.transition(a.id, 'failed');
  ledger.createWithdrawal({ idempotencyKey: 'b', userId: 1, destAddress: 'D', amountRaw: 20n * MUCHU });
  ledger.createWithdrawal({ idempotencyKey: 'c', userId: 2, destAddress: 'D', amountRaw: 30n * MUCHU });
  const mine = ledger.listWithdrawals(1);
  assert.equal(mine.length, 2);
  assert.equal(mine[0].amountRaw, 20n * MUCHU, 'newest first');
  assert.equal(ledger.rowsInStates(['requested']).length, 2);
  assert.equal(ledger.rowsInStates(['failed']).length, 1);
});
