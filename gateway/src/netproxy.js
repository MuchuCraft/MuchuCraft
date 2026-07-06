// netproxy.js — the browser<->Minecraft proxy (SPEC "Proxy wire protocol",
// reconciled against client/NOTES.md which reflects the real shipped client):
//   POST /api/vm/net/connect  Bearer session token -> dial MC, mint connection token
//   GET  /api/vm/net/connect  unauthenticated health probe
//   WS   /api/vm/net/socket?token=...  binary frames <-> TCP bytes, with the
//        Login Start username sniffed and enforced before any byte is forwarded
//   WS   /api/vm/net/ping     optional latency endpoint (unused by the client;
//        the real latency UI pings over the DATA socket: "ping:<id>" -> "pong:<id>")
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createLoginSniffer } from './mcsniff.js';
import { createRcon } from './rcon.js';

const SOCKET_PATH = '/api/vm/net/socket';
const PING_PATH = '/api/vm/net/ping';

/**
 * @param {object} opts
 * @param {{mcHost:string, mcPort:number, mcVersion:string, rconPort:number, rconPassword:string}} opts.env
 * @param {(token: string) => null | {userId:number, username:string, address:string, skin?:string|null}} opts.sessionLookup
 * @param {(userId: number) => {firstLogin: boolean}} opts.markLogin
 * Remaining options are tunables/injection points for tests; production
 * callers (index.js) pass only the three above and get the defaults.
 * @returns {{router: import('express').Router, handleUpgrade: (server: import('http').Server) => void}}
 */
export function createNetProxy({
  env,
  sessionLookup,
  markLogin,
  claimTtlMs = 30_000,
  sniffTimeoutMs = 10_000,
  dialTimeoutMs = 5_000,
  rconDelayMs = 4_000,
  // The skin apply must not fire before the player finishes the configuration
  // phase and is visible online, or SkinsRestorer's <selector> misses (verified
  // live: an apply 2s after the Login Start sniff persisted nothing, while the
  // same command 3s after spawn stored players/<uuid>.player + skins/*.playerskin).
  // 6s is comfortably after the proven-reliable 4s welcome tellraw.
  skinDelayMs = 6_000,
  rcon = createRcon({ host: '127.0.0.1', port: env.rconPort, password: env.rconPassword }),
}) {
  /** single-use connection tokens: token -> {session, socket, timer} */
  const pending = new Map();

  // ---------------------------------------------------------------- router
  const router = express.Router();

  // CORS (NOTES.md 3.5): reply to preflights allowing Authorization +
  // Content-Type (do NOT copy the reference netApi list, which omits Authorization).
  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.header('Access-Control-Max-Age', '1728000');
      return res.status(204).end();
    }
    next();
  });
  router.use(express.json());

  // Health/info probe — the client fetches this WITHOUT Authorization (NOTES.md 3.2).
  router.get('/connect', (req, res) => {
    const started = Date.now();
    res.json({
      code: 200,
      description: 'MuchuCraft proxy for Minecraft web clients',
      time: Date.now(),
      processingTime: Date.now() - started,
    });
  });

  router.post('/connect', (req, res) => {
    // SPEC: token must be an unexpired session, otherwise 403 (missing header
    // included — SPEC E2E case 3 expects 403 for "no/garbage Bearer").
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    const session = match ? sessionLookup(match[1]) : null;
    if (!session) {
      // exact reference wording (NOTES.md 3.1 validate-reject)
      return res
        .status(403)
        .json({ code: 403, error: 'You are not allowed to connect to this server' });
    }
    const { host, port } = req.body ?? {};
    if (!host || !port) {
      return res.status(400).json({ code: 400, error: 'No host and port specified' });
    }

    // Requested destination is logged then IGNORED: we always dial our own
    // Paper server (allowlist enforcement by construction).
    console.log(
      `[proxy] ${session.username} requested ${host}:${port} -> dialing ${env.mcHost}:${env.mcPort}`,
    );

    const socket = net.connect({ host: env.mcHost, port: env.mcPort });
    socket.setNoDelay(true);
    socket.setTimeout(dialTimeoutMs);
    let settled = false;

    socket.on('error', (err) => {
      if (settled) return; // post-dial errors are handled by the WS side / cleanup
      settled = true;
      socket.destroy();
      res
        .status(502)
        .json({ code: 502, error: `Socket error: ${err.code ?? err.message}`, details: String(err) });
    });
    socket.once('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      res.status(504).json({ code: 504, error: 'Socket timed out. Minecraft server is not reachable.' });
    });
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0); // sniff/pipe phases manage their own timers

      const token = randomBytes(32).toString('hex');
      const entry = { session, socket, timer: null };
      entry.timer = setTimeout(() => {
        // never claimed within claimTtlMs -> burn it
        if (pending.delete(token)) {
          console.log(`[proxy] connection token expired unclaimed for ${session.username}`);
          socket.destroy();
        }
      }, claimTtlMs);
      entry.timer.unref?.();
      socket.once('close', () => {
        // TCP died while unclaimed -> token is useless
        if (pending.get(token)?.socket === socket) {
          clearTimeout(entry.timer);
          pending.delete(token);
        }
      });
      pending.set(token, entry);

      // NOTES.md 3.1: `remote` MUST be the net.Socket#address() OBJECT
      // {address, family, port} — the shipped client dereferences its fields.
      res.json({ token, remote: socket.address() });
    });
  });

  // JSON errors for body-parse failures etc. (client only needs an `error` key).
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const code = err.status ?? err.statusCode ?? 400;
    res.status(code).json({ code, error: `Bad request: ${err.type ?? err.message}` });
  });

  // ------------------------------------------------------------ data socket

  function attachDataSocket(ws, req) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    const entry = token ? pending.get(token) : undefined;
    if (!entry) {
      // unknown / expired / already-used token: close immediately, no frame
      ws.close();
      return;
    }
    pending.delete(token); // single use
    clearTimeout(entry.timer);
    const { socket, session } = entry;
    if (socket.destroyed) {
      ws.close();
      return;
    }

    let shutdownSent = false;
    const sendShutdown = (reason) => {
      if (shutdownSent) return;
      shutdownSent = true;
      if (ws.readyState === ws.OPEN) {
        try { ws.send(`proxy-shutdown:${reason}`); } catch { /* socket already gone */ }
      }
    };
    const kill = (reason) => {
      sendShutdown(reason);
      try { ws.close(); } catch { /* ignore */ }
      socket.destroy();
    };

    // Sniff phase: hold browser->server bytes until the username verdict.
    const sniffer = createLoginSniffer();
    const held = [];
    let piping = false;
    const sniffTimer = setTimeout(
      () => kill(`Connection timed out. No login within ${sniffTimeoutMs}ms.`),
      sniffTimeoutMs,
    );
    sniffTimer.unref?.();

    const startPiping = () => {
      clearTimeout(sniffTimer);
      piping = true;
      for (const chunk of held) socket.write(chunk);
      held.length = 0;
    };

    // server -> browser: byte-for-byte binary frames (Paper stays silent
    // until it receives the handshake we are still holding, so attaching now
    // is safe and loses nothing).
    socket.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    });
    socket.on('error', (err) => {
      console.warn(`[proxy] mc socket error (${session.username}): ${err.message}`);
      sendShutdown(`Issue with the connection to the Minecraft server: ${err.message}`);
      try { ws.close(); } catch { /* ignore */ }
    });
    socket.on('close', () => {
      sendShutdown('Minecraft server closed the connection.');
      try { ws.close(); } catch { /* ignore */ }
    });
    ws.on('close', () => {
      clearTimeout(sniffTimer);
      socket.destroy();
    });
    ws.on('error', () => {
      clearTimeout(sniffTimer);
      socket.destroy();
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Latency UI pings arrive on the DATA socket (NOTES.md 3.3) and the
        // reply must be exactly `pong:<id>` — no extra fields.
        const text = data.toString();
        if (text.startsWith('ping:')) {
          try { ws.send(`pong:${text.slice('ping:'.length)}`); } catch { /* ignore */ }
        }
        return; // other text frames are reserved; never forwarded as bytes
      }

      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (piping) {
        if (!socket.destroyed) socket.write(buf);
        return;
      }

      held.push(buf);
      const { verdict, username } = sniffer.push(buf);
      switch (verdict) {
        case 'pending':
          return;
        case 'status': // server list ping: no username involved, pipe freely
          startPiping();
          return;
        case 'login':
          if (username === session.username) {
            console.log(`[proxy] login accepted: ${username} (wallet ${session.address})`);
            startPiping();
            const { firstLogin } = markLogin(session.userId);
            const shortAddr = `${session.address.slice(0, 4)}…${session.address.slice(-4)}`;
            const welcomeTimer = setTimeout(
              () => rcon.sendWelcome(session.username, shortAddr, firstLogin),
              rconDelayMs,
            );
            welcomeTimer.unref?.();
            if (session.skin) {
              // SPEC-PHASE3 §4: apply the stored skin shortly after join via
              // the SkinsRestorer console command (rcon.applySkin, never
              // throws) — see skinDelayMs above for the 6s timing rationale.
              const skinTimer = setTimeout(
                () => rcon.applySkin?.(session.username, session.skin),
                skinDelayMs,
              );
              skinTimer.unref?.();
            }
          } else {
            console.warn(
              `[proxy] username mismatch: logged in as "${username}" but session owns "${session.username}"`,
            );
            kill('username does not match your wallet session');
          }
          return;
        case 'overflow':
          kill('Login handshake too large.');
          return;
        default: // 'invalid'
          kill('Malformed Minecraft handshake.');
      }
    });
  }

  // --------------------------------------------------------------- upgrades

  function handleUpgrade(server) {
    const wssData = new WebSocketServer({ noServer: true });
    const wssPing = new WebSocketServer({ noServer: true });

    wssData.on('connection', attachDataSocket);
    wssPing.on('connection', (ws) => {
      // Optional endpoint (unused by the shipped client, NOTES.md 3.4).
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString();
        if (text.startsWith('ping:')) {
          try { ws.send(`pong:${text.slice('ping:'.length)}`); } catch { /* ignore */ }
        }
      });
      ws.on('error', () => {});
    });

    server.on('upgrade', (req, sock, head) => {
      let pathname;
      try {
        ({ pathname } = new URL(req.url, 'http://localhost'));
      } catch {
        sock.destroy();
        return;
      }
      if (pathname === SOCKET_PATH) {
        wssData.handleUpgrade(req, sock, head, (ws) => wssData.emit('connection', ws, req));
      } else if (pathname === PING_PATH) {
        wssPing.handleUpgrade(req, sock, head, (ws) => wssPing.emit('connection', ws, req));
      } else {
        sock.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        sock.destroy();
      }
    });
  }

  return { router, handleUpgrade };
}
