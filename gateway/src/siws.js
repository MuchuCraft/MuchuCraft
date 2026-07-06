// siws.js — SIWS-style message construction + ed25519 signature verification.
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Build the exact sign-in message (the server ALWAYS builds it; clients never do).
 * issuedAt/expiresAt accept ms epoch, Date, or ISO string.
 */
export function buildMessage({ domain, uri, address, username, nonce, issuedAt, expiresAt }) {
  const issuedAtISO = toISO(issuedAt);
  const expiresAtISO = toISO(expiresAt);
  return (
    `${domain} wants you to sign in with your Solana account:\n` +
    `${address}\n` +
    `\n` +
    `Sign in to MuchuCraft to play Minecraft as "${username}". This request will not trigger a blockchain transaction or cost any fees.\n` +
    `\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Chain ID: mainnet\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAtISO}\n` +
    `Expiration Time: ${expiresAtISO}`
  );
}

/**
 * Verify a wallet signature over `message`.
 *
 * Primary: nacl.sign.detached.verify(utf8(message), sig, bs58(address)).
 * Fallback (Ledger/Solflare off-chain header): if `signedMessage` (number
 * array / bytes) is provided, accept iff signedMessage CONTAINS the exact
 * UTF-8 message bytes as a contiguous subsequence AND the signature verifies
 * over signedMessage.
 *
 * @param {{message: string, address: string, signature: string|number[]|Uint8Array, signedMessage?: number[]|Uint8Array}} p
 * @returns {boolean}
 */
export function verifySiws({ message, address, signature, signedMessage }) {
  let pubkey;
  let sig;
  try {
    pubkey = bs58.decode(String(address));
    sig = decodeSignature(signature);
  } catch {
    return false;
  }
  if (!pubkey || pubkey.length !== 32) return false;
  if (!sig || sig.length !== 64) return false;
  if (typeof message !== 'string' || message.length === 0) return false;

  const messageBytes = Buffer.from(message, 'utf8');

  try {
    if (nacl.sign.detached.verify(messageBytes, sig, pubkey)) return true;
  } catch {
    /* fall through to fallback */
  }

  if (signedMessage != null) {
    try {
      const signedBytes = toBytes(signedMessage);
      if (!signedBytes || signedBytes.length === 0) return false;
      const container = Buffer.from(signedBytes);
      if (container.indexOf(messageBytes) === -1) return false; // must contain exact bytes
      return nacl.sign.detached.verify(container, sig, pubkey);
    } catch {
      return false;
    }
  }
  return false;
}

function decodeSignature(signature) {
  if (typeof signature === 'string') return bs58.decode(signature);
  return toBytes(signature);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    if (!value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    return Uint8Array.from(value);
  }
  return null;
}

function toISO(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString();
}
