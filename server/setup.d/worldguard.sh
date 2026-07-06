#!/usr/bin/env bash
# server/setup.d/worldguard.sh — WorldGuard install for MuchuCraft (SPEC-PHASE4.md §2).
#
# Downloads WorldGuard 7.0.16 (Modrinth version EZl3moba — immutable CDN URL,
# sha512-pinned). VERIFIED pairing for this stack:
#   - plugin.yml:  api-version "1.21.11", depend: [WorldEdit]  (matches the
#     running Paper 1.21.11)
#   - Pairs with the installed WorldEdit 7.4.4 (worldedit-bukkit-7.4.4.jar);
#     WorldGuard's YAML region storage even loads through WorldEdit's
#     com.sk89q.util.yaml.YAMLProcessor, so WorldEdit MUST be present.
#   - 7.0.16 changelog: "Update to 1.21.11" (7.0.17 targets MC 26.1+).
#
# Style mirrors server/setup.sh download_pinned(). Idempotent: skips when the
# jar is already present. Run from anywhere; operates on <repo>/server.
#
# NOTE: this only installs the jar. The spawn region, flags, worldborder and
# GriefPrevention wilderness settings are applied AGAINST THE RUNNING SERVER
# (post-restart, once WorldGuard is loaded) by scripts/protect-spawn.sh.
# See docs/PROTECTION.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
cd "$SERVER_DIR"

log() { echo "[worldguard-setup] $*"; }
die() { echo "[worldguard-setup] ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v unzip >/dev/null || die "unzip is required"

mkdir -p plugins

WG_FILENAME="worldguard-bukkit-7.0.16.jar"
WG_URL="https://cdn.modrinth.com/data/DKY9btbd/versions/EZl3moba/worldguard-bukkit-7.0.16.jar"
WG_SHA512="70ed07f145a1b686e270bad3ba235a3a5e70005d8357c13e3130bf032b048add1aa1dd000f5521f77409c53a141111da2f6bf3eb610654c05f47666769d11d4c"

# WorldGuard hard-depends on WorldEdit (plugin.yml `depend: [WorldEdit]`) —
# warn early if the main setup.sh has not installed it yet.
if ! compgen -G 'plugins/worldedit-bukkit-*.jar' >/dev/null; then
  log "WARNING: no worldedit-bukkit-*.jar in plugins/ — WorldGuard will not enable without WorldEdit (server/setup.sh installs it)"
fi

if [ -f "plugins/${WG_FILENAME}" ]; then
  log "worldguard: already installed (plugins/${WG_FILENAME}) — skipping"
else
  log "worldguard: downloading 7.0.16 (${WG_FILENAME})"
  curl -fsS -L -o "plugins/${WG_FILENAME}.tmp" "$WG_URL" || die "worldguard: download failed (${WG_URL})"
  echo "${WG_SHA512}  plugins/${WG_FILENAME}.tmp" | sha512sum -c --status \
    || { rm -f "plugins/${WG_FILENAME}.tmp"; die "worldguard: sha512 mismatch"; }
  unzip -p "plugins/${WG_FILENAME}.tmp" plugin.yml >/dev/null 2>&1 \
    || { rm -f "plugins/${WG_FILENAME}.tmp"; die "worldguard: jar contains no plugin.yml"; }
  unzip -p "plugins/${WG_FILENAME}.tmp" plugin.yml | grep -q 'depend: \[WorldEdit\]' \
    || { rm -f "plugins/${WG_FILENAME}.tmp"; die "worldguard: plugin.yml does not declare depend: [WorldEdit]"; }
  mv "plugins/${WG_FILENAME}.tmp" "plugins/${WG_FILENAME}"
  log "worldguard: sha512 verified -> plugins/${WG_FILENAME}"
fi

log "done. WorldGuard loads on the next server (re)start; then run scripts/protect-spawn.sh"
