// e2e/fakewallet.js — fake Solana wallet: an ed25519 keypair that signs
// SIWS-style messages exactly like a browser wallet would (detached ed25519
// signature over the UTF-8 bytes of the message string).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

function walletFromKeyPair(keyPair) {
  return {
    /** Base58-encoded 32-byte ed25519 public key (a Solana address). */
    address: bs58.encode(keyPair.publicKey),
    /**
     * Sign a message string.
     * @param {string} message exact message text (server-constructed)
     * @returns {Uint8Array} 64-byte detached ed25519 signature
     */
    signMessage(message) {
      const bytes = new TextEncoder().encode(String(message));
      return nacl.sign.detached(bytes, keyPair.secretKey);
    },
  };
}

/** A brand-new random wallet. */
export function createFakeWallet() {
  return walletFromKeyPair(nacl.sign.keyPair());
}

/**
 * Load a wallet persisted at `filePath`, or create + persist a new one.
 * Used for the E2ETester identity so repeated e2e runs keep the same wallet
 * (the username stays bound to it in the gateway DB across runs).
 * Persistence is best-effort; on any error a fresh in-memory wallet is used.
 */
export function loadOrCreateWallet(filePath) {
  try {
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    const secretKey = Uint8Array.from(saved.secretKey);
    return walletFromKeyPair(nacl.sign.keyPair.fromSecretKey(secretKey));
  } catch {
    const keyPair = nacl.sign.keyPair();
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({ secretKey: Array.from(keyPair.secretKey) }),
        { mode: 0o600 }
      );
    } catch {
      // best-effort only
    }
    return walletFromKeyPair(keyPair);
  }
}
