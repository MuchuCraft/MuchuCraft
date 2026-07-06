#!/usr/bin/env bash
# MuchuCraft — Paper server setup (idempotent).
#
# - Reads shared config from ../.env (MC_VERSION, MC_PORT, RCON_*, MC_SEED).
# - Downloads Paper for $MC_VERSION via the PaperMC fill v3 API and VERIFIES
#   the sha256 advertised by the API.
# - Downloads plugins from Modrinth (filtered by game version + paper/bukkit
#   loader, sha512-verified) plus Vault 1.7.3 from GitHub releases.
# - Writes eula.txt and server.properties per SPEC.md.
# - Fills MC_SEED= in the root .env with a documented scenic seed if empty.
#
# Safe to re-run: existing downloads are skipped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"
cd "$SCRIPT_DIR"

log() { echo "[server-setup] $*"; }
die() { echo "[server-setup] ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"

# ---------------------------------------------------------------------------
# Config from root .env
# ---------------------------------------------------------------------------
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${MC_VERSION:?MC_VERSION missing from .env}"
: "${MC_PORT:=25565}"
: "${RCON_PORT:=25575}"
: "${RCON_PASSWORD:?RCON_PASSWORD missing from .env}"

log "MC_VERSION=${MC_VERSION} MC_PORT=${MC_PORT} RCON_PORT=${RCON_PORT}"

# ---------------------------------------------------------------------------
# Scenic seed — snowy-mountain cherry-grove village at spawn (0, 119, -1),
# with an ancient city below and a second village ~270 blocks away.
# Documented for Minecraft Java 1.21.11:
# https://wisehosting.com/minecraft-seeds/snowy-mountain-cherry-grove-village
# ---------------------------------------------------------------------------
SCENIC_SEED="-2350879005487267529"
if [ -z "${MC_SEED:-}" ]; then
  MC_SEED="$SCENIC_SEED"
  if grep -q '^MC_SEED=' "$ENV_FILE"; then
    sed -i "s/^MC_SEED=.*/MC_SEED=${MC_SEED}/" "$ENV_FILE"
  else
    printf 'MC_SEED=%s\n' "$MC_SEED" >>"$ENV_FILE"
  fi
  log "wrote MC_SEED=${MC_SEED} to .env"
else
  log "using existing MC_SEED=${MC_SEED} from .env"
fi

# ---------------------------------------------------------------------------
# Paper jar via fill v3 API (sha256-verified)
# ---------------------------------------------------------------------------
FILL_URL="https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds/latest"
log "resolving latest Paper build: ${FILL_URL}"
BUILD_JSON="$(curl -fsSL "$FILL_URL")" || die "fill API request failed"
PAPER_BUILD="$(jq -r '.id // empty' <<<"$BUILD_JSON")"
PAPER_URL="$(jq -r '.downloads["server:default"].url // empty' <<<"$BUILD_JSON")"
PAPER_SHA256="$(jq -r '.downloads["server:default"].checksums.sha256 // empty' <<<"$BUILD_JSON")"
[ -n "$PAPER_BUILD" ] && [ -n "$PAPER_URL" ] && [ -n "$PAPER_SHA256" ] \
  || die "fill API response missing build/url/sha256 for ${MC_VERSION}"
log "latest Paper ${MC_VERSION} build ${PAPER_BUILD}"

if [ -f paper.jar ] && echo "${PAPER_SHA256}  paper.jar" | sha256sum -c --status; then
  log "paper.jar already present with matching sha256 — skipping download"
else
  log "downloading paper.jar (build ${PAPER_BUILD})"
  curl -fsSL -o paper.jar.tmp "$PAPER_URL"
  echo "${PAPER_SHA256}  paper.jar.tmp" | sha256sum -c --status \
    || { rm -f paper.jar.tmp; die "sha256 mismatch for downloaded paper.jar"; }
  mv paper.jar.tmp paper.jar
  log "paper.jar sha256 verified"
fi

# ---------------------------------------------------------------------------
# Plugins
# ---------------------------------------------------------------------------
mkdir -p plugins

# download_modrinth <project-slug> <existing-jar-glob>
# Picks the newest *release* (falls back to newest of any type) supporting
# $MC_VERSION on the paper/bukkit loaders; sha512-verifies the primary file.
download_modrinth() {
  local project="$1" glob="$2"
  local existing
  existing="$(compgen -G "plugins/${glob}" || true)"
  if [ -n "$existing" ]; then
    log "${project}: already installed (${existing}) — skipping"
    return 0
  fi

  local api="https://api.modrinth.com/v2/project/${project}/version?game_versions=%5B%22${MC_VERSION}%22%5D&loaders=%5B%22paper%22%2C%22bukkit%22%5D"
  local json
  json="$(curl -fsSL "$api")" || die "${project}: Modrinth API request failed"
  [ "$(jq 'length' <<<"$json")" -gt 0 ] || die "${project}: no build for ${MC_VERSION} (paper/bukkit)"

  local line url filename sha512 vnum
  line="$(jq -r '
    (([.[] | select(.version_type == "release")] + .)[0]) as $v
    | ((($v.files | map(select(.primary))) + $v.files)[0]) as $f
    | [$f.url, $f.filename, $f.hashes.sha512, $v.version_number] | @tsv
  ' <<<"$json")"
  IFS=$'\t' read -r url filename sha512 vnum <<<"$line"
  [ -n "$url" ] && [ "$url" != "null" ] || die "${project}: could not resolve download URL"

  log "${project}: downloading ${vnum} (${filename})"
  curl -fsSL -o "plugins/${filename}.tmp" "$url"
  echo "${sha512}  plugins/${filename}.tmp" | sha512sum -c --status \
    || { rm -f "plugins/${filename}.tmp"; die "${project}: sha512 mismatch"; }
  mv "plugins/${filename}.tmp" "plugins/${filename}"
  log "${project}: sha512 verified -> plugins/${filename}"
}

download_modrinth essentialsx 'EssentialsX-*.jar'
download_modrinth luckperms  'LuckPerms-Bukkit-*.jar'
download_modrinth worldedit  'worldedit-bukkit-*.jar'
download_modrinth viaversion 'ViaVersion-*.jar'
download_modrinth chunky     'Chunky-Bukkit-*.jar'

# Vault 1.7.3 (not on Modrinth) — GitHub release asset, follow redirects.
VAULT_URL="https://github.com/MilkBowl/Vault/releases/download/1.7.3/Vault.jar"
if [ -f plugins/Vault.jar ]; then
  log "vault: already installed (plugins/Vault.jar) — skipping"
else
  log "vault: downloading 1.7.3 from GitHub releases"
  curl -fsS -L -o plugins/Vault.jar.tmp "$VAULT_URL"
  # Sanity check: a jar is a zip (PK\x03\x04 magic).
  head -c 2 plugins/Vault.jar.tmp | grep -q 'PK' \
    || { rm -f plugins/Vault.jar.tmp; die "vault: download is not a jar"; }
  mv plugins/Vault.jar.tmp plugins/Vault.jar
  log "vault: -> plugins/Vault.jar"
fi

# ---------------------------------------------------------------------------
# eula.txt + server.properties (templated from .env, per SPEC.md)
# ---------------------------------------------------------------------------
echo "eula=true" >eula.txt
log "wrote eula.txt"

# NOTE: \u00A7 is the section sign (\u00A7) — .properties files require the
# unicode escape for non-latin-1-safe characters.
cat >server.properties <<EOF
online-mode=false
server-ip=127.0.0.1
server-port=${MC_PORT}
enforce-secure-profile=false
enable-rcon=true
rcon.port=${RCON_PORT}
rcon.password=${RCON_PASSWORD}
network-compression-threshold=-1
view-distance=10
simulation-distance=8
spawn-protection=0
motd=\u00A7b\u00A7lMuchuCraft\u00A7r \u00A77- wallet-verified Minecraft
level-seed=${MC_SEED}
max-players=50
EOF
log "wrote server.properties (seed=${MC_SEED})"

log "setup complete — start with: bash start.sh"
