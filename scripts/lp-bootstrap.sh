#!/usr/bin/env bash
# scripts/lp-bootstrap.sh — idempotent LuckPerms bootstrap for the earn gate
# (SPEC-PHASE3.md §2). Safe to re-run at any time; every command overwrites
# rather than appends state.
#
#   default group   → may join ONLY the starter job (lowest-paying: Builder)
#   depositor group → may join ALL jobs (granted when cumulative deposits
#                     reach DEPOSIT_GATE_MIN; see docs/EARN-GATE.md)
#
# VERIFIED on the live Paper 1.21.11 + Jobs 5.2.6.3 + LuckPerms 5.5.53 stack:
# the per-job join gate is `jobs.join.<jobname lowercase>` (checked together
# with `jobs.use` by JobsCommands.hasJobPermission at /jobs join, /jobs browse,
# /jobs info and the Jobs GUI). Jobs registers jobs.join.<job> with Bukkit
# PermissionDefault.TRUE, so the default group must NEGATE the non-starter
# jobs; `jobs.use.<job>` is NOT a real node (negating it changes nothing).
#
# Requires: the Paper server RUNNING with RCON enabled (creds in root .env),
# and gateway/node_modules present (rcon-client). LuckPerms replies to RCON
# asynchronously (no output comes back), so this script verifies its work by
# running `lp export` and asserting on the exported JSON.
#
# Usage: scripts/lp-bootstrap.sh            (STARTER_JOB=builder by default)
#        STARTER_JOB=fisherman scripts/lp-bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --input-type=module - "$ROOT" <<'NODE'
import { createRequire } from 'node:module';
import { readdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = process.argv[2];
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may be pre-populated */ }

const { Rcon } = createRequire(path.join(ROOT, 'gateway', 'package.json'))('rcon-client');

const log = (msg) => console.log(`[lp-bootstrap] ${msg}`);
const fail = (msg) => { console.error(`[lp-bootstrap] FAIL: ${msg}`); process.exit(1); };

// ---------------------------------------------------------------- job list
// Enumerate the loaded jobs from the Jobs plugin config dir so the script
// stays correct if jobs are added/removed. File name == job name lowercased
// (builder.yml → jobs.join.builder). `none.yml` and `_EXAMPLE.yml` are not jobs.
const jobsDir = path.join(ROOT, 'server', 'plugins', 'Jobs', 'jobs');
const jobs = readdirSync(jobsDir)
  .filter((f) => f.endsWith('.yml') && f !== '_EXAMPLE.yml' && f !== 'none.yml')
  .map((f) => f.replace(/\.yml$/, '').toLowerCase())
  .sort();
if (jobs.length === 0) fail(`no job configs found in ${jobsDir}`);

const starter = (process.env.STARTER_JOB || 'builder').toLowerCase();
if (!jobs.includes(starter)) fail(`starter job '${starter}' not in loaded jobs: ${jobs.join(', ')}`);
log(`jobs (${jobs.length}): ${jobs.join(', ')}`);
log(`starter job for non-depositors: ${starter}`);

// -------------------------------------------------------------------- rcon
const rcon = await Rcon.connect({
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.RCON_PORT || 25575),
  password: process.env.RCON_PASSWORD,
});
async function lp(cmd) {
  await rcon.send(cmd);
  await delay(250); // LuckPerms executes async; pace the writes
}

// ---------------------------------------------------------- apply (idempotent)
// creategroup on an existing group is a no-op error (ignored); every
// `permission set` and `setweight` overwrites, so re-runs converge.
await lp('lp creategroup depositor');
// depositor must OUT-WEIGH default so its `true` nodes beat default's `false`
// negations when a player inherits both groups.
await lp('lp group depositor setweight 10');
for (const job of jobs) {
  await lp(`lp group depositor permission set jobs.join.${job} true`);
}
for (const job of jobs) {
  const value = job === starter ? 'true' : 'false';
  await lp(`lp group default permission set jobs.join.${job} ${value}`);
}
log('applied group nodes — verifying via lp export');

// ------------------------------------------------------------------ verify
// LuckPerms sends command output to RCON senders asynchronously (it never
// reaches the RCON response packet), so assert on an export file instead.
const exportName = 'lp-bootstrap-verify';
const exportFile = path.join(ROOT, 'server', 'plugins', 'LuckPerms', `${exportName}.json.gz`);
rmSync(exportFile, { force: true });
await rcon.send(`lp export ${exportName}`);
let dump = null;
for (let i = 0; i < 40; i++) {
  await delay(500);
  if (existsSync(exportFile)) {
    try {
      dump = JSON.parse(gunzipSync(readFileSync(exportFile)).toString('utf8'));
      break;
    } catch { /* still being written */ }
  }
}
await rcon.end();
if (!dump) fail(`lp export never produced ${exportFile}`);

const nodesOf = (group) =>
  new Map((dump.groups?.[group]?.nodes ?? []).map((n) => [n.key, n.value]));
const problems = [];
const depositorNodes = nodesOf('depositor');
const defaultNodes = nodesOf('default');
if (!dump.groups?.depositor) problems.push('group depositor missing');
if (depositorNodes.get('weight.10') !== true && dump.groups?.depositor) {
  // LuckPerms represents setweight as a `weight.<n>` node in exports
  problems.push('depositor weight.10 missing');
}
for (const job of jobs) {
  if (depositorNodes.get(`jobs.join.${job}`) !== true) {
    problems.push(`depositor: jobs.join.${job} != true`);
  }
  const want = job === starter;
  if (defaultNodes.get(`jobs.join.${job}`) !== want) {
    problems.push(`default: jobs.join.${job} != ${want}`);
  }
}
rmSync(exportFile, { force: true });

if (problems.length > 0) fail(`verification mismatches:\n  - ${problems.join('\n  - ')}`);
log(`OK: depositor grants all ${jobs.length} jobs; default grants only '${starter}'.`);
NODE
