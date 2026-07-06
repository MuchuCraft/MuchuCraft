// config.js — loads root .env (via process.loadEnvFile) and exposes typed config.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');

/**
 * Load configuration from `${rootDir}/.env` (best effort) + process.env,
 * with sane defaults for everything.
 * @param {string} [rootDir] repo root (defaults to two levels above gateway/src)
 */
export function loadConfig(rootDir = DEFAULT_ROOT) {
  try {
    process.loadEnvFile(path.join(rootDir, '.env'));
  } catch {
    // no .env — rely on process.env / defaults
  }
  const env = process.env;
  const dbPathRaw = env.DB_PATH || 'gateway/data/muchucraft.db';
  return {
    port: toInt(env.PORT, 8080),
    mcHost: env.MC_HOST || '127.0.0.1',
    mcPort: toInt(env.MC_PORT, 25565),
    mcVersion: env.MC_VERSION || '1.21.1',
    // Version the BROWSER client speaks/renders; ViaBackwards on the server
    // translates it to mcVersion. The bundled client's mesher lacks data for
    // the newest server versions, so these can legitimately differ.
    clientMcVersion: env.CLIENT_MC_VERSION || env.MC_VERSION || '1.21.1',
    rconPort: toInt(env.RCON_PORT, 25575),
    rconPassword: env.RCON_PASSWORD || '',
    sessionTtlHours: toInt(env.SESSION_TTL_HOURS, 24),
    siwsDomain: env.SIWS_DOMAIN || 'localhost:8080',
    siwsUri: env.SIWS_URI || 'http://localhost:8080/login/',
    dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(rootDir, dbPathRaw),
    root: rootDir,
  };
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
