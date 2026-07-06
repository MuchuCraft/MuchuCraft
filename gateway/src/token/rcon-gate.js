// rcon-gate.js — earn-gate promotion over RCON (SPEC-PHASE3 §2).
//
// The deposits watcher calls promoteToDepositor(username) whenever a user's
// cumulative credited deposits reach DEPOSIT_GATE_MIN (and again on every
// later credited deposit — idempotent insurance). We run
//   lp user <username> parent add depositor
// against the live Paper server. The `depositor` LuckPerms group (created by
// scripts/lp-bootstrap.sh, weight 10) grants jobs.join.<job> for ALL jobs,
// out-weighing the default group's negations — verified live on Jobs 5.2.6.3
// + LuckPerms 5.5.53 (see docs/EARN-GATE.md).
//
// Behavior notes (verified empirically):
//   - LuckPerms executes RCON commands asynchronously and its output never
//     reaches the RCON response packet, so success cannot be read back here.
//     Re-adding an existing parent is a harmless no-op, which is why the
//     watcher's repeat calls are safe.
//   - `lp user <name> ...` resolves offline players from LuckPerms' own data;
//     it only fails (silently) for users who have never joined the server —
//     those get promoted by a later deposit tick or after their first join
//     triggers another credited deposit poll.
//
// Same reliability contract as src/rcon.js: lazy connect per call, 3s timeout
// on every step, NEVER throws, failures are logged and dropped.
import { Rcon } from 'rcon-client';

const TIMEOUT_MS = 3000;
// Same charset the auth layer enforces for usernames; also guarantees the
// interpolated RCON command cannot be malformed.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** Reject after `ms` even if `promise` never settles (timer unref'd). */
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Factory (test seam): a gate bound to explicit RCON settings.
 * @param {{host?: string, port?: number, password?: string, group?: string}} opts
 * @returns {{promoteToDepositor(username: string): Promise<boolean>}}
 */
export function createRconGate({ host = '127.0.0.1', port = 25575, password = '', group = 'depositor' } = {}) {
  /**
   * Add `username` to the depositor LuckPerms group. Never throws.
   * @returns {Promise<boolean>} true iff the RCON command was delivered
   *   (LuckPerms applies it asynchronously; delivery is all we can observe).
   */
  async function promoteToDepositor(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      console.warn(`[deposits] rcon-gate: refusing to promote invalid username ${JSON.stringify(username)}`);
      return false;
    }
    let client = null;
    // Keep a handle on the raw connect promise so a connection that resolves
    // AFTER our timeout still gets closed instead of leaking a socket.
    const connecting = Rcon.connect({ host, port, password, timeout: TIMEOUT_MS });
    connecting.catch(() => {}); // swallow late rejections
    try {
      client = await withTimeout(connecting, TIMEOUT_MS, 'rcon connect');
      await withTimeout(client.send(`lp user ${username} parent add ${group}`), TIMEOUT_MS, 'rcon send');
      console.log(`[deposits] rcon-gate: promoted ${username} to '${group}' (lp parent add sent)`);
      return true;
    } catch (err) {
      console.warn(`[deposits] rcon-gate: promote ${username} dropped: ${err?.message ?? err}`);
      if (!client) connecting.then((late) => late.end()).catch(() => {});
      return false;
    } finally {
      if (client) {
        try { await client.end(); } catch { /* already closed */ }
      }
    }
  }

  return { promoteToDepositor };
}

let defaultGate = null;

/**
 * Default instance for index.js wiring: RCON settings are read lazily from
 * process.env on first use (loadConfig() has already loaded root .env by the
 * time the deposits watcher makes its first call). Never throws.
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export function promoteToDepositor(username) {
  if (!defaultGate) {
    defaultGate = createRconGate({
      host: process.env.MC_HOST || '127.0.0.1',
      port: Number.parseInt(process.env.RCON_PORT, 10) || 25575,
      password: process.env.RCON_PASSWORD || '',
    });
  }
  return defaultGate.promoteToDepositor(username);
}
