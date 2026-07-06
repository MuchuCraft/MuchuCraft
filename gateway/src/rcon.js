// rcon.js — best-effort RCON messenger for in-game welcome messages and
// SkinsRestorer skin application (SPEC-PHASE3.md §4).
// Lazy connect per command batch, 3s timeout on every step, queue-less
// (commands are dropped on any failure), NEVER throws (SPEC "RCON").
import { Rcon } from 'rcon-client';

const TIMEOUT_MS = 3000;

// Stored skin descriptor formats (users.skin) — re-validated here as defense
// in depth: these values are interpolated into a space-delimited console
// command, so anything else (whitespace, control chars, stray input) must
// yield null instead of a command.
const SKIN_NAME_RE = /^name:[A-Za-z0-9_]{3,16}$/;
const SKIN_URL_RE = /^url:https:\/\/[\x21-\x7e]+\.png$/i;
const MC_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const SKIN_MAX_LEN = 300;

/**
 * Build the SkinsRestorer CONSOLE command that applies `skin` to `username`.
 * Syntax verified against the shipped SkinsRestorer 15.12.4 jar
 * (net/skinsrestorer/shared/commands/SkinCommand.class): root command `skin`,
 * subcommand `set|select <skinName> <selector>`, and the <skinName> argument
 * accepts https URLs too (ValidationUtil.validSkinUrl -> MineSkin upload), so
 * ONE console form covers both stored formats:
 *     skin set <mcname-or-https-png-url> <player>
 * (`/skin url ...` is player-only — unusable from console — hence `set`.)
 * Live verification after the integrator restarts the server: docs/SKINS.md.
 * @returns {string|null} the command, or null when either input is invalid.
 */
export function buildSkinCommand(username, skin) {
  if (typeof username !== 'string' || !MC_NAME_RE.test(username)) return null;
  if (typeof skin !== 'string' || skin.length > SKIN_MAX_LEN) return null;
  if (!SKIN_NAME_RE.test(skin) && !SKIN_URL_RE.test(skin)) return null;
  const input = skin.slice(skin.indexOf(':') + 1); // strip "name:" / "url:"
  return `skin set ${input} ${username}`;
}

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
 * @returns {{
 *   sendWelcome(username: string, shortAddr: string, firstLogin: boolean): void,
 *   applySkin(username: string, skin: string): void,
 * }}
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

  /**
   * Apply the user's stored skin via the SkinsRestorer console command —
   * ~2s after a verified join (the caller owns the delay), and immediately
   * after POST /api/auth/skin while the player is online (a miss on an
   * offline player is harmless: SkinsRestorer just reports unknown player,
   * and the next join re-applies). Fire-and-forget, never throws.
   */
  function applySkin(username, skin) {
    try {
      const command = buildSkinCommand(username, skin);
      if (!command) return; // unset or invalid — nothing to send
      console.log(`[proxy] rcon skin apply: ${command}`);
      run([command]); // async, self-contained error handling
    } catch (err) {
      console.warn(`[proxy] rcon skin apply failed: ${err?.message ?? err}`);
    }
  }

  return { sendWelcome, applySkin };
}
