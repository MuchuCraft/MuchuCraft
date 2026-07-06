// siws.test.js — message template + signature verification (real tweetnacl keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildMessage, verifySiws } from '../src/siws.js';

function makeWallet() {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    sign: (bytes) => nacl.sign.detached(bytes, kp.secretKey),
  };
}

const ISSUED = new Date('2026-07-06T12:00:00.000Z');
const EXPIRES = new Date('2026-07-06T12:05:00.000Z');

function makeMessage(address, username = 'Steve_42') {
  return buildMessage({
    domain: 'localhost:8080',
    uri: 'http://localhost:8080/login/',
    address,
    username,
    nonce: 'abcd1234abcd1234abcd1234abcd1234',
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
  });
}

test('buildMessage follows the SPEC template exactly', () => {
  const wallet = makeWallet();
  const msg = makeMessage(wallet.address);
  const expected =
    `localhost:8080 wants you to sign in with your Solana account:\n` +
    `${wallet.address}\n\n` +
    `Sign in to MuchuCraft to play Minecraft as "Steve_42". This request will not trigger a blockchain transaction or cost any fees.\n\n` +
    `URI: http://localhost:8080/login/\n` +
    `Version: 1\n` +
    `Chain ID: mainnet\n` +
    `Nonce: abcd1234abcd1234abcd1234abcd1234\n` +
    `Issued At: 2026-07-06T12:00:00.000Z\n` +
    `Expiration Time: 2026-07-06T12:05:00.000Z`;
  assert.equal(msg, expected);
});

test('valid detached signature (base58 string) passes', () => {
  const wallet = makeWallet();
  const message = makeMessage(wallet.address);
  const sig = wallet.sign(Buffer.from(message, 'utf8'));
  assert.equal(verifySiws({ message, address: wallet.address, signature: bs58.encode(sig) }), true);
});

test('number-array signatures work (launcher sends Array.from(sig))', () => {
  const wallet = makeWallet();
  const message = makeMessage(wallet.address);
  const sig = wallet.sign(Buffer.from(message, 'utf8'));
  assert.equal(verifySiws({ message, address: wallet.address, signature: Array.from(sig) }), true);
});

test('tampered message fails', () => {
  const wallet = makeWallet();
  const message = makeMessage(wallet.address);
  const sig = wallet.sign(Buffer.from(message, 'utf8'));
  const tampered = message.replace('Steve_42', 'Eve_1337');
  assert.equal(verifySiws({ message: tampered, address: wallet.address, signature: Array.from(sig) }), false);
});

test('signature from a different key fails', () => {
  const wallet = makeWallet();
  const other = makeWallet();
  const message = makeMessage(wallet.address);
  const sig = other.sign(Buffer.from(message, 'utf8'));
  assert.equal(verifySiws({ message, address: wallet.address, signature: Array.from(sig) }), false);
});

test('signedMessage fallback: prefix-wrapped message containing exact bytes passes', () => {
  const wallet = makeWallet();
  const message = makeMessage(wallet.address);
  // Simulate a Ledger/Solflare-style off-chain envelope around the exact message bytes.
  const wrapped = Buffer.concat([
    Buffer.from([0xff]),
    Buffer.from('solana offchain', 'utf8'),
    Buffer.from([0x00, 0x01]),
    Buffer.from(message, 'utf8'),
  ]);
  const sig = wallet.sign(wrapped);
  assert.equal(
    verifySiws({
      message,
      address: wallet.address,
      signature: Array.from(sig),
      signedMessage: Array.from(wrapped),
    }),
    true,
  );
});

test('signedMessage fallback: envelope NOT containing the exact message fails', () => {
  const wallet = makeWallet();
  const message = makeMessage(wallet.address);
  const altered = message.replace('Steve_42', 'Steve_43');
  const wrapped = Buffer.concat([
    Buffer.from([0xff]),
    Buffer.from('solana offchain', 'utf8'),
    Buffer.from(altered, 'utf8'), // valid signature, but over DIFFERENT message bytes
  ]);
  const sig = wallet.sign(wrapped);
  assert.equal(
    verifySiws({
      message,
      address: wallet.address,
      signature: Array.from(sig),
      signedMessage: Array.from(wrapped),
    }),
    false,
  );
});

test('signedMessage fallback: containment is not enough — signature must verify over the envelope', () => {
  const wallet = makeWallet();
  const other = makeWallet();
  const message = makeMessage(wallet.address);
  const wrapped = Buffer.concat([Buffer.from('hdr:', 'utf8'), Buffer.from(message, 'utf8')]);
  const sig = other.sign(wrapped); // wrong key
  assert.equal(
    verifySiws({
      message,
      address: wallet.address,
      signature: Array.from(sig),
      signedMessage: Array.from(wrapped),
    }),
    false,
  );
});

test('garbage inputs never throw, just return false', () => {
  const wallet = makeWallet();
  const message = makeMessage(wallet.address);
  assert.equal(verifySiws({ message, address: 'not-base58-0OIl', signature: 'zz' }), false);
  assert.equal(verifySiws({ message, address: wallet.address, signature: 'zz' }), false);
  assert.equal(verifySiws({ message, address: wallet.address, signature: [1, 2, 3] }), false);
  assert.equal(verifySiws({ message: '', address: wallet.address, signature: Array.from(wallet.sign(Buffer.from('x'))) }), false);
  assert.equal(verifySiws({ message, address: wallet.address, signature: null }), false);
});
