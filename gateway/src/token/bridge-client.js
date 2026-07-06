// bridge-client.js — tiny fetch wrapper for the MuchuBridge Paper plugin
// (localhost HTTP, Bearer BRIDGE_TOKEN). 2s timeout, typed errors.
//
// Error codes:
//   UNAVAILABLE   network error / timeout / 5xx  (retryable)
//   UNAUTHORIZED  bad BRIDGE_TOKEN               (config problem)
//   NOT_FOUND     player never joined            (permanent for that request)
//   INSUFFICIENT  debit would overdraw           (permanent for that request)
//   BAD_REQUEST   malformed request              (permanent)
export class BridgeError extends Error {
  constructor(message, { code = 'BRIDGE_ERROR', status = null, retryable = false } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * @param {{baseUrl: string, token: string, timeoutMs?: number, fetchImpl?: typeof fetch}} opts
 */
export function createBridgeClient({ baseUrl, token, timeoutMs = 2000, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, pathname, body = undefined) {
    let res;
    try {
      res = await fetchImpl(`${root}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BridgeError(`bridge unreachable: ${err.message}`, {
        code: 'UNAVAILABLE',
        retryable: true,
      });
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      // non-JSON body — fall through to status mapping
    }
    if (res.ok) return data;
    const msg = data?.error || `bridge HTTP ${res.status}`;
    if (res.status === 401) throw new BridgeError(msg, { code: 'UNAUTHORIZED', status: 401 });
    if (res.status === 404) throw new BridgeError(msg, { code: 'NOT_FOUND', status: 404 });
    if (res.status === 409) throw new BridgeError(msg, { code: 'INSUFFICIENT', status: 409 });
    if (res.status === 400) throw new BridgeError(msg, { code: 'BAD_REQUEST', status: 400 });
    throw new BridgeError(msg, {
      code: res.status >= 500 ? 'UNAVAILABLE' : 'BRIDGE_ERROR',
      status: res.status,
      retryable: res.status >= 500,
    });
  }

  return {
    /** → {ok:true, economy:"<provider>"} */
    health: () => request('GET', '/health'),

    /** → decimal string balance; throws NOT_FOUND if the player never joined. */
    async balance(player) {
      const data = await request('GET', `/balance?player=${encodeURIComponent(player)}`);
      return String(data.balance);
    },

    /** Atomic has()+withdraw. → {ok:true, newBalance}. Throws INSUFFICIENT. */
    debit: ({ player, amount, ref }) => request('POST', '/debit', { player, amount, ref }),

    /** → {ok:true, newBalance} */
    credit: ({ player, amount, ref }) => request('POST', '/credit', { player, amount, ref }),

    /** → {name: "12.34", ...} (unknown players skipped by the plugin). */
    async balances(players) {
      const data = await request('POST', '/balances', { players });
      return data.balances ?? {};
    },
  };
}
