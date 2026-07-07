// worker.js — single-flight withdrawal queue + crash recovery + circuit
// breaker + solvency monitor.
//
// Row lifecycle it drives (see ledger.js for the legal transitions):
//   requested → (bridge debit + journal) → debited → (sign; persist signature
//   BEFORE first send) → signed → submitted → confirmed
//   permanent failure ⇒ failed → (bridge credit + reversal entry) → refunded
//
// Crash recovery on boot (and every drain): rows in signed/submitted have a
// persisted signature — CHECK IT before anything else; never re-sign until the
// blockhash is provably expired (height > lastValidBlockHeight) AND the status
// is still null.
//
// Circuit breaker: WITHDRAWALS_ENABLED=false, a solvency failure, or a tripped
// global daily cap pause the worker — 'requested' rows stay 'requested'.
// In-flight rows (already debited/signed) are still driven to conclusion,
// except that a solvency pause also blocks NEW on-chain sends.
import { formatRawAmount, parseLooseAmountToRaw } from './ledger.js';

const DRAIN_POLL_MS = 5_000;
const SOLVENCY_INTERVAL_MS = 60 * 60 * 1000;
const SOLVENCY_BOOT_RETRY_MS = 30_000;
const MAX_RESIGN_ATTEMPTS = 3;

const PERMANENT_CHAIN_CODES = new Set(['TX_FAILED', 'INVALID_DESTINATION']);
const PERMANENT_BRIDGE_CODES = new Set(['INSUFFICIENT', 'NOT_FOUND', 'BAD_REQUEST']);

/**
 * @param {{
 *   ledger: ReturnType<import('./ledger.js').createLedger>,
 *   bridge: ReturnType<import('./bridge-client.js').createBridgeClient>,
 *   chain: object, tokenConfig: object,
 *   getUsername?: (userId: number) => string|null,
 *   getUsernames?: () => string[],
 *   log?: Console, now?: () => number,
 *   pollMs?: number, solvencyMs?: number,
 * }} deps
 */
export function createWorker({
  ledger,
  bridge,
  chain,
  tokenConfig,
  getUsername = (userId) => ledger.getUsername(userId),
  getUsernames = () => ledger.listUsernames(),
  log = console,
  now = Date.now,
  pollMs = DRAIN_POLL_MS,
  solvencyMs = SOLVENCY_INTERVAL_MS,
  solvencyBootRetryMs = SOLVENCY_BOOT_RETRY_MS,
}) {
  // key → human reason. Worker is paused while non-empty.
  const pauseReasons = new Map();
  if (!tokenConfig.withdrawalsEnabled) {
    pauseReasons.set('config', 'withdrawals are disabled (WITHDRAWALS_ENABLED=false)');
  }

  let solvent = true; // optimistic until a check says otherwise
  let lastSolvencyAt = null;
  let draining = null; // in-flight drain promise
  let kickAgain = false;
  let stopped = false;
  let timers = [];

  function status() {
    const paused = pauseReasons.size > 0;
    return {
      paused,
      reason: paused ? [...pauseReasons.values()][0] : null,
      reasons: Object.fromEntries(pauseReasons),
      solvent,
      lastSolvencyAt,
    };
  }

  // --- solvency monitor -----------------------------------------------------

  /**
   * liability = Σ in-game balances (bridge POST /balances over every user in
   * the db) + Σ non-terminal withdrawal amounts. Pause loudly when the
   * treasury cannot cover it. Returns {ok:true|false, ...} or {ok:null} when
   * the check itself failed (bridge/RPC down — keep the previous verdict).
   */
  async function checkSolvency() {
    let liabilityRaw = 0n;
    try {
      const usernames = await getUsernames();
      if (usernames.length > 0) {
        const balances = await bridge.balances(usernames);
        for (const value of Object.values(balances)) {
          liabilityRaw += parseLooseAmountToRaw(value, tokenConfig.decimals);
        }
      }
      liabilityRaw += ledger.pendingTotalRaw();
      const { tokenRaw } = await chain.getTreasuryState();
      lastSolvencyAt = now();
      if (tokenRaw < liabilityRaw) {
        solvent = false;
        const msg =
          `treasury holds ${formatRawAmount(tokenRaw, tokenConfig.decimals)} MUCHU but owes ` +
          `${formatRawAmount(liabilityRaw, tokenConfig.decimals)} MUCHU`;
        pauseReasons.set('solvency', `insolvent: ${msg}`);
        log.error(`[token] *** SOLVENCY FAILURE — WITHDRAWALS PAUSED *** ${msg}`);
        return { ok: false, liabilityRaw, treasuryRaw: tokenRaw };
      }
      solvent = true;
      if (pauseReasons.delete('solvency')) {
        log.warn('[token] solvency restored — withdrawals resume');
      }
      return { ok: true, liabilityRaw, treasuryRaw: tokenRaw };
    } catch (err) {
      log.warn(`[token] solvency check failed (keeping previous verdict): ${err.message}`);
      return { ok: null, error: err.message };
    }
  }

  // --- helpers ----------------------------------------------------------------

  function playerFor(row) {
    return getUsername(row.userId);
  }

  function amountString(row) {
    return formatRawAmount(row.amountRaw, tokenConfig.decimals);
  }

  /**
   * Permanent failure: mark 'failed', then (iff the in-game debit journal
   * exists) refund via bridge credit + reversal entry → 'refunded'. If the
   * bridge is down the row stays 'failed' and retryRefunds() picks it up.
   */
  async function failWithRefund(id, errorMessage) {
    let row = ledger.getWithdrawal(id);
    if (row.state !== 'failed') {
      row = ledger.transition(id, 'failed', { error: errorMessage });
      log.warn(`[token] withdrawal ${id} failed: ${errorMessage}`);
    }
    await tryRefund(row);
  }

  async function tryRefund(row) {
    if (!ledger.hasEntry(`withdraw:${row.id}:debit`)) return; // never debited — nothing to refund
    if (ledger.hasEntry(`withdraw:${row.id}:refund`)) {
      // Journal already reversed (crash between journal and state flip).
      if (ledger.getWithdrawal(row.id).state === 'failed') ledger.transition(row.id, 'refunded');
      return;
    }
    const player = playerFor(row);
    if (!player) {
      log.error(`[token] withdrawal ${row.id}: cannot refund, unknown user ${row.userId}`);
      return;
    }
    try {
      await bridge.credit({ player, amount: amountString(row), ref: `withdraw:${row.id}:refund` });
    } catch (err) {
      log.warn(`[token] withdrawal ${row.id}: refund credit failed (${err.message}); will retry`);
      return; // stays 'failed'; retried on the next drain
    }
    ledger.recordRefund(row.id);
    log.warn(`[token] withdrawal ${row.id} refunded ${amountString(row)} MUCHU to ${player}`);
  }

  /** 'failed' rows that were debited but never refunded (crash / bridge down). */
  async function retryRefunds() {
    for (const row of ledger.rowsInStates(['failed'])) {
      if (stopped) return;
      if (!ledger.hasEntry(`withdraw:${row.id}:debit`)) continue; // terminal fail, no money moved
      if (ledger.hasEntry(`withdraw:${row.id}:refund`) &&
          ledger.getWithdrawal(row.id).state === 'refunded') continue;
      await tryRefund(row);
    }
  }

  // --- crash recovery for signed/submitted rows -------------------------------

  /**
   * Check the persisted signature BEFORE anything else. Outcomes:
   *  - confirmed/finalized  → 'confirmed' (journal already reflects the debit)
   *  - on-chain error       → failed → refund
   *  - null + height > lastValidBlockHeight → provably expired → back to
   *    'debited' (safe to re-sign)
   *  - null + not expired   → leave it; poll again next drain (NEVER re-sign)
   */
  async function recoverInFlight() {
    for (const row of ledger.rowsInStates(['signed', 'submitted'])) {
      if (stopped) return;
      if (!row.signature) {
        // Should be impossible ('signed' is only set with a signature) — be safe.
        await failWithRefund(row.id, 'signed state without persisted signature');
        continue;
      }
      let st;
      try {
        st = await chain.getSignatureStatus(row.signature);
      } catch (err) {
        log.warn(`[token] recovery: status check failed for ${row.id}: ${err.message}`);
        return; // RPC down — retry next drain
      }
      if (st?.err) {
        await failWithRefund(row.id, `on-chain failure: ${JSON.stringify(st.err)}`);
        continue;
      }
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        ledger.transition(row.id, 'confirmed');
        log.log(`[token] withdrawal ${row.id} confirmed (recovered): ${row.signature}`);
        continue;
      }
      // Status null (or merely 'processed'): only a provably expired blockhash
      // with a still-null status permits a re-sign.
      if (st != null) continue; // seen on-chain, not yet confirmed — keep waiting
      let height;
      try {
        height = await chain.getCurrentBlockHeight();
      } catch (err) {
        log.warn(`[token] recovery: block height check failed: ${err.message}`);
        return;
      }
      if (row.lastValidBlockHeight != null && height > row.lastValidBlockHeight) {
        let again;
        try {
          again = await chain.getSignatureStatus(row.signature);
        } catch {
          return;
        }
        if (again?.err) {
          await failWithRefund(row.id, `on-chain failure: ${JSON.stringify(again.err)}`);
        } else if (
          again &&
          (again.confirmationStatus === 'confirmed' || again.confirmationStatus === 'finalized')
        ) {
          ledger.transition(row.id, 'confirmed');
        } else if (again === null) {
          log.warn(
            `[token] withdrawal ${row.id}: blockhash expired unseen (${height} > ` +
            `${row.lastValidBlockHeight}) — re-signing`,
          );
          ledger.transition(row.id, 'debited'); // picked up by the debited pass
        }
      }
      // else: still within the blockhash lifetime — wait, do not re-sign.
    }
  }

  // --- send phase (rows in 'debited') ------------------------------------------

  async function sendPhase(id) {
    if (pauseReasons.has('solvency')) return; // no NEW on-chain sends while insolvent
    for (let attempt = 1; attempt <= MAX_RESIGN_ATTEMPTS; attempt++) {
      const row = ledger.getWithdrawal(id);
      try {
        const { signature } = await chain.sendWithdrawal({
          destAddress: row.destAddress,
          rawAmount: row.amountRaw,
          onPersistSignature: ({ signature: sig, lastValidBlockHeight }) => {
            ledger.transition(id, 'signed', { signature: sig, lastValidBlockHeight });
          },
          onSubmitted: () => {
            ledger.transition(id, 'submitted');
          },
        });
        ledger.transition(id, 'confirmed');
        log.log(`[token] withdrawal ${id} confirmed: ${signature}`);
        return;
      } catch (err) {
        if (err?.code === 'BLOCKHASH_EXPIRED') {
          // Provably expired, never landed — safe to re-sign with a fresh blockhash.
          ledger.transition(id, 'debited');
          log.warn(`[token] withdrawal ${id}: blockhash expired (attempt ${attempt}); re-signing`);
          continue;
        }
        if (PERMANENT_CHAIN_CODES.has(err?.code)) {
          await failWithRefund(id, err.message);
          return;
        }
        // RPC down / unknown outcome: leave the row as-is (debited, signed or
        // submitted). recoverInFlight() resumes from the persisted signature.
        log.warn(`[token] withdrawal ${id}: send interrupted (${err.message}); will resume`);
        return;
      }
    }
    log.warn(`[token] withdrawal ${id}: ${MAX_RESIGN_ATTEMPTS} expired attempts; retrying later`);
  }

  // --- requested rows ------------------------------------------------------------

  /** @returns {'done'|'paused'|'bridge-down'} */
  async function processRequested(row) {
    if (pauseReasons.size > 0) return 'paused';
    // Global-cap circuit breaker: the trailing-24h sum INCLUDES this row.
    if (tokenConfig.globalDailyCapRaw != null
      && ledger.globalDailyTotalRaw(now()) > tokenConfig.globalDailyCapRaw) {
      pauseReasons.set('global-cap', 'global daily withdrawal cap reached');
      log.error('[token] global daily cap tripped — withdrawals paused');
      return 'paused';
    }
    const player = playerFor(row);
    if (!player) {
      ledger.transition(row.id, 'failed', { error: `unknown user id ${row.userId}` });
      return 'done';
    }
    try {
      await bridge.debit({ player, amount: amountString(row), ref: `withdraw:${row.id}` });
    } catch (err) {
      if (PERMANENT_BRIDGE_CODES.has(err?.code)) {
        // Nothing was debited — terminal 'failed', no refund needed.
        ledger.transition(row.id, 'failed', { error: `in-game debit refused: ${err.message}` });
        return 'done';
      }
      log.warn(`[token] withdrawal ${row.id}: bridge debit failed (${err.message}); retrying later`);
      return 'bridge-down';
    }
    ledger.recordDebit(row.id); // 'debited' + balanced journal entry, atomically
    await sendPhase(row.id);
    return 'done';
  }

  // --- drain loop -------------------------------------------------------------

  async function drainOnce() {
    // 1. Crash recovery / in-flight tracking first: persisted signatures.
    await recoverInFlight();
    // 2. Refunds owed (always safe: gives money back).
    await retryRefunds();
    // 3. Rows already debited (crash between debit and sign, or expired re-sign).
    for (const row of ledger.rowsInStates(['debited'])) {
      if (stopped) return;
      await sendPhase(row.id);
    }
    // 4. New requests, oldest first — gated by the circuit breaker.
    if (pauseReasons.has('global-cap') &&
        ledger.globalDailyTotalRaw(now()) <= tokenConfig.globalDailyCapRaw) {
      pauseReasons.delete('global-cap'); // window rolled over
      log.warn('[token] global daily cap headroom restored — withdrawals resume');
    }
    for (const row of ledger.rowsInStates(['requested'])) {
      if (stopped) return;
      const outcome = await processRequested(row);
      if (outcome !== 'done') return; // paused or bridge down — stop this pass
    }
  }

  /** Single-flight: concurrent kicks coalesce into one extra pass. */
  function drain() {
    if (draining) {
      kickAgain = true;
      return draining;
    }
    draining = (async () => {
      do {
        kickAgain = false;
        try {
          await drainOnce();
        } catch (err) {
          log.error(`[token] worker drain error: ${err.message}`);
        }
      } while (kickAgain && !stopped);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  function kick() {
    if (stopped) return;
    void drain();
  }

  function start() {
    stopped = false;
    // Solvency check on start, then recover + drain (recovery runs first
    // inside the drain), then steady-state timers.
    void (async () => {
      let verdict = await checkSolvency();
      await drain();
      // The boot check routinely races the game server: Paper binds the MC
      // port (which gates our own startup) BEFORE plugins like MuchuBridge
      // come up, so the first check often can't reach the bridge. An unknown
      // verdict must not stand for a whole solvency interval — retry soon
      // until we get a definitive answer.
      while (!stopped && verdict.ok === null) {
        await new Promise((resolve) => setTimeout(resolve, solvencyBootRetryMs).unref?.());
        if (stopped) return;
        verdict = await checkSolvency();
      }
    })();
    const t1 = setInterval(kick, pollMs);
    const t2 = setInterval(() => void checkSolvency(), solvencyMs);
    t1.unref?.();
    t2.unref?.();
    timers = [t1, t2];
  }

  function stop() {
    stopped = true;
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  return { start, stop, kick, drain, checkSolvency, status };
}
