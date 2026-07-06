// index.js — gateway entrypoint: auth API + net proxy + static hosting.
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createAuthRoutes } from './auth-routes.js';

/**
 * Query params that mean "open the game client" on a bare-/ visit. Everything
 * the shipped client reads from location.search (client/NOTES.md §5) plus our
 * own `?play=1` marker used by the site's "Open game client" button.
 */
const CLIENT_QUERY_PARAMS = ['ip', 'token', 'username', 'version', 'autoConnect', 'play', 'singleplayer'];

/**
 * Overrides layered on top of the client's dist/config.json (client/NOTES.md
 * §4.2). promoteServers entries are `{ip, name, description, version}` — the
 * shipped client maps `version` → versionOverride (verified in dist
 * index.e3d79375.js); deepMerge replaces arrays wholesale, so this drops the
 * upstream mcraft.fun promos. `defaultHost` mirrors the key already present in
 * dist/config.json (unused by this client build, but SPEC-PHASE3 §3 serves it).
 */
function clientConfigOverrides(config) {
  const hostPort = `${config.mcHost}:${config.mcPort}`;
  return {
    defaultProxy: '',
    allowAutoConnect: true,
    defaultHost: hostPort,
    promoteServers: [
      {
        ip: hostPort,
        name: 'MuchuCraft',
        description: 'Wallet-verified survival — muchucraft',
        version: config.mcVersion,
      },
    ],
  };
}

/** Deep-merge `extra` on top of `base` (plain objects only; arrays replaced). */
function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Best-effort TCP dial: resolves true iff host:port accepts within timeoutMs. */
export function tcpCheck(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * Build the express app. `netProxy` ({router, handleUpgrade}) is optional so
 * the app can boot (and be tested) before/without the proxy module.
 * `tokenRoutes` (express Router) is optional: mounted at /api/token only when
 * the MUCHU token economy is configured (MUCHU_MINT set).
 * @param {{config: object, db: object, netProxy?: {router: import('express').Router, handleUpgrade: (server: import('http').Server) => void}, tokenRoutes?: import('express').Router|null, limits?: object}} deps
 */
export function createApp({ config, db, netProxy = null, tokenRoutes = null, limits }) {
  const app = express();
  app.disable('x-powered-by');

  // The web client needs SharedArrayBuffer => cross-origin isolation headers
  // on every response (see client/NOTES.md).
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });
  app.use(compression()); // HTTP only; WS upgrades bypass express entirely

  // --- health -------------------------------------------------------------
  app.get('/healthz', async (req, res) => {
    const mc = await tcpCheck(config.mcHost, config.mcPort);
    res.json({ ok: true, mc });
  });

  // --- API ----------------------------------------------------------------
  app.use('/api/auth', cors({ allowedHeaders: ['Authorization', 'Content-Type'] }));
  app.use('/api/auth', createAuthRoutes({ config, db, limits }));
  if (netProxy?.router) {
    app.use('/api/vm/net', netProxy.router);
  }
  if (tokenRoutes) {
    app.use('/api/token', cors({ allowedHeaders: ['Authorization', 'Content-Type'] }));
    app.use('/api/token', tokenRoutes);
  }

  // --- static -------------------------------------------------------------
  const loginDir = path.join(config.root, 'gateway', 'public', 'login');
  const siteDir = path.join(config.root, 'gateway', 'public', 'site');
  const clientDist = path.join(config.root, 'client', 'dist');
  if (!fs.existsSync(clientDist)) {
    console.warn(`[gateway] client dist missing at ${clientDist} — build the client bundle; serving login page only`);
  }

  // Merged client config (must win over the static dist/config.json).
  const configOverrides = clientConfigOverrides(config);
  app.get('/config.json', (req, res) => {
    let base = {};
    try {
      base = JSON.parse(fs.readFileSync(path.join(clientDist, 'config.json'), 'utf8'));
    } catch {
      // dist or config.json missing — serve overrides only
    }
    res.json(deepMerge(base, configOverrides));
  });

  // Bare visits serve the marketing site; any client query param (ip/token/…
  // or the site's ?play=1) falls through to the game client dist (SPEC-PHASE3 §3).
  app.get(['/', '/index.html'], (req, res, next) => {
    if (CLIENT_QUERY_PARAMS.some((p) => req.query[p] !== undefined)) return next();
    res.sendFile(path.join(siteDir, 'index.html'), (err) => {
      if (!err) return;
      if (!res.headersSent) return res.redirect(302, '/login/'); // site missing — degrade to launcher
      res.end(); // stream failed mid-flight; nothing sane left to send
    });
  });

  app.use('/login', express.static(loginDir));
  app.use('/site', express.static(siteDir));
  app.use(express.static(clientDist));

  return { app };
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.dbPath);

  let netProxy = null;
  try {
    const { createNetProxy } = await import('./netproxy.js');
    netProxy = createNetProxy({
      env: {
        mcHost: config.mcHost,
        mcPort: config.mcPort,
        mcVersion: config.mcVersion,
        rconPort: config.rconPort,
        rconPassword: config.rconPassword,
      },
      sessionLookup: db.getSessionInfo,
      markLogin: db.markLogin,
    });
  } catch (err) {
    console.warn('[gateway] net proxy unavailable (auth API still up):', err.message);
  }

  // MUCHU token economy: mounted only when MUCHU_MINT is configured;
  // warn-not-crash otherwise (mirrors the net proxy pattern above).
  let tokenModule = null;
  try {
    const { loadTokenConfig, createTokenModule } = await import('./token/routes.js');
    const tokenConfig = loadTokenConfig(config.root);
    if (!tokenConfig.mint) {
      console.warn('[token] MUCHU_MINT not set — /api/token disabled (run devnet setup, then restart)');
    } else {
      tokenModule = createTokenModule({ config, tokenConfig, db });
      // Deposits (SPEC-PHASE3 §1): watcher + routes + bridge push, wired in place.
      (await import('./token/deposits.js')).attachDeposits({ tokenModule, config, tokenConfig, db, promoteToDepositor: (await import('./token/rcon-gate.js')).promoteToDepositor });
      console.log(`[token] /api/token enabled (cluster ${tokenConfig.cluster}, mint ${tokenConfig.mint})`);
    }
  } catch (err) {
    console.warn('[token] token module unavailable (rest of gateway still up):', err.message);
  }

  const { app } = createApp({ config, db, netProxy, tokenRoutes: tokenModule?.router ?? null });
  const server = http.createServer(app);
  if (netProxy?.handleUpgrade) {
    netProxy.handleUpgrade(server); // WS: /api/vm/net/socket + /api/vm/net/ping
  }

  server.listen(config.port, () => {
    console.log(`[gateway] listening on http://localhost:${config.port} (mc ${config.mcHost}:${config.mcPort}, version ${config.mcVersion})`);
    tokenModule?.worker.start(); // withdrawal queue + crash recovery + solvency monitor
  });

  const shutdown = () => {
    console.log('[gateway] shutting down');
    tokenModule?.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error('[gateway] fatal:', err);
    process.exit(1);
  });
}
