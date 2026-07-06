// token-solana.test.js — chain layer against a MOCK rpc (no network):
// exchange-guide send rules (persist signature+lastValidBlockHeight BEFORE the
// first send, same-bytes rebroadcast, never re-sign until the blockhash is
// provably expired with a null status) and legacy vs Token-2022 program
// detection. Signing is real (offline ed25519 via @solana/kit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import {
  createChain,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  BlockhashExpiredError,
  TransactionFailedError,
  RpcUnavailableError,
} from '../src/token/solana.js';

const BLOCKHASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W';

/** kit-style mock rpc: every method returns { send: async () => ... }. */
function mockRpc(handlers) {
  return new Proxy({}, {
    get: (_, name) => (...args) => ({
      send: async () => {
        if (!handlers[name]) throw new Error(`mock rpc: unexpected call ${String(name)}`);
        return handlers[name](...args);
      },
    }),
  });
}

function mintAccount(ownerProgram, decimals = 6) {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  return { owner: ownerProgram, data: [data.toString('base64'), 'base64'] };
}

function tokenAccount(amountRaw) {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amountRaw, 64);
  return { owner: TOKEN_PROGRAM_ADDRESS, data: [data.toString('base64'), 'base64'] };
}

async function fixture({ mintOwner = TOKEN_PROGRAM_ADDRESS, handlers = {} } = {}) {
  const treasury = await generateKeyPairSigner();
  const mint = (await generateKeyPairSigner()).address;
  const dest = (await generateKeyPairSigner()).address;
  const events = [];
  const sends = [];
  const state = {
    // scripted per test
    statuses: [], // successive getSignatureStatuses answers (null | {..})
    blockHeight: 100n,
    lastValidBlockHeight: 150n,
  };
  const rpc = mockRpc({
    getAccountInfo: (addr) => {
      if (String(addr) === String(mint)) return { value: mintAccount(mintOwner) };
      return { value: tokenAccount(1_000_000_000n) };
    },
    getBalance: () => ({ value: 5_000_000_000n }),
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: state.lastValidBlockHeight },
    }),
    sendTransaction: (wire) => {
      events.push('send');
      sends.push(wire);
      return 'mock-sig';
    },
    getSignatureStatuses: () => {
      events.push('status');
      const next = state.statuses.length > 1 ? state.statuses.shift() : state.statuses[0];
      return { value: [next ?? null] };
    },
    getBlockHeight: () => state.blockHeight,
    ...handlers,
  });
  const chain = createChain(
    { rpcUrl: 'http://mock', mint: String(mint), decimals: 6, treasuryKeypairPath: '/dev/null' },
    { rpc, treasury, sleep: async () => {}, rebroadcastMs: 0, log: { warn() {}, error() {}, log() {} } },
  );
  return { chain, treasury, mint, dest, events, sends, state };
}

test('getMintInfo detects the legacy token program and on-chain decimals', async () => {
  const { chain } = await fixture({ mintOwner: TOKEN_PROGRAM_ADDRESS });
  const info = await chain.getMintInfo();
  assert.equal(info.program, 'token');
  assert.equal(info.programAddress, String(TOKEN_PROGRAM_ADDRESS));
  assert.equal(info.decimals, 6);
});

test('getMintInfo detects Token-2022 mints', async () => {
  const { chain } = await fixture({ mintOwner: TOKEN_2022_PROGRAM_ADDRESS });
  const info = await chain.getMintInfo();
  assert.equal(info.program, 'token-2022');
  assert.equal(info.programAddress, String(TOKEN_2022_PROGRAM_ADDRESS));
});

test('getMintInfo rejects mints owned by an unknown program', async () => {
  const { chain } = await fixture({ mintOwner: '11111111111111111111111111111111' });
  await assert.rejects(() => chain.getMintInfo(), /not a known SPL token program/);
});

test('getTreasuryState reads lamports + raw token amount from the ATA', async () => {
  const { chain } = await fixture();
  const { sol, tokenRaw } = await chain.getTreasuryState();
  assert.equal(sol, 5_000_000_000n);
  assert.equal(tokenRaw, 1_000_000_000n);
});

test('sendWithdrawal persists signature + lastValidBlockHeight BEFORE the first send', async (t) => {
  const { chain, dest, events, state } = await fixture();
  state.statuses = [{ slot: 1n, err: null, confirmationStatus: 'confirmed' }];
  let persisted = null;
  const result = await chain.sendWithdrawal({
    destAddress: dest,
    rawAmount: 25_000_000n,
    onPersistSignature: (p) => {
      events.push('persist');
      persisted = p;
    },
    onSubmitted: () => events.push('submitted'),
  });
  assert.ok(persisted, 'persist callback ran');
  assert.equal(typeof persisted.signature, 'string');
  assert.ok(persisted.signature.length > 30, 'real base58 signature');
  assert.equal(persisted.lastValidBlockHeight, 150n);
  assert.equal(result.signature, persisted.signature, 'resolved signature matches persisted one');
  const firstPersist = events.indexOf('persist');
  const firstSend = events.indexOf('send');
  assert.ok(firstPersist !== -1 && firstSend !== -1);
  assert.ok(firstPersist < firstSend, `persist must precede first send (events: ${events})`);
  assert.ok(events.indexOf('submitted') > firstSend, 'submitted fires after the first send');
});

test('sendWithdrawal rebroadcasts the SAME signed bytes until confirmed', async () => {
  const { chain, dest, sends, state } = await fixture();
  state.statuses = [null, null, null, { slot: 9n, err: null, confirmationStatus: 'finalized' }];
  state.blockHeight = 100n; // < lastValidBlockHeight: not expired
  await chain.sendWithdrawal({
    destAddress: dest,
    rawAmount: 1_000_000n,
    onPersistSignature: () => {},
  });
  assert.ok(sends.length >= 3, `expected repeated broadcasts, got ${sends.length}`);
  assert.ok(sends.every((w) => w === sends[0]), 'every broadcast must be byte-identical');
});

test('sendWithdrawal never re-signs: expiry with null status throws BlockhashExpiredError', async () => {
  const { chain, dest, sends, state } = await fixture();
  state.statuses = [null]; // never seen on-chain
  state.blockHeight = 151n; // > lastValidBlockHeight of 150n ⇒ provably expired
  await assert.rejects(
    () => chain.sendWithdrawal({ destAddress: dest, rawAmount: 1n, onPersistSignature: () => {} }),
    (err) => err instanceof BlockhashExpiredError && err.code === 'BLOCKHASH_EXPIRED',
  );
  assert.ok(sends.every((w) => w === sends[0]), 'exactly one signed transaction, never a second signing');
});

test('sendWithdrawal keeps waiting while the blockhash is still valid (no premature expiry)', async () => {
  const { chain, dest, state, events } = await fixture();
  // Status stays null for a while at a sub-expiry height, then confirms.
  state.statuses = [null, null, null, null, { slot: 2n, err: null, confirmationStatus: 'confirmed' }];
  state.blockHeight = 149n; // == lastValidBlockHeight - 1 ⇒ NOT expired
  await chain.sendWithdrawal({ destAddress: dest, rawAmount: 1n, onPersistSignature: () => {} });
  assert.ok(events.filter((e) => e === 'status').length >= 4, 'kept polling instead of erroring');
});

test('sendWithdrawal surfaces on-chain failure as TransactionFailedError', async () => {
  const { chain, dest, state } = await fixture();
  state.statuses = [{ slot: 3n, err: { InstructionError: [3, 'Custom'] }, confirmationStatus: 'confirmed' }];
  await assert.rejects(
    () => chain.sendWithdrawal({ destAddress: dest, rawAmount: 1n, onPersistSignature: () => {} }),
    (err) => err instanceof TransactionFailedError && err.code === 'TX_FAILED',
  );
});

test('sendWithdrawal gives up with RpcUnavailableError after persistent rpc errors', async () => {
  const { chain, dest } = await fixture({
    handlers: {
      sendTransaction: () => { throw new Error('ECONNREFUSED'); },
      getSignatureStatuses: () => { throw new Error('ECONNREFUSED'); },
      getBlockHeight: () => { throw new Error('ECONNREFUSED'); },
    },
  });
  let persisted = false;
  await assert.rejects(
    () => chain.sendWithdrawal({
      destAddress: dest, rawAmount: 1n, onPersistSignature: () => { persisted = true; },
    }),
    (err) => err instanceof RpcUnavailableError && err.retryable === true,
  );
  assert.ok(persisted, 'signature persisted before the network died — recovery can resume');
});

test('invalid destination is a typed, permanent error (refund path)', async () => {
  const { chain } = await fixture();
  await assert.rejects(
    () => chain.sendWithdrawal({
      destAddress: 'not-a-solana-address!', rawAmount: 1n, onPersistSignature: () => {},
    }),
    (err) => err.code === 'INVALID_DESTINATION',
  );
});

test('the signed transaction embeds the detected token program (legacy vs 2022)', async () => {
  const enc = getAddressEncoder();
  for (const [owner, program] of [
    [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
    [TOKEN_2022_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS],
  ]) {
    const { chain, dest, sends, state } = await fixture({ mintOwner: owner });
    state.statuses = [{ slot: 1n, err: null, confirmationStatus: 'confirmed' }];
    await chain.sendWithdrawal({ destAddress: dest, rawAmount: 5n, onPersistSignature: () => {} });
    const wire = Buffer.from(sends[0], 'base64');
    const programBytes = Buffer.from(enc.encode(program));
    assert.ok(wire.includes(programBytes), `wire tx must reference ${program}`);
    const otherProgram = program === TOKEN_PROGRAM_ADDRESS ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;
    assert.ok(!wire.includes(Buffer.from(enc.encode(otherProgram))), 'and not the other program');
  }
});
