// rcon.js — best-effort RCON messenger for in-game welcome messages.
// Lazy connect per command batch, 3s timeout on every step, queue-less
// (commands are dropped on any failure), NEVER throws (SPEC "RCON").
import { Rcon } from 'rcon-client';

const TIMEOUT_MS = 3000;

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
 * @param {{host?: string, port: number, password: string}} opts
 * @returns {{ sendWelcome(username: string, shortAddr: string, firstLogin: boolean): void }}
 */
export function createRcon({ host = '127.0.0.1', port, password }) {
  /** Connect, run the commands in order, disconnect. Logs failures, never throws. */
  async function run(commands) {
    let client = null;
    // Keep a handle on the raw connect promise so a connection that resolves
    // AFTER our timeout still gets closed instead of leaking a socket.
    const connecting = Rcon.connect({ host, port, password, timeout: TIMEOUT_MS });
    connecting.catch(() => {}); // swallow late rejections
    try {
      client = await withTimeout(connecting, TIMEOUT_MS, 'rcon connect');
      for (const cmd of commands) {
        await withTimeout(client.send(cmd), TIMEOUT_MS, 'rcon send');
      }
    } catch (err) {
      console.warn(`[proxy] rcon command dropped: ${err?.message ?? err}`);
      if (!client) connecting.then((late) => late.end()).catch(() => {});
    } finally {
      if (client) {
        try { await client.end(); } catch { /* already closed */ }
      }
    }
  }

  /**
   * ~4s after a proxied connection passes the username sniff (the caller owns
   * the delay), whisper the wallet-verified notice; on first-ever login also
   * broadcast the claim. Fire-and-forget.
   */
  function sendWelcome(username, shortAddr, firstLogin) {
    try {
      const commands = [
        `tellraw ${username} {"text":"[MuchuCraft] ","color":"aqua","extra":[{"text":"Wallet verified: ${shortAddr}","color":"gray"}]}`,
      ];
      if (firstLogin) {
        commands.push(
          `tellraw @a {"text":"${username} claimed their username with a Solana wallet ✔","color":"green"}`,
        );
      }
      run(commands); // async, self-contained error handling
    } catch (err) {
      console.warn(`[proxy] rcon welcome failed: ${err?.message ?? err}`);
    }
  }

  return { sendWelcome };
}
