#!/usr/bin/env node
// scripts/rcon-cmd.mjs — one-shot RCON command runner for integration checks.
// Usage: node scripts/rcon-cmd.mjs '<command>' [...more commands]
// Loads root .env (never printed); prints each command's reply to stdout.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // .env optional — env may already be set
}
const require = createRequire(path.join(root, 'gateway', 'package.json'));
const { Rcon } = require('rcon-client');

const commands = process.argv.slice(2);
if (commands.length === 0) {
  console.error('usage: node scripts/rcon-cmd.mjs "<command>" [...]');
  process.exit(2);
}
const rcon = await Rcon.connect({
  host: '127.0.0.1',
  port: Number(process.env.RCON_PORT ?? 25575),
  password: process.env.RCON_PASSWORD,
});
for (const cmd of commands) {
  const reply = await rcon.send(cmd);
  // strip § color codes for terminal readability
  console.log(`> ${cmd}\n${reply.replace(/§./g, '')}`);
}
await rcon.end();
