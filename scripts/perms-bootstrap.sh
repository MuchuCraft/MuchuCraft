#!/usr/bin/env bash
# scripts/perms-bootstrap.sh — idempotent LuckPerms bootstrap for the Essentials
# quality-of-life permissions (SPEC-PHASE4.md §3). Safe to re-run at any time;
# every command overwrites rather than appends state. Companion of
# scripts/lp-bootstrap.sh (Phase 3 jobs gate) — this script does NOT touch any
# jobs.* node.
#
#   default group   → Essentials QoL commands + 2 homes + starter kit
#   depositor group → additionally 5 homes (essentials.sethome.multiple.depositor)
#
# VERIFIED against the shipped EssentialsX-2.22.0.jar (decompiled
# com.earth2me.essentials.Settings#getHomeLimit / #getMultipleHomes):
#   - the home limit starts at 1;
#   - `essentials.sethome.multiple` bumps it to config `sethome-multiple.default`;
#   - every KEY of the config `sethome-multiple:` section is then checked as
#     `essentials.sethome.multiple.<KEY>` and the highest matching value wins
#     (`essentials.sethome.multiple.unlimited` bypasses the limit entirely).
#   So with config {default: 2, depositor: 5} (set in Essentials/config.yml by
#   server/setup.d/experience.sh): default group gets `essentials.sethome.multiple`
#   + `.multiple.default` → 2 homes; depositor gets `.multiple.depositor` → 5.
#   Config comment ("must have BOTH permission nodes") matches: the bare
#   `.multiple` node comes from the default group, which depositors inherit.
#
# Other nodes verified against the same jar's bytecode:
#   - the Essentials dispatcher gates every command on `essentials.<commandname>`
#     (Essentials#onCommandEssentials, prefix "essentials."), so /r needs
#     `essentials.r` (its send path additionally checks `essentials.msg`);
#   - per-kit node is `essentials.kits.<kitname>` (Kits.class), base /kit is
#     `essentials.kit`; warp listing is `essentials.warp.list` (Commandwarp);
#     mail sending is `essentials.mail.send` (Commandmail).
#
# GriefPrevention claim basics need NO grants: GriefPrevention-16.18.7.jar
# plugin.yml declares `griefprevention.createclaims: default: true` and
# `griefprevention.claims: default: true` (Bukkit defaults apply to everyone);
# this script only ASSERTS that neither group negates a griefprevention.* node.
#
# NOTE: /spawn is provided by the separate EssentialsXSpawn module, which is not
# yet installed (13 plugins, no EssentialsX-Spawn jar). `essentials.spawn` is
# granted anyway so /spawn works the moment the module lands (SPEC-PHASE4 §1).
#
# Requires: the Paper server RUNNING with RCON enabled (creds in root .env),
# and gateway/node_modules present (rcon-client). LuckPerms replies to RCON
# asynchronously (no output comes back), so this script verifies its work by
# running `lp export` and asserting on the exported JSON.
#
# Usage: scripts/perms-bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --input-type=module - "$ROOT" <<'NODE'
import { createRequire } from 'node:module';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = process.argv[2];
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may be pre-populated */ }

const { Rcon } = createRequire(path.join(ROOT, 'gateway', 'package.json'))('rcon-client');

const log = (msg) => console.log(`[perms-bootstrap] ${msg}`);
const fail = (msg) => { console.error(`[perms-bootstrap] FAIL: ${msg}`); process.exit(1); };

// --------------------------------------------------------------- node lists
// Every node the `default` group gets (true). SPEC-PHASE4 §3.
const DEFAULT_NODES = [
  'essentials.spawn',                     // /spawn (EssentialsXSpawn module)
  'essentials.sethome',                   // /sethome
  'essentials.sethome.multiple',          // unlock sethome-multiple.default …
  'essentials.sethome.multiple.default',  // … = 2 homes (config map key)
  'essentials.home',                      // /home
  'essentials.delhome',                   // /delhome
  'essentials.tpa',                       // /tpa — teleport-request family
  'essentials.tpaccept',                  // /tpaccept
  'essentials.tpdeny',                    // /tpdeny
  'essentials.tpacancel',                 // /tpacancel
  'essentials.balance',                   // /balance
  'essentials.balancetop',                // /balancetop
  'essentials.pay',                       // /pay
  'essentials.msg',                       // /msg (also checked by /r's send path)
  'essentials.r',                         // /r (dispatcher node)
  'essentials.mail',                      // /mail read
  'essentials.mail.send',                 // /mail send
  'essentials.afk',                       // /afk
  'essentials.help',                      // /help
  'essentials.motd',                      // /motd
  'essentials.rules',                     // /rules
  'essentials.kit',                       // /kit (base command)
  'essentials.kits.starter',              // the one-time starter kit
  'essentials.warp',                      // /warp
  'essentials.warp.list',                 // /warp with no args lists warps
  'essentials.ignore',                    // /ignore
  // --- survival QoL batch (adventure pad / tpr / daily kit / shop) -------
  'essentials.tpr',                       // /tpr — random teleport (core in 2.22.0:
                                          // plugin.yml declares tpr/settpr; no addon)
  'essentials.back',                      // /back — return to previous location
  'essentials.back.ondeath',              // /back also works to your death point
  'essentials.compass',                   // /compass — bearing readout
  'essentials.getpos',                    // /getpos — coordinates readout
  'essentials.kits.daily',                // the repeatable daily kit (kits.yml)
  // EconomyShopGUI /shop — node from EconomyShopGUI-7.1.1.jar plugin.yml
  // ("EconomyShopGUI.shop", default: true). Granted explicitly so the shop
  // survives any future default-permission tightening; LuckPerms lowercases.
  'economyshopgui.shop',
];
// Extra nodes for the `depositor` group (inherits default; weight handled by
// scripts/lp-bootstrap.sh). 5 homes per config sethome-multiple.depositor.
const DEPOSITOR_NODES = [
  'essentials.sethome.multiple.depositor',
];

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
// `permission set` overwrites, so re-runs converge. depositor is normally
// created by scripts/lp-bootstrap.sh but this script must not depend on order.
await lp('lp creategroup depositor');
for (const node of DEFAULT_NODES) {
  await lp(`lp group default permission set ${node} true`);
}
for (const node of DEPOSITOR_NODES) {
  await lp(`lp group depositor permission set ${node} true`);
}
log(`applied ${DEFAULT_NODES.length} default + ${DEPOSITOR_NODES.length} depositor nodes — verifying via lp export`);

// ------------------------------------------------------------------ verify
// LuckPerms sends command output to RCON senders asynchronously (it never
// reaches the RCON response packet), so assert on an export file instead.
const exportName = 'perms-bootstrap-verify';
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
const defaultNodes = nodesOf('default');
const depositorNodes = nodesOf('depositor');
if (!dump.groups?.depositor) problems.push('group depositor missing');
for (const node of DEFAULT_NODES) {
  if (defaultNodes.get(node) !== true) problems.push(`default: ${node} != true`);
}
for (const node of DEPOSITOR_NODES) {
  if (depositorNodes.get(node) !== true) problems.push(`depositor: ${node} != true`);
}
// GriefPrevention claim basics come from Bukkit defaults (plugin.yml
// `default: true`); make sure no group negates them.
for (const [group, nodes] of [['default', defaultNodes], ['depositor', depositorNodes]]) {
  for (const [key, value] of nodes) {
    if (key.startsWith('griefprevention.') && value === false) {
      problems.push(`${group}: ${key} is negated (would break claim basics)`);
    }
  }
}
rmSync(exportFile, { force: true });

if (problems.length > 0) fail(`verification mismatches:\n  - ${problems.join('\n  - ')}`);
log(`OK: default has all ${DEFAULT_NODES.length} QoL nodes (2 homes); depositor adds ${DEPOSITOR_NODES.join(', ')} (5 homes); no griefprevention.* negations.`);
NODE
