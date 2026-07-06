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

const CLIENT_CONFIG_OVERRIDES = {
  defaultProxy: '',
  allowAutoConnect: true,
};

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
 * @param {{config: object, db: object, netProxy?: {router: import('express').Router, handleUpgrade: (server: import('http').Server) => void}, limits?: object}} deps
 */
export function createApp({ config, db, netProxy = null, limits }) {
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

  // --- static -------------------------------------------------------------
  const loginDir = path.join(config.root, 'gateway', 'public', 'login');
  const clientDist = path.join(config.root, 'client', 'dist');
  if (!fs.existsSync(clientDist)) {
    console.warn(`[gateway] client dist missing at ${clientDist} — build the client bundle; serving login page only`);
  }

  // Merged client config (must win over the static dist/config.json).
  app.get('/config.json', (req, res) => {
    let base = {};
    try {
      base = JSON.parse(fs.readFileSync(path.join(clientDist, 'config.json'), 'utf8'));
    } catch {
      // dist or config.json missing — serve overrides only
    }
    res.json(deepMerge(base, CLIENT_CONFIG_OVERRIDES));
  });

  // Bare visits (no ip/token params) go to the wallet launcher.
  app.get(['/', '/index.html'], (req, res, next) => {
    if (!req.query.ip && !req.query.token) return res.redirect(302, '/login/');
    next();
  });

  app.use('/login', express.static(loginDir));
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

  const { app } = createApp({ config, db, netProxy });
  const server = http.createServer(app);
  if (netProxy?.handleUpgrade) {
    netProxy.handleUpgrade(server); // WS: /api/vm/net/socket + /api/vm/net/ping
  }

  server.listen(config.port, () => {
    console.log(`[gateway] listening on http://localhost:${config.port} (mc ${config.mcHost}:${config.mcPort}, version ${config.mcVersion})`);
  });

  const shutdown = () => {
    console.log('[gateway] shutting down');
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
