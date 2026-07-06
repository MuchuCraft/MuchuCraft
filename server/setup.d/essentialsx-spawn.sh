#!/usr/bin/env bash
# server/setup.d/essentialsx-spawn.sh — EssentialsXSpawn addon (SPEC-PHASE4.md §1/§3).
#
# EssentialsX core (installed by server/setup.sh via Modrinth) does NOT ship
# /spawn and /setspawn — those live in the separate EssentialsXSpawn addon
# module. Phase 4 needs /spawn (players return to the plaza dais; the
# essentials.spawn permission is already granted to the default group by
# scripts/perms-bootstrap.sh, and plugins/Essentials/spawn.yml is written by
# scripts/build-spawn.mjs).
#
# Pinned to 2.22.0 — the SAME version as the installed EssentialsX core
# (EssentialsX-2.22.0.jar); the addon depends on Essentials and must match.
# Immutable GitHub release asset, sha512-verified. Idempotent: skips when the
# jar is already present. Style mirrors server/setup.sh download_pinned().
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
cd "$SERVER_DIR"

log() { echo "[essentialsx-spawn-setup] $*"; }
die() { echo "[essentialsx-spawn-setup] ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v unzip >/dev/null || die "unzip is required"

mkdir -p plugins

ESPAWN_FILENAME="EssentialsXSpawn-2.22.0.jar"
ESPAWN_URL="https://github.com/EssentialsX/Essentials/releases/download/2.22.0/EssentialsXSpawn-2.22.0.jar"
ESPAWN_SHA512="7097478ec02bc46e1dce326520e7dd0cf38bcce0f7810c1c89cfcc2fef8a88a7dc27c5a946d1256abad589185c5015c615e2cb4eab181ea7362428fac581b964"

# The addon hard-depends on Essentials (plugin.yml `depend: [Essentials]`) and
# must be version-matched with the installed core — warn early if it is not.
if ! compgen -G 'plugins/EssentialsX-2.22.0.jar' >/dev/null; then
  log "WARNING: plugins/EssentialsX-2.22.0.jar not found — EssentialsXSpawn 2.22.0 must match the installed EssentialsX core version"
fi

if [ -f "plugins/${ESPAWN_FILENAME}" ]; then
  log "essentialsx-spawn: already installed (plugins/${ESPAWN_FILENAME}) — skipping"
else
  log "essentialsx-spawn: downloading 2.22.0 (${ESPAWN_FILENAME})"
  curl -fsS -L -o "plugins/${ESPAWN_FILENAME}.tmp" "$ESPAWN_URL" || die "download failed (${ESPAWN_URL})"
  echo "${ESPAWN_SHA512}  plugins/${ESPAWN_FILENAME}.tmp" | sha512sum -c --status \
    || { rm -f "plugins/${ESPAWN_FILENAME}.tmp"; die "sha512 mismatch"; }
  unzip -p "plugins/${ESPAWN_FILENAME}.tmp" plugin.yml >/dev/null 2>&1 \
    || { rm -f "plugins/${ESPAWN_FILENAME}.tmp"; die "jar contains no plugin.yml"; }
  unzip -p "plugins/${ESPAWN_FILENAME}.tmp" plugin.yml | grep -q '^name: EssentialsSpawn$' \
    || { rm -f "plugins/${ESPAWN_FILENAME}.tmp"; die "plugin.yml is not EssentialsSpawn"; }
  mv "plugins/${ESPAWN_FILENAME}.tmp" "plugins/${ESPAWN_FILENAME}"
  log "essentialsx-spawn: sha512 verified -> plugins/${ESPAWN_FILENAME}"
fi

log "done. EssentialsSpawn loads on the next server (re)start; /spawn reads plugins/Essentials/spawn.yml"
