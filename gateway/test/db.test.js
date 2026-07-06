// db.test.js — in-memory sqlite: nonces, users, sessions, markLogin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';

function freshDb(t) {
  const db = createDb(':memory:');
  t.after(() => db.close());
  return db;
}

const ADDR_A = '11111111111111111111111111111111';
const ADDR_B = '22222222222222222222222222222222';

test('nonce is single-use: second consume returns null (atomic)', (t) => {
  const db = freshDb(t);
  db.createNonce({ nonce: 'n1', username: 'Alice', address: ADDR_A, message: 'm', expiresAt: Date.now() + 60000 });
  const first = db.consumeNonce('n1');
  assert.ok(first, 'first consume wins');
  assert.equal(first.username, 'Alice');
  assert.equal(first.address, ADDR_A);
  assert.equal(db.consumeNonce('n1'), null, 'second consume must lose');
});

test('expired nonce cannot be consumed (and is burned by the attempt)', (t) => {
  const db = freshDb(t);
  db.createNonce({ nonce: 'n2', username: 'Alice', address: ADDR_A, message: 'm', expiresAt: Date.now() - 1 });
  assert.equal(db.consumeNonce('n2'), null);
  assert.equal(db.consumeNonce('n2'), null);
});

test('unknown nonce consume returns null', (t) => {
  const db = freshDb(t);
  assert.equal(db.consumeNonce('nope'), null);
  assert.equal(db.consumeNonce(null), null);
});

test('username uniqueness is case-insensitive; same wallet may re-claim', (t) => {
  const db = freshDb(t);
  const alice = db.claimUsername('Alice', ADDR_A);
  assert.ok(alice?.id, 'first claim succeeds');

  // Lookup is case-insensitive.
  assert.equal(db.getUserByName('alice')?.id, alice.id);
  assert.equal(db.getUserByName('ALICE')?.id, alice.id);

  // Different wallet cannot take any casing of the name.
  assert.equal(db.claimUsername('ALICE', ADDR_B), null);
  assert.equal(db.claimUsername('alice', ADDR_B), null);

  // Same wallet re-claim (login) returns the same user.
  assert.equal(db.claimUsername('Alice', ADDR_A)?.id, alice.id);
  assert.equal(db.claimUsername('aLiCe', ADDR_A)?.id, alice.id);
});

test('sessions: lookup, expiry, revocation', (t) => {
  const db = freshDb(t);
  const user = db.claimUsername('Bob', ADDR_B);

  const { token, expiresAt } = db.createSession(user.id, 60_000);
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64, '32 random bytes hex');
  assert.ok(expiresAt > Date.now());

  const info = db.getSessionInfo(token);
  assert.ok(info);
  assert.equal(info.userId, user.id);
  assert.equal(info.username, 'Bob');
  assert.equal(info.address, ADDR_B);

  // Expired session -> null.
  const { token: expired } = db.createSession(user.id, -1);
  assert.equal(db.getSessionInfo(expired), null);

  // Revoked session -> null.
  assert.equal(db.revokeSession(token), true);
  assert.equal(db.getSessionInfo(token), null);

  // Garbage tokens -> null, no throw.
  assert.equal(db.getSessionInfo('deadbeef'), null);
  assert.equal(db.getSessionInfo(undefined), null);
});

test('markLogin: firstLogin true exactly once, bumps last_login_at', (t) => {
  const db = freshDb(t);
  const user = db.claimUsername('Carol', ADDR_A);
  assert.deepEqual(db.markLogin(user.id), { firstLogin: true });
  assert.deepEqual(db.markLogin(user.id), { firstLogin: false });
  assert.deepEqual(db.markLogin(user.id), { firstLogin: false });
  assert.deepEqual(db.markLogin(999999), { firstLogin: false }, 'unknown user is not a first login');
});

test('cleanup removes expired/used nonces and expired/revoked sessions', (t) => {
  const db = freshDb(t);
  const user = db.claimUsername('Dave', ADDR_A);
  db.createNonce({ nonce: 'gone', username: 'Dave', address: ADDR_A, message: 'm', expiresAt: Date.now() - 5 });
  db.createNonce({ nonce: 'kept', username: 'Dave', address: ADDR_A, message: 'm', expiresAt: Date.now() + 60000 });
  db.createSession(user.id, -5);
  const live = db.createSession(user.id, 60_000);

  const { nonces, sessions } = db.cleanup();
  assert.equal(nonces, 1);
  assert.equal(sessions, 1);

  // Live rows survive.
  assert.ok(db.consumeNonce('kept'));
  assert.ok(db.getSessionInfo(live.token));
});
