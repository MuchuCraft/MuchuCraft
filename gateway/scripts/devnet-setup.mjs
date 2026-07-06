#!/usr/bin/env node
// gateway/scripts/devnet-setup.mjs — one-shot (idempotent) devnet bootstrap for the
// MUCHU 1:1 token economy. Run with cwd=gateway:  node scripts/devnet-setup.mjs
//
// What it does (safe to re-run; re-runs load existing keys/mint and top up):
//   1. create/load ~/.muchucraft/devnet-mint-authority.json + TREASURY_KEYPAIR_PATH
//      (standard 64-byte Solana keypair JSON files, chmod 600)
//   2. airdrop devnet SOL to both with patient retries/backoff (faucet 429s are
//      normal; total needs are tiny)
//   3. create the legacy SPL mint (MUCHU_DECIMALS decimals, authority = mint
//      authority key) unless MUCHU_MINT in root .env already points at a live mint
//   4. create the treasury ATA (idempotent) and mint up to 1,000,000 MUCHU into it
//   5. write MUCHU_MINT=<address> into root .env
//   6. print a summary — NEVER prints private keys.
//
// Exit codes: 0 success, 1 failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  address,
} from '@solana/kit';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintToInstruction,
  getMintSize,
} from '@solana-program/token';
import { getCreateAccountInstruction } from '@solana-program/system';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // env may already be populated
}

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const CLUSTER = process.env.SOLANA_CLUSTER ?? 'devnet';
const DECIMALS = Number(process.env.MUCHU_DECIMALS ?? '6');
const TREASURY_KEYPAIR_PATH =
  process.env.TREASURY_KEYPAIR_PATH ?? path.join(os.homedir(), '.muchucraft', 'treasury.json');
const MINT_AUTHORITY_PATH = path.join(os.homedir(), '.muchucraft', 'devnet-mint-authority.json');

const TARGET_SUPPLY_RAW = 1_000_000n * 10n ** BigInt(DECIMALS); // 1,000,000 MUCHU
const LAMPORTS_PER_SOL = 1_000_000_000n;
const AIRDROP_CHUNK = 1n * LAMPORTS_PER_SOL; // small requests are kinder to the faucet
// Total SOL needs are tiny: mint rent ~0.0015, ATA rent ~0.002, fees ~0.000005/tx.
// Treasury keeps a small float for withdrawal fees + player ATA rent.
const AUTHORITY_MIN_LAMPORTS = 50_000_000n; // 0.05 SOL
const TREASURY_MIN_LAMPORTS = 200_000_000n; // 0.2 SOL

const log = (...a) => console.log('[devnet-setup]', ...a);

if (!Number.isInteger(DECIMALS) || DECIMALS < 0 || DECIMALS > 12) {
  log(`FATAL: MUCHU_DECIMALS=${process.env.MUCHU_DECIMALS} is not a sane integer`);
  process.exit(1);
}

// ------------------------------------------------------------------ keypairs

/** Load a 64-byte Solana keypair JSON file, or create one. chmod 600 either way. */
async function loadOrCreateKeypair(filePath, label) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let signer;
  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(raw) || raw.length !== 64) {
      throw new Error(`${label}: ${filePath} is not a 64-byte Solana keypair JSON array`);
    }
    signer = await createKeyPairSignerFromBytes(Uint8Array.from(raw));
    log(`${label}: loaded existing keypair ${filePath} → ${signer.address}`);
  } else {
    const seed = crypto.randomBytes(32);
    signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const pub = getAddressEncoder().encode(signer.address);
    const file64 = new Uint8Array(64);
    file64.set(seed, 0);
    file64.set(pub, 32);
    fs.writeFileSync(filePath, JSON.stringify(Array.from(file64)), { mode: 0o600 });
    log(`${label}: created new keypair ${filePath} → ${signer.address}`);
  }
  fs.chmodSync(filePath, 0o600);
  return signer;
}

// ----------------------------------------------------------------------- rpc

const rpc = createSolanaRpc(RPC_URL);
const wsUrl = RPC_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

async function getBalanceLamports(addr) {
  const { value } = await rpc.getBalance(addr, { commitment: 'confirmed' }).send();
  return BigInt(value);
}

/**
 * Airdrop until `addr` holds at least `minLamports`. The devnet faucet 429s
 * routinely — that is normal; we retry with patient exponential backoff.
 */
async function ensureSol(addr, minLamports, label) {
  let balance = await getBalanceLamports(addr);
  if (balance >= minLamports) {
    log(`${label}: balance ${fmtSol(balance)} SOL — OK, no airdrop needed`);
    return balance;
  }
  const maxAttempts = 30;
  let backoffMs = 3_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-read every attempt: funds may arrive out of band (manual faucet /
    // `solana transfer`) while we are stuck in faucet backoff.
    balance = await getBalanceLamports(addr);
    if (balance >= minLamports) {
      log(`${label}: balance now ${fmtSol(balance)} SOL — funded`);
      return balance;
    }
    try {
      log(`${label}: balance ${fmtSol(balance)} SOL < ${fmtSol(minLamports)} — requesting ${fmtSol(AIRDROP_CHUNK)} SOL airdrop (attempt ${attempt}/${maxAttempts})`);
      await rpc.requestAirdrop(addr, lamports(AIRDROP_CHUNK), { commitment: 'confirmed' }).send();
      // Poll the balance rather than the signature: simpler and covers the
      // occasional faucet that acks but lands the lamports a few slots later.
      const before = balance;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await delay(2_500);
        balance = await getBalanceLamports(addr);
        if (balance > before) break;
      }
      if (balance >= minLamports) {
        log(`${label}: balance now ${fmtSol(balance)} SOL — funded`);
        return balance;
      }
      if (balance === before) {
        log(`${label}: airdrop accepted but lamports never landed — will retry`);
      }
    } catch (err) {
      const msg = String(err?.message ?? err);
      const rateLimited = /429|rate.?limit|too many/i.test(msg);
      log(`${label}: airdrop attempt failed (${rateLimited ? 'faucet rate limit — normal' : msg.slice(0, 200)})`);
    }
    log(`${label}: backing off ${Math.round(backoffMs / 1000)}s before next faucet attempt`);
    await delay(backoffMs);
    backoffMs = Math.min(Math.round(backoffMs * 1.6), 45_000);
  }
  balance = await getBalanceLamports(addr);
  if (balance >= minLamports) return balance;
  throw new Error(
    `${label}: could not fund ${addr} above ${fmtSol(minLamports)} SOL after ${maxAttempts} faucet attempts. ` +
      `Fund it manually (https://faucet.solana.com) and re-run — this script is idempotent.`
  );
}

function fmtSol(l) {
  const neg = l < 0n;
  const v = neg ? -l : l;
  const whole = v / LAMPORTS_PER_SOL;
  const frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '') || '0';
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

function fmtMuchu(raw) {
  const base = 10n ** BigInt(DECIMALS);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Build, sign, send and confirm one transaction (retries for devnet flakiness). */
async function sendTx(instructions, feePayer, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m)
      );
      const signed = await signTransactionMessageWithSigners(message);
      await sendAndConfirm(signed, { commitment: 'confirmed' });
      const signature = getSignatureFromTransaction(signed);
      log(`${label}: confirmed (${signature})`);
      return signature;
    } catch (err) {
      lastErr = err;
      log(`${label}: attempt ${attempt}/4 failed: ${String(err?.message ?? err).slice(0, 300)}`);
      await delay(3_000 * attempt);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------- mint

/** Returns the reusable mint address from .env if it exists on-chain, else null. */
async function loadExistingMint() {
  const configured = (process.env.MUCHU_MINT ?? '').trim();
  if (!configured) return null;
  let mint;
  try {
    mint = address(configured);
  } catch {
    log(`MUCHU_MINT="${configured}" in .env is not a valid address — will create a fresh mint`);
    return null;
  }
  const { value: info } = await rpc.getAccountInfo(mint, { encoding: 'jsonParsed' }).send();
  if (!info) {
    log(`MUCHU_MINT=${configured} not found on ${CLUSTER} — will create a fresh mint`);
    return null;
  }
  const parsed = info.data?.parsed;
  if (info.owner !== TOKEN_PROGRAM_ADDRESS || parsed?.type !== 'mint') {
    throw new Error(`MUCHU_MINT=${configured} exists but is not a legacy SPL mint (owner ${info.owner}) — clear MUCHU_MINT in .env to start over`);
  }
  const onChainDecimals = Number(parsed.info?.decimals);
  if (onChainDecimals !== DECIMALS) {
    throw new Error(`MUCHU_MINT=${configured} has ${onChainDecimals} decimals but MUCHU_DECIMALS=${DECIMALS} — fix .env or clear MUCHU_MINT`);
  }
  log(`reusing existing mint ${configured} (${onChainDecimals} decimals) from .env`);
  return mint;
}

async function createMint(authority) {
  const mintSigner = await generateKeyPairSigner(); // ephemeral; only the address matters afterwards
  const space = BigInt(getMintSize());
  // NB: this RPC method returns the lamports directly (no {context, value} wrapper).
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await sendTx(
    [
      getCreateAccountInstruction({
        payer: authority,
        newAccount: mintSigner,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMintInstruction({
        mint: mintSigner.address,
        decimals: DECIMALS,
        mintAuthority: authority.address,
        freezeAuthority: null,
      }),
    ],
    authority,
    `create mint ${mintSigner.address}`
  );
  return mintSigner.address;
}

async function getAtaBalanceRaw(ata) {
  try {
    const { value } = await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
  } catch {
    return null; // account does not exist yet
  }
}

// ----------------------------------------------------------------------- env

function writeMintToEnv(mint) {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const line = `MUCHU_MINT=${mint}`;
  let next;
  if (/^MUCHU_MINT=.*$/m.test(text)) {
    next = text.replace(/^MUCHU_MINT=.*$/m, line);
  } else {
    next = text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
  }
  if (next !== text) {
    fs.writeFileSync(ENV_PATH, next);
    log(`wrote ${line} into ${ENV_PATH}`);
  } else {
    log(`${ENV_PATH} already has ${line}`);
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  log(`cluster=${CLUSTER} rpc=${RPC_URL}`);
  if (CLUSTER !== 'devnet') {
    log(`FATAL: SOLANA_CLUSTER=${CLUSTER} — this script is devnet-only (mainnet uses a market-bought mint; see docs/MAINNET-CUTOVER.md)`);
    process.exit(1);
  }

  const mintAuthority = await loadOrCreateKeypair(MINT_AUTHORITY_PATH, 'mint-authority');
  const treasury = await loadOrCreateKeypair(TREASURY_KEYPAIR_PATH, 'treasury');

  // Fund both keys. Faucet 429s are expected; needs are tiny so we are patient.
  const authoritySol = await ensureSol(mintAuthority.address, AUTHORITY_MIN_LAMPORTS, 'mint-authority');
  const treasurySol = await ensureSol(treasury.address, TREASURY_MIN_LAMPORTS, 'treasury');

  let mint = await loadExistingMint();
  if (!mint) {
    mint = await createMint(mintAuthority);
    log(`created legacy SPL mint ${mint} (${DECIMALS} decimals, authority ${mintAuthority.address})`);
  }

  // Treasury ATA (idempotent create — safe on re-runs).
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner: treasury.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await sendTx(
    [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: mintAuthority,
        ata,
        owner: treasury.address,
        mint,
      }),
    ],
    mintAuthority,
    `treasury ATA ${ata} (idempotent create)`
  );

  // Top up to exactly 1,000,000 MUCHU (mint only the shortfall on re-runs).
  const current = (await getAtaBalanceRaw(ata)) ?? 0n;
  if (current < TARGET_SUPPLY_RAW) {
    const shortfall = TARGET_SUPPLY_RAW - current;
    await sendTx(
      [
        getMintToInstruction({
          mint,
          token: ata,
          mintAuthority,
          amount: shortfall,
        }),
      ],
      mintAuthority,
      `mint ${fmtMuchu(shortfall)} MUCHU to treasury`
    );
  } else {
    log(`treasury already holds ${fmtMuchu(current)} MUCHU — nothing to mint`);
  }

  writeMintToEnv(mint);

  // Final verification via getTokenAccountBalance.
  const finalRaw = await getAtaBalanceRaw(ata);
  if (finalRaw === null || finalRaw < TARGET_SUPPLY_RAW) {
    throw new Error(`verification failed: treasury ATA balance is ${finalRaw ?? 'missing'} raw, expected ≥ ${TARGET_SUPPLY_RAW}`);
  }

  console.log('');
  console.log('================ MUCHU devnet setup — summary ================');
  console.log(`  cluster            ${CLUSTER}`);
  console.log(`  rpc                ${RPC_URL}`);
  console.log(`  mint (MUCHU_MINT)  ${mint}`);
  console.log(`  decimals           ${DECIMALS}`);
  console.log(`  mint authority     ${mintAuthority.address}`);
  console.log(`                     key file ${MINT_AUTHORITY_PATH} (chmod 600)`);
  console.log(`  treasury           ${treasury.address}`);
  console.log(`                     key file ${TREASURY_KEYPAIR_PATH} (chmod 600)`);
  console.log(`  treasury ATA       ${ata}`);
  console.log(`  treasury balance   ${fmtMuchu(finalRaw)} MUCHU (${finalRaw} raw)`);
  console.log(`  SOL balances       authority ${fmtSol(authoritySol)} / treasury ${fmtSol(treasurySol)}`);
  console.log(`  .env updated       MUCHU_MINT=${mint}`);
  console.log('  (private keys are never printed — they live only in the key files)');
  console.log('===============================================================');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`FATAL: ${err?.stack ?? err}`);
    process.exit(1);
  });
