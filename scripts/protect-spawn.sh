#!/usr/bin/env bash
# scripts/protect-spawn.sh — MuchuCraft spawn protection (SPEC-PHASE4.md §2).
#
# Runs ALL live protection steps against the RUNNING server. WorldGuard only
# loads after a restart, so the intended order is:
#
#   1. server/setup.d/worldguard.sh   (installs the jar — already done once)
#   2. ./stop-all.sh && ./start-all.sh   (integrator: loads WorldGuard)
#   3. scripts/protect-spawn.sh          (this script)
#
# What it does (idempotent, safe to re-run):
#   a. asserts server.properties spawn-protection=0 (WorldGuard is the spawn
#      protection mechanism; vanilla spawn-protection would silently block
#      depositor builds near spawn edges)
#   b. GriefPrevention wilderness config: InitialBlocks >= 200 and
#      Claim Blocks Accrued Per Hour Default >= 120 (GP 16.18.7 key names,
#      config at server/plugins/GriefPreventionData/config.yml), then
#      `gpreload` (the real command name — verified from GP's plugin.yml;
#      there is NO `griefprevention reload`)
#   c. vanilla worldborder center 0 0 + set 6000 (3000 block radius, matches
#      Chunky pregen), verified via `worldborder get`
#   d. writes the `spawn` WorldGuard region into
#      plugins/WorldGuard/worlds/<world>/regions.yml (schema + flag names
#      verified against the shipped worldguard-bukkit-7.0.16.jar), then
#      `rg reload -w <world>` + a deterministic round-trip proof: `rg save`
#      makes WorldGuard rewrite regions.yml from memory, and we assert the
#      rewritten file still contains the region and every flag.
#
# SAFETY: regions.yml is only (over)written when it is missing, empty, or
# contains no region other than `spawn` (+ `__global__`). Anything else makes
# the script FAIL LOUDLY instead of risking corruption of foreign regions.
#
# RCON quirk: WorldGuard commands reply asynchronously (AsyncCommandBuilder),
# so RCON replies for rg commands are often empty — that is why verification
# is file-based. `rg info` output is printed best-effort only.
#
# Requires: server RUNNING with RCON (creds in root .env, never printed),
# gateway/node_modules (rcon-client). Uses scripts/rcon-cmd.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
GP_CONFIG="$SERVER_DIR/plugins/GriefPreventionData/config.yml"
LATEST_LOG="$SERVER_DIR/logs/latest.log"

log()  { echo "[protect-spawn] $*"; }
pass() { echo "[protect-spawn] PASS: $*"; }
fail() { echo "[protect-spawn] FAIL: $*" >&2; exit 1; }

# rcon <command> — one command, echo line ("> cmd") stripped so grep on the
# result only sees the server's reply. Hard-fails if RCON itself is down.
rcon() {
  local out
  out="$(node "$ROOT/scripts/rcon-cmd.mjs" "$1" 2>/dev/null)" \
    || fail "RCON command failed (server/RCON down?): $1"
  printf '%s\n' "$out" | grep -v '^> ' || true
}

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
[ -f "$SERVER_DIR/server.properties" ] || fail "no $SERVER_DIR/server.properties"
LEVEL_NAME="$(sed -nE 's/^level-name=(.*)$/\1/p' "$SERVER_DIR/server.properties" | head -1)"
LEVEL_NAME="${LEVEL_NAME:-world}"
REGIONS_DIR="$SERVER_DIR/plugins/WorldGuard/worlds/$LEVEL_NAME"
REGIONS_FILE="$REGIONS_DIR/regions.yml"
log "world: $LEVEL_NAME"

PLUGINS_OUT="$(rcon 'plugins')" || true
[ -n "$PLUGINS_OUT" ] || fail "RCON unreachable — is the stack running? (start-all.sh)"

# ---------------------------------------------------------------------------
# a. vanilla spawn-protection must stay 0
# ---------------------------------------------------------------------------
if grep -qE '^spawn-protection=0$' "$SERVER_DIR/server.properties"; then
  pass "server.properties spawn-protection=0"
else
  fail "server.properties spawn-protection is NOT 0 — fix it (WorldGuard is the spawn protection mechanism; vanilla spawn-protection blocks depositor builds near spawn)"
fi

# ---------------------------------------------------------------------------
# b. GriefPrevention wilderness claims: InitialBlocks >= 200,
#    Claim Blocks Accrued Per Hour Default >= 120  (GP 16.18.7 config keys)
# ---------------------------------------------------------------------------
[ -f "$GP_CONFIG" ] || fail "GriefPrevention config not found at $GP_CONFIG (GP creates it on first boot)"

gp_initial() { sed -nE 's/^[[:space:]]*InitialBlocks:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' "$GP_CONFIG" | head -1; }
gp_accrual() {
  awk '
    inb && /^[[:space:]]*Default:[[:space:]]*[0-9]+[[:space:]]*$/ { v=$0; sub(/.*Default:[[:space:]]*/, "", v); print v+0; exit }
    inb && $0 !~ /^[[:space:]]*(#|$)/ && $0 !~ /Default:/ { inb=0 }
    /^[[:space:]]*Claim Blocks Accrued Per Hour:[[:space:]]*$/ { inb=1 }
  ' "$GP_CONFIG"
}

CUR_INIT="$(gp_initial)"; CUR_ACCR="$(gp_accrual)"
[ -n "$CUR_INIT" ] || fail "could not find InitialBlocks in $GP_CONFIG (GP config format changed?)"
[ -n "$CUR_ACCR" ] || fail "could not find 'Claim Blocks Accrued Per Hour: Default:' in $GP_CONFIG (GP config format changed?)"
log "GriefPrevention current: InitialBlocks=$CUR_INIT BlocksAccruedPerHour(Default)=$CUR_ACCR"

GP_CHANGED=0
if [ "$CUR_INIT" -lt 200 ] || [ "$CUR_ACCR" -lt 120 ]; then
  TMP="$(mktemp)"
  awk '
    BEGIN { inaccr=0 }
    /^[[:space:]]*Claim Blocks Accrued Per Hour:[[:space:]]*$/ { inaccr=1; print; next }
    {
      if (inaccr && $0 ~ /^[[:space:]]*Default:[[:space:]]*[0-9]+[[:space:]]*$/) {
        indent=$0; sub(/Default:.*/, "", indent)
        val=$0; sub(/.*Default:[[:space:]]*/, "", val); val+=0
        if (val < 120) print indent "Default: 120"; else print
        inaccr=0; next
      }
      if (inaccr && $0 !~ /^[[:space:]]*(#|$)/) inaccr=0
      if ($0 ~ /^[[:space:]]*InitialBlocks:[[:space:]]*[0-9]+[[:space:]]*$/) {
        indent=$0; sub(/InitialBlocks:.*/, "", indent)
        val=$0; sub(/.*InitialBlocks:[[:space:]]*/, "", val); val+=0
        if (val < 200) print indent "InitialBlocks: 200"; else print
        next
      }
      print
    }
  ' "$GP_CONFIG" >"$TMP"
  # conservative: the edit may only change the two targeted lines
  DIFF_LINES="$(diff "$GP_CONFIG" "$TMP" | grep -cE '^<' || true)"
  [ "$DIFF_LINES" -le 2 ] || { rm -f "$TMP"; fail "GP config edit would change $DIFF_LINES lines (expected <=2) — aborting"; }
  cp "$GP_CONFIG" "$GP_CONFIG.pre-protect-spawn"
  mv "$TMP" "$GP_CONFIG"
  GP_CHANGED=1
  log "GriefPrevention config updated (backup: $GP_CONFIG.pre-protect-spawn)"
fi

NEW_INIT="$(gp_initial)"; NEW_ACCR="$(gp_accrual)"
{ [ "$NEW_INIT" -ge 200 ] && [ "$NEW_ACCR" -ge 120 ]; } \
  || fail "GP values still below spec after edit: InitialBlocks=$NEW_INIT accrual=$NEW_ACCR"
pass "GriefPrevention: InitialBlocks=$NEW_INIT (>=200) BlocksAccruedPerHour=$NEW_ACCR (>=120)"

if [ "$GP_CHANGED" -eq 1 ]; then
  # `gpreload` is GP's reload command (plugin.yml: "Reloads Grief Prevention's
  # configuration settings"). From RCON the reply is usually empty (GP logs
  # "Configuration updated." to console instead) — best-effort; a restart
  # also picks the file up.
  rcon 'gpreload' >/dev/null
  sleep 1
  if [ -f "$LATEST_LOG" ] && tail -n 40 "$LATEST_LOG" | grep -q 'Configuration updated'; then
    pass "gpreload applied (log: 'Configuration updated.')"
  else
    log "NOTE: gpreload sent; no log confirmation seen — the integrator restart also applies the config"
  fi
fi

# ---------------------------------------------------------------------------
# c. worldborder center 0 0 + set 6000 (vanilla — synchronous RCON replies)
# ---------------------------------------------------------------------------
WB_CENTER="$(rcon 'worldborder center 0 0')"
echo "$WB_CENTER" | grep -qiE 'center of the world border|nothing changed' \
  || fail "unexpected 'worldborder center' reply: $WB_CENTER"
WB_SET="$(rcon 'worldborder set 6000')"
echo "$WB_SET" | grep -qiE '6,?000|nothing changed' \
  || fail "unexpected 'worldborder set 6000' reply: $WB_SET"
WB_GET="$(rcon 'worldborder get')"
echo "$WB_GET" | grep -qE '6,?000' \
  || fail "'worldborder get' does not report 6000: $WB_GET"
pass "worldborder: center 0 0, width 6000 ($WB_GET)"

# ---------------------------------------------------------------------------
# d. WorldGuard spawn region
# ---------------------------------------------------------------------------
echo "$PLUGINS_OUT" | grep -qi 'WorldGuard' \
  || fail "WorldGuard is not loaded on the running server. Install (server/setup.d/worldguard.sh), restart the stack (integrator: ./stop-all.sh && ./start-all.sh), then re-run this script. [GP config + worldborder above are already applied]"

# regions.yml schema verified against worldguard-bukkit-7.0.16.jar
# (YamlRegionFile): regions.<id>.{type,min,max,priority,flags,owners,members}.
# min/max are x/y/z double maps; StateFlag values are 'allow'/'deny'; greeting
# strings pass through replaceColorMacros so '&' color codes work.
# Flag names below were extracted from THIS jar's Flags class — all inbuilt.
REGION_ID="spawn"
read -r -d '' REGION_CONTENT <<'EOF' || true
#
# WorldGuard regions file — MuchuCraft spawn protection (SPEC-PHASE4.md §2).
# Written by scripts/protect-spawn.sh. WorldGuard rewrites this file in its
# own canonical format on save (these comments will disappear); re-running
# the script is safe — it only overwrites when 'spawn' is the sole region.
#
regions:
    spawn:
        type: cuboid
        min: {x: -32.0, y: 80.0, z: -32.0}
        max: {x: 32.0, y: 200.0, z: 32.0}
        priority: 10
        flags:
            passthrough: deny
            pvp: deny
            mob-spawning: deny
            creeper-explosion: deny
            tnt: deny
            fire-spread: deny
            lava-fire: deny
            enderman-grief: deny
            entry: allow
            exit: allow
            greeting-title: '&5MuchuCraft Spawn'
            greeting: '&5Welcome to MuchuCraft Spawn. &7Builds here are protected - claim your own land in the wild with a golden shovel.'
        owners: {}
        members: {}
EOF

# region_ids <file> — region ids at the first indent level under `regions:`
region_ids() {
  awk '
    BEGIN { inr=0; ind=-1 }
    /^regions:[[:space:]]*(\{[[:space:]]*\})?[[:space:]]*$/ { inr=1; next }
    inr {
      if ($0 ~ /^[^ \t#]/) { inr=0; next }
      if ($0 ~ /^[[:space:]]*(#|$)/) next
      match($0, /[^ ]/); n = RSTART - 1
      if (ind < 0) ind = n
      if (n == ind) {
        line=$0; sub(/^[ ]+/, "", line)
        if (line ~ /^[^ :]+:/) { sub(/:.*/, "", line); print line }
      }
    }
  ' "$1"
}

WRITE_OK=0
if [ ! -f "$REGIONS_FILE" ]; then
  log "regions.yml missing — fresh create"
  mkdir -p "$REGIONS_DIR"
  WRITE_OK=1
else
  STRIPPED="$(grep -vE '^[[:space:]]*(#|$)' "$REGIONS_FILE" || true)"
  # whole-string match (bash ERE anchors at end of the full string, so a file
  # that merely CONTAINS a bare 'regions:' line among real regions won't match)
  if [ -z "$STRIPPED" ] || [[ "$STRIPPED" =~ ^regions:[[:space:]]*(\{[[:space:]]*\})?[[:space:]]*$ ]]; then
    log "regions.yml has only the default header / empty regions map — writing full file"
    WRITE_OK=1
  else
    IDS="$(region_ids "$REGIONS_FILE")"
    FOREIGN="$(echo "$IDS" | grep -vE "^(${REGION_ID}|__global__)$" || true)"
    if [ -z "$IDS" ]; then
      log "regions.yml has an empty regions block — writing full file"
      WRITE_OK=1
    elif [ -z "$FOREIGN" ]; then
      log "regions.yml contains only our region ($(echo "$IDS" | tr '\n' ' ')) — overwriting with canonical content"
      cp "$REGIONS_FILE" "$REGIONS_FILE.pre-protect-spawn"
      WRITE_OK=1
    else
      fail "regions.yml contains regions this script does not own: $(echo "$FOREIGN" | tr '\n' ' '). Refusing to touch it — add/adjust the spawn region manually with /rg commands, or merge by hand. File: $REGIONS_FILE"
    fi
  fi
fi

[ "$WRITE_OK" -eq 1 ] || fail "internal error: no write decision"
printf '%s\n' "$REGION_CONTENT" >"$REGIONS_FILE"
OUR_SHA="$(sha256sum "$REGIONS_FILE" | cut -d' ' -f1)"
log "wrote $REGIONS_FILE"

# Load it, then make WorldGuard rewrite the file from memory: if the rewritten
# file still contains the region + all flags, WorldGuard provably parsed and
# holds it (deterministic — does not depend on async RCON replies).
rcon "rg reload -w $LEVEL_NAME" >/dev/null
sleep 1
rcon "rg save -w $LEVEL_NAME" >/dev/null

SAVED=0
for _ in $(seq 1 15); do
  sleep 1
  NEW_SHA="$(sha256sum "$REGIONS_FILE" | cut -d' ' -f1)"
  if [ "$NEW_SHA" != "$OUR_SHA" ]; then SAVED=1; break; fi
done
if [ "$SAVED" -ne 1 ]; then
  log "regions.yml was not rewritten by 'rg save' within 15s"
  [ -f "$LATEST_LOG" ] && tail -n 30 "$LATEST_LOG" | grep -iE 'region|worldguard' >&2 || true
  fail "cannot prove WorldGuard loaded the region (rg save produced no rewrite) — check that WorldGuard enabled cleanly in $LATEST_LOG"
fi

# WorldGuard-rewritten file must still contain the region and every flag.
# (Unknown flag names would have been dropped on load with a console warning
# — so this doubles as a flag-name check against THIS WorldGuard version.)
SAVED_IDS="$(region_ids "$REGIONS_FILE")"
echo "$SAVED_IDS" | grep -qx "$REGION_ID" \
  || fail "region '$REGION_ID' missing from WorldGuard-rewritten regions.yml (ids: $(echo "$SAVED_IDS" | tr '\n' ' ')) — likely a parse failure; see $LATEST_LOG"
for FLAG in passthrough pvp mob-spawning creeper-explosion tnt fire-spread lava-fire enderman-grief entry exit greeting greeting-title; do
  grep -q "$FLAG" "$REGIONS_FILE" \
    || fail "flag '$FLAG' missing from WorldGuard-rewritten regions.yml — flag name not accepted by this WorldGuard build?"
done
pass "WorldGuard round-trip: region '$REGION_ID' + all 12 flags survived rg reload + rg save"

# Best-effort `rg info` for the record. WorldGuard replies asynchronously, so
# the RCON reply is often empty — retry a few times, never fatal.
INFO=""
for _ in 1 2 3; do
  INFO="$(rcon "rg info -w $LEVEL_NAME $REGION_ID")"
  echo "$INFO" | grep -qi "$REGION_ID" && break
  sleep 1
done
if echo "$INFO" | grep -qi "$REGION_ID"; then
  pass "rg info $REGION_ID replied:"
  echo "$INFO" | sed 's/^/[protect-spawn]   /'
else
  log "NOTE: rg info reply empty/async (known WorldGuard RCON quirk) — file round-trip above is the authoritative proof; a player can run /rg info spawn in-game"
fi

log "done. Spawn region active in world '$LEVEL_NAME' (cuboid -32,80,-32 -> 32,200,32, priority 10)."
