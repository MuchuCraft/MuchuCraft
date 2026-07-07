// solana.js — thin chain layer over @solana/kit + @solana-program/token(-2022).
//
// The mint's OWNER PROGRAM is detected via getAccountInfo and the matching
// client module (legacy SPL Token vs Token-2022) is used for ATA derivation and
// TransferChecked, so a mainnet Token-2022 mint works unchanged.
//
// sendWithdrawal implements the exchange-guide durability rules:
//   1. build + sign ONCE per blockhash
//   2. persist {signature, lastValidBlockHeight} via callback BEFORE first send
//   3. rebroadcast the SAME signed bytes every ~2s while polling
//      getSignatureStatuses
//   4. NEVER re-sign until currentBlockHeight > stored lastValidBlockHeight
//      AND the signature status is still null (throws BlockhashExpiredError —
//      only then may the caller retry with a fresh blockhash).
import fs from 'node:fs/promises';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import * as splToken from '@solana-program/token';
import * as splToken2022 from '@solana-program/token-2022';

export const TOKEN_PROGRAM_ADDRESS = splToken.TOKEN_PROGRAM_ADDRESS;
export const TOKEN_2022_PROGRAM_ADDRESS = splToken2022.TOKEN_2022_PROGRAM_ADDRESS;

const COMPUTE_BUDGET_PROGRAM_ADDRESS = 'ComputeBudget111111111111111111111111111111';
const COMPUTE_UNIT_LIMIT = 120_000; // ATA create + TransferChecked, with headroom
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 10_000n;
const REBROADCAST_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_RPC_ERRORS = 10;
const CONFIRMED = new Set(['confirmed', 'finalized']);

export class ChainError extends Error {
  constructor(message, code = 'CHAIN_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
/** RPC/network trouble — retry later WITHOUT re-signing. */
export class RpcUnavailableError extends ChainError {
  constructor(message) {
    super(message, 'RPC_UNAVAILABLE');
    this.retryable = true;
  }
}
/** Blockhash provably expired with a null status — safe to re-sign. */
export class BlockhashExpiredError extends ChainError {
  constructor(message) {
    super(message, 'BLOCKHASH_EXPIRED');
  }
}
/** Transaction landed on-chain and FAILED — permanent, refund path. */
export class TransactionFailedError extends ChainError {
  constructor(message) {
    super(message, 'TX_FAILED');
  }
}
/** Destination address is not a valid Solana address — permanent. */
export class InvalidDestinationError extends ChainError {
  constructor(message) {
    super(message, 'INVALID_DESTINATION');
  }
}

/** Load a solana-keygen JSON keypair file into a kit signer. */
export async function loadTreasury(keypairPath) {
  const raw = JSON.parse(await fs.readFile(keypairPath, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new ChainError(`treasury keypair at ${keypairPath} is not a 64-byte JSON array`);
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}

function computeUnitLimitInstruction(units) {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS), accounts: [], data };
}

function computeUnitPriceInstruction(microLamports) {
  const data = new Uint8Array(9);
  data[0] = 3; // SetComputeUnitPrice
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS), accounts: [], data };
}

function readU64LE(buf, offset) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + i]);
  return v;
}

/**
 * @param {{rpcUrl: string, mint: string, decimals: number, treasuryKeypairPath: string}} tokenConfig
 * @param {{rpc?: object, treasury?: object, sleep?: (ms:number)=>Promise<void>, rebroadcastMs?: number, log?: Console}} overrides test seams (mock rpc etc.)
 */
export function createChain(tokenConfig, overrides = {}) {
  const rpc = overrides.rpc ?? createSolanaRpc(tokenConfig.rpcUrl);
  const sleep = overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rebroadcastMs = overrides.rebroadcastMs ?? REBROADCAST_INTERVAL_MS;
  const log = overrides.log ?? console;

  let treasuryPromise = overrides.treasury ? Promise.resolve(overrides.treasury) : null;
  let mintInfo = null;

  function getTreasury(path = tokenConfig.treasuryKeypairPath) {
    if (!treasuryPromise) treasuryPromise = loadTreasury(path);
    return treasuryPromise;
  }

  function wrapRpcError(err, what) {
    if (err instanceof ChainError) return err;
    return new RpcUnavailableError(`${what} failed: ${err?.message ?? err}`);
  }

  /** Resolve the mint's owner program + decimals; cache on success only.
   * If MUCHU_TOKEN_PROGRAM is configured we trust it (and MUCHU_DECIMALS) and
   * skip the on-chain lookup — this lets the treasury ATA be derived and the
   * system run before the mint is even created (its ATA simply reads as empty
   * until the token launches and the vault is funded). */
  async function getMintInfo() {
    if (mintInfo) return mintInfo;
    if (!tokenConfig.mint) throw new ChainError('MUCHU_MINT is not configured');
    const mintAddress = address(tokenConfig.mint);
    if (tokenConfig.tokenProgram) {
      const owner = tokenConfig.tokenProgram === 'token-2022'
        ? String(TOKEN_2022_PROGRAM_ADDRESS) : String(TOKEN_PROGRAM_ADDRESS);
      mintInfo = { address: String(mintAddress), programAddress: owner, program: tokenConfig.tokenProgram, decimals: tokenConfig.decimals };
      return mintInfo;
    }
    let res;
    try {
      res = await rpc.getAccountInfo(mintAddress, { encoding: 'base64' }).send();
    } catch (err) {
      throw wrapRpcError(err, 'getAccountInfo(mint)');
    }
    if (!res?.value) throw new ChainError(`mint account ${tokenConfig.mint} not found on-chain`);
    const owner = String(res.value.owner);
    let program;
    if (owner === String(TOKEN_PROGRAM_ADDRESS)) program = 'token';
    else if (owner === String(TOKEN_2022_PROGRAM_ADDRESS)) program = 'token-2022';
    else throw new ChainError(`mint owner ${owner} is not a known SPL token program`);
    const data = Buffer.from(res.value.data[0], 'base64');
    const decimals = data.length > 44 ? data[44] : tokenConfig.decimals;
    if (decimals !== tokenConfig.decimals) {
      log.warn(
        `[token] on-chain mint decimals ${decimals} != MUCHU_DECIMALS ${tokenConfig.decimals} — using on-chain value`,
      );
    }
    mintInfo = { address: String(mintAddress), programAddress: owner, program, decimals };
    return mintInfo;
  }

  function programModule(info) {
    return info.program === 'token-2022' ? splToken2022 : splToken;
  }

  async function ataFor(owner, info) {
    const [ata] = await programModule(info).findAssociatedTokenPda({
      owner: address(owner),
      mint: address(info.address),
      tokenProgram: address(info.programAddress),
    });
    return ata;
  }

  /** → {sol: bigint lamports, tokenRaw: bigint} of the treasury hot wallet. */
  async function getTreasuryState() {
    const treasury = await getTreasury();
    const info = await getMintInfo();
    let sol;
    let acc;
    try {
      sol = BigInt((await rpc.getBalance(treasury.address).send()).value);
      acc = await rpc.getAccountInfo(await ataFor(treasury.address, info), { encoding: 'base64' }).send();
    } catch (err) {
      throw wrapRpcError(err, 'getTreasuryState');
    }
    let tokenRaw = 0n;
    if (acc?.value) {
      const data = Buffer.from(acc.value.data[0], 'base64');
      if (data.length >= 72) tokenRaw = readU64LE(data, 64); // token account amount
    }
    return { sol, tokenRaw };
  }

  /** → null | {slot, err, confirmationStatus} for a stored signature. */
  async function getSignatureStatus(signature) {
    let res;
    try {
      res = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
    } catch (err) {
      throw wrapRpcError(err, 'getSignatureStatuses');
    }
    return res?.value?.[0] ?? null;
  }

  async function getCurrentBlockHeight() {
    try {
      return BigInt(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
    } catch (err) {
      throw wrapRpcError(err, 'getBlockHeight');
    }
  }

  /**
   * Sign + send ONE transfer attempt for a withdrawal. See module docblock for
   * the durability rules. Resolves {signature, slot} once confirmed.
   * @param {{destAddress: string, rawAmount: bigint,
   *          onPersistSignature: (p: {signature: string, lastValidBlockHeight: bigint}) => any,
   *          onSubmitted?: () => any}} params
   */
  async function sendWithdrawal({ destAddress, rawAmount, onPersistSignature, onSubmitted }) {
    const treasury = await getTreasury();
    const info = await getMintInfo();
    let dest;
    try {
      dest = address(destAddress);
    } catch (err) {
      throw new InvalidDestinationError(`invalid destination address: ${err.message}`);
    }
    const mod = programModule(info);
    const mintAddress = address(info.address);
    const tokenProgram = address(info.programAddress);
    const treasuryAta = await ataFor(treasury.address, info);
    const destAta = await ataFor(dest, info);
    const instructions = [
      computeUnitLimitInstruction(COMPUTE_UNIT_LIMIT),
      computeUnitPriceInstruction(COMPUTE_UNIT_PRICE_MICROLAMPORTS),
      // Idempotent: creates the player's ATA iff missing; treasury pays rent.
      mod.getCreateAssociatedTokenIdempotentInstruction({
        payer: treasury,
        ata: destAta,
        owner: dest,
        mint: mintAddress,
        tokenProgram,
      }),
      mod.getTransferCheckedInstruction({
        source: treasuryAta,
        mint: mintAddress,
        destination: destAta,
        authority: treasury,
        amount: BigInt(rawAmount),
        decimals: info.decimals,
      }),
    ];

    let latest;
    try {
      latest = (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
    } catch (err) {
      throw wrapRpcError(err, 'getLatestBlockhash');
    }
    const lastValidBlockHeight = BigInt(latest.lastValidBlockHeight);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(treasury, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: latest.blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signedTx = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signedTx);
    const wire = getBase64EncodedWireTransaction(signedTx);

    // Persist BEFORE the first send: if we crash after this, recovery can
    // find/track the signature instead of double-spending with a re-sign.
    await onPersistSignature({ signature, lastValidBlockHeight });

    let submitted = false;
    let rpcErrors = 0;
    for (;;) {
      // (Re)broadcast the SAME signed bytes. Duplicate sends of an identical
      // transaction are idempotent on-chain.
      try {
        await rpc
          .sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n })
          .send();
        rpcErrors = 0;
        if (!submitted) {
          submitted = true;
          await onSubmitted?.();
        }
      } catch {
        rpcErrors++;
      }

      let status;
      let statusKnown = false;
      try {
        status = await getSignatureStatus(signature);
        statusKnown = true;
        rpcErrors = 0;
      } catch {
        rpcErrors++;
      }
      if (statusKnown && status?.err) {
        throw new TransactionFailedError(
          `transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
        );
      }
      if (statusKnown && status && CONFIRMED.has(status.confirmationStatus)) {
        return { signature, slot: status.slot ?? null };
      }

      if (statusKnown && status == null) {
        let height = null;
        try {
          height = await getCurrentBlockHeight();
          rpcErrors = 0;
        } catch {
          rpcErrors++;
        }
        if (height != null && height > lastValidBlockHeight) {
          // Provably expired — one final status check before giving up on
          // this signature (never re-sign on a mere timeout).
          let finalStatus;
          try {
            finalStatus = await getSignatureStatus(signature);
          } catch {
            finalStatus = undefined;
          }
          if (finalStatus?.err) {
            throw new TransactionFailedError(
              `transaction ${signature} failed on-chain: ${JSON.stringify(finalStatus.err)}`,
            );
          }
          if (finalStatus && CONFIRMED.has(finalStatus.confirmationStatus)) {
            return { signature, slot: finalStatus.slot ?? null };
          }
          if (finalStatus === null) {
            throw new BlockhashExpiredError(
              `blockhash expired (height ${height} > ${lastValidBlockHeight}) and ` +
              `signature ${signature} was never seen — safe to re-sign`,
            );
          }
        }
      }

      if (rpcErrors >= MAX_CONSECUTIVE_RPC_ERRORS) {
        throw new RpcUnavailableError(
          `rpc unreachable while tracking ${signature}; will resume from persisted signature`,
        );
      }
      await sleep(rebroadcastMs);
    }
  }

  return {
    loadTreasury: getTreasury,
    getMintInfo,
    getTreasuryState,
    getSignatureStatus,
    getCurrentBlockHeight,
    sendWithdrawal,
  };
}
