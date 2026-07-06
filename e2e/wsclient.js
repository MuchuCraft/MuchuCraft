// e2e/wsclient.js — dials the gateway net proxy EXACTLY like the browser
// client does:
//   1. POST /api/vm/net/connect  (Authorization: Bearer <session token>,
//      JSON body {host, port}) → { token: <connection token>, remote }
//   2. WS  /api/vm/net/socket?token=<connection token>
//   3. wrap the WS with createWebSocketStream → binary duplex carrying raw
//      Minecraft protocol bytes.
//
// The returned handle additionally records text frames (the proxy sends
// `proxy-shutdown:<reason>` as a text frame before killing a connection)
// and close events, so tests can assert on them.
import WebSocket, { createWebSocketStream } from 'ws';

/**
 * Open a proxied byte stream to the Minecraft server through the gateway.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl   e.g. "http://localhost:8080"
 * @param {string} [opts.bearerToken] session token; omitted → no Authorization header
 * @param {string} [opts.host]       requested host (defaults to MC_HOST from env)
 * @param {number} [opts.port]       requested port (defaults to MC_PORT from env)
 * @returns handle: {
 *   stream,             // binary Duplex (createWebSocketStream)
 *   ws,                 // underlying WebSocket
 *   connectionToken,    // single-use token issued by /connect
 *   remote,             // {address, family, port} socket.address() object from the gateway
 *   textFrames,         // string[] — every text frame received so far
 *   closed, closeCode, closeReason,
 *   waitForShutdownOrClose(timeoutMs) → Promise<{type:'shutdown'|'close'|'timeout', ...}>
 * }
 *
 * On a non-2xx /connect response, throws an Error with `.status` and `.body`.
 */
export async function openProxyStream({ gatewayUrl, bearerToken, host, port } = {}) {
  if (!gatewayUrl) throw new Error('openProxyStream: gatewayUrl is required');
  const mcHost = host ?? process.env.MC_HOST ?? '127.0.0.1';
  const mcPort = Number(port ?? process.env.MC_PORT ?? 25565);

  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken !== undefined && bearerToken !== null) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const res = await fetch(new URL('/api/vm/net/connect', gatewayUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({ host: mcHost, port: mcPort }),
    signal: AbortSignal.timeout(10_000),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body; leave null
  }

  if (!res.ok) {
    const detail = body && body.error ? ` (${body.error})` : '';
    const err = new Error(`POST /api/vm/net/connect → HTTP ${res.status}${detail}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (!body || typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('POST /api/vm/net/connect: response has no connection token');
  }

  const wsUrl = new URL('/api/vm/net/socket', gatewayUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('token', body.token);

  const ws = new WebSocket(wsUrl.href);

  const textListeners = new Set();
  const closeListeners = new Set();

  const handle = {
    ws,
    stream: null,
    connectionToken: body.token,
    remote: body.remote ?? null,
    textFrames: [],
    closed: false,
    closeCode: null,
    closeReason: null,

    /**
     * Resolve when a `proxy-shutdown*` text frame arrives, the socket
     * closes, or `timeoutMs` elapses (never rejects):
     *   {type:'shutdown', reason} | {type:'close', code, reason} | {type:'timeout'}
     */
    waitForShutdownOrClose(timeoutMs = 15_000) {
      return new Promise((resolve) => {
        const already = handle.textFrames.find((t) => t.startsWith('proxy-shutdown'));
        if (already) return resolve({ type: 'shutdown', reason: already });
        if (handle.closed) {
          return resolve({ type: 'close', code: handle.closeCode, reason: handle.closeReason });
        }
        const finish = (result) => {
          clearTimeout(timer);
          textListeners.delete(onText);
          closeListeners.delete(onClose);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
        const onText = (text) => {
          if (text.startsWith('proxy-shutdown')) finish({ type: 'shutdown', reason: text });
        };
        const onClose = () =>
          finish({ type: 'close', code: handle.closeCode, reason: handle.closeReason });
        textListeners.add(onText);
        closeListeners.add(onClose);
      });
    },
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // binary frames flow through the duplex stream
    const text = data.toString('utf8');
    handle.textFrames.push(text);
    for (const fn of [...textListeners]) fn(text);
  });

  ws.on('close', (code, reason) => {
    handle.closed = true;
    handle.closeCode = code;
    handle.closeReason = reason ? reason.toString('utf8') : '';
    for (const fn of [...closeListeners]) fn();
  });

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.off('error', onError);
      ws.off('close', onEarlyClose);
      resolve();
    };
    const onError = (err) => {
      ws.off('open', onOpen);
      ws.off('close', onEarlyClose);
      reject(new Error(`WS /api/vm/net/socket failed to open: ${err.message}`));
    };
    const onEarlyClose = (code) => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      reject(new Error(`WS /api/vm/net/socket closed before open (code ${code})`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onEarlyClose);
  });

  handle.stream = createWebSocketStream(ws);
  // The duplex re-emits WS errors; without at least one listener an expected
  // teardown (e.g. proxy killing an impostor) would crash the process.
  handle.stream.on('error', () => {});

  return handle;
}
