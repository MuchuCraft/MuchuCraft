#!/usr/bin/env bash
# MuchuCraft — Paper server setup (idempotent).
#
# - Reads shared config from ../.env (MC_VERSION, MC_PORT, RCON_*, MC_SEED).
# - Downloads Paper for $MC_VERSION via the PaperMC fill v3 API and VERIFIES
#   the sha256 advertised by the API.
# - Downloads plugins from Modrinth (filtered by game version + paper/bukkit
#   loader, sha512-verified) plus Vault 1.7.3 from GitHub releases.
# - Downloads the SPEC-TOKEN.md economy plugins (Jobs Reborn + CMILib,
#   EconomyShopGUI, GriefPrevention, UltraCosmetics) pinned to the versions
#   this repo was tested with, and pre-seeds their economy-critical configs
#   (server/plugins/ is gitignored — see server/plugins/POST-BOOT.md).
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
command -v unzip >/dev/null || die "unzip is required"

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
# Economy plugins (SPEC-TOKEN.md) — pinned to the exact versions this repo was
# built and tested against, so fresh clones match the running deployment.
# ---------------------------------------------------------------------------

# download_pinned <label> <filename> <sha512> <url>
# Immutable URL + sha512 pin; also asserts the jar contains a plugin.yml.
download_pinned() {
  local label="$1" filename="$2" sha512="$3" url="$4"
  if [ -f "plugins/${filename}" ]; then
    log "${label}: already installed (plugins/${filename}) — skipping"
    return 0
  fi
  log "${label}: downloading ${filename}"
  curl -fsS -L -o "plugins/${filename}.tmp" "$url" || die "${label}: download failed (${url})"
  echo "${sha512}  plugins/${filename}.tmp" | sha512sum -c --status \
    || { rm -f "plugins/${filename}.tmp"; die "${label}: sha512 mismatch"; }
  unzip -p "plugins/${filename}.tmp" plugin.yml >/dev/null 2>&1 \
    || { rm -f "plugins/${filename}.tmp"; die "${label}: jar contains no plugin.yml"; }
  mv "plugins/${filename}.tmp" "plugins/${filename}"
  log "${label}: sha512 verified -> plugins/${filename}"
}

# CMILib — hard dependency of Jobs Reborn 5.x (Zrips GitHub releases).
download_pinned cmilib "CMILib1.5.9.6.jar" \
  "26a459e3c841adca0cabbcd296da0a363bd4f535209f34e0e6a703556022f4a0ab4de90f5e9cacf8c15e17d069daea92bf8777cc0db7c53cab0137ea0d63e6ea" \
  "https://github.com/Zrips/CMILib/releases/download/1.5.9.6/CMILib1.5.9.6.jar"

# Jobs Reborn (Spigot resource 4216, jar from Zrips GitHub releases).
download_pinned jobs "Jobs5.2.6.3.jar" \
  "0c9bfac5adc507be7dd20573e3867377dbdf693ff1a9c847707e55d16231b2e31d5205ebd6642258ff9c92c1a8d48b69c6102c981240bac3d5732091c09a4222" \
  "https://github.com/Zrips/Jobs/releases/download/v5.2.6.3/Jobs5.2.6.3.jar"

# GriefPrevention 16.18.7 (Modrinth version dGfCZHqk — immutable CDN URL,
# supports MC 1.21.10/1.21.11, api-version 1.21.10).
download_pinned griefprevention "GriefPrevention-16.18.7.jar" \
  "c9bc692253ba3860327e5c38767ce3dc66c798264fe650a08b4ae888337ff75bc16e9bd1db7b39a514a275bf2cc2a3f1f8cd95cf080b89ae42a0f684fc2bfc66" \
  "https://cdn.modrinth.com/data/O4o4mKaq/versions/dGfCZHqk/GriefPrevention.jar"

# UltraCosmetics 3.15.0.1 (Modrinth version NliHJ5Uo). OPTIONAL cosmetics —
# if it misbehaves on this Paper build, delete the jar (nothing depends on it).
download_pinned ultracosmetics "UltraCosmetics-3.15.0.1-RELEASE.jar" \
  "d470d3cb08da55240f7a8039c3a3af1582f0e7572ae06de1dedbda178ae91339c1ca462f80dabb8b0f40c3db6fa51ad2306f1d0a6239f0e2ffd04e5f2775c0a6" \
  "https://cdn.modrinth.com/data/GLJ7ZGMW/versions/NliHJ5Uo/UltraCosmetics-3.15.0.1-RELEASE.jar"

# EconomyShopGUI (Spigot resource 69927). Spiget only serves a cached copy of
# the LATEST upstream version (version-pinned downloads 403 behind Cloudflare),
# so verify structurally and WARN — not fail — when upstream moved past the
# tested 7.1.1 build.
ESG_SHA512_7_1_1="a832b355d3aa3d79a17a8135262cb04ec6088e78331e2a03b6469ce2aeccc5ae07ecb8f505ff0249019bd07b0c93faa9dad375b45e0e930266593b00e331889f"
if compgen -G 'plugins/EconomyShopGUI-*.jar' >/dev/null; then
  log "economyshopgui: already installed ($(compgen -G 'plugins/EconomyShopGUI-*.jar')) — skipping"
else
  log "economyshopgui: downloading latest cached build from Spiget (resource 69927)"
  curl -fsS -L -o plugins/EconomyShopGUI.jar.tmp \
    "https://api.spiget.org/v2/resources/69927/download" \
    || die "economyshopgui: download failed"
  unzip -p plugins/EconomyShopGUI.jar.tmp plugin.yml >/dev/null 2>&1 \
    || { rm -f plugins/EconomyShopGUI.jar.tmp; die "economyshopgui: jar contains no plugin.yml"; }
  ESG_VERSION="$(unzip -p plugins/EconomyShopGUI.jar.tmp plugin.yml \
    | awk '$1 == "version:" { print $2; exit }' | tr -cd '0-9A-Za-z._-')"
  [ -n "$ESG_VERSION" ] || { rm -f plugins/EconomyShopGUI.jar.tmp; die "economyshopgui: could not read version from plugin.yml"; }
  if echo "${ESG_SHA512_7_1_1}  plugins/EconomyShopGUI.jar.tmp" | sha512sum -c --status; then
    log "economyshopgui: sha512 verified (7.1.1)"
  else
    log "economyshopgui: WARNING — upstream latest is ${ESG_VERSION}, tested version was 7.1.1 (hash differs; structural checks passed)"
  fi
  mv plugins/EconomyShopGUI.jar.tmp "plugins/EconomyShopGUI-${ESG_VERSION}.jar"
  log "economyshopgui: -> plugins/EconomyShopGUI-${ESG_VERSION}.jar"
fi

# ---------------------------------------------------------------------------
# Skins (SPEC-PHASE3.md §4) — SkinsRestorer works on offline-mode servers out
# of the box (it injects skin properties into the offline game profile). Skin
# lookups (name skins via Mojang, URL skins via MineSkin) need OUTBOUND
# internet from the server; no API key is required by default. Console apply
# syntax used by the gateway: `skin set <mcname-or-url> <player>`.
# See docs/SKINS.md.
# ---------------------------------------------------------------------------

# SkinsRestorer 15.12.4 (Modrinth version jPoqTGpe — immutable CDN URL,
# supports MC 1.8–1.21.11, plugin.yml api-version 1.13, folia-supported).
download_pinned skinsrestorer "SkinsRestorer.jar" \
  "5db2d7dd96e8b0d30f2344383fe6459b0c128db691c242ada04a84e9ffb940de27c69add81223fa0550fc8dc36612469d32d46ffa56e5328a70edb343697cb68" \
  "https://cdn.modrinth.com/data/TsLS8Py5/versions/jPoqTGpe/SkinsRestorer.jar"

# ---------------------------------------------------------------------------
# Economy plugin config pre-seeds (SPEC-TOKEN.md). server/plugins/ is
# gitignored, so these must be (re)created here for fresh clones. Values that
# only exist after a boot are verified via server/plugins/POST-BOOT.md.
# ---------------------------------------------------------------------------

# EssentialsX economy: currency-symbol 'MUCHU ', min-money 0 (no overdrafts —
# every in-game MUCHU is a real token liability), starting-balance 0.
# NOTE: EssentialsX 2.22.0 Settings#_getCurrencySymbol() falls back to '$' for
# symbols longer than one character; we still pin the spec'd value (harmless)
# and POST-BOOT.md flags the display caveat.
if [ -f plugins/Essentials/config.yml ]; then
  sed -i "s/^currency-symbol: .*/currency-symbol: 'MUCHU '/" plugins/Essentials/config.yml
  sed -i 's/^min-money: .*/min-money: 0/' plugins/Essentials/config.yml
  sed -i 's/^starting-balance: .*/starting-balance: 0/' plugins/Essentials/config.yml
  log "essentials: pinned currency-symbol/min-money/starting-balance in existing config.yml"
else
  mkdir -p plugins/Essentials
  cat >plugins/Essentials/config.yml <<'EOF'
# MuchuCraft (SPEC-TOKEN.md) — pre-seeded PARTIAL EssentialsX config.
# EssentialsX honors a pre-created config.yml; keys absent here use the plugin
# defaults. Only economy-critical keys are pinned:
starting-balance: 0
currency-symbol: 'MUCHU '
min-money: 0
EOF
  log "essentials: seeded partial config.yml (economy keys)"
fi

# Empty worth map: /sell + sell signs reject everything (no uncapped faucet).
cat >plugins/Essentials/worth.yml <<'EOF'
# MuchuCraft (SPEC-TOKEN.md): selling items to the server is DISABLED.
# In-game MUCHU is a 1:1 liability against real tokens in the treasury, so the
# only sanctioned Essentials-side faucet is Jobs Reborn (capped in
# plugins/Jobs/generalConfig.yml). An empty worth map makes /sell, /sellall and
# sell signs reject every item ("... cannot be sold"). Do NOT add entries here
# and avoid /setworth (it writes back into this file).
# EconomyShopGUI sell prices are configured separately under
# plugins/EconomyShopGUI/ — see server/plugins/POST-BOOT.md.
worth: {}
EOF
log "essentials: wrote empty worth.yml (/sell disabled)"

# Jobs Reborn: exploit protections + 100 MUCHU/day/player money cap (THE
# emission budget). Jobs merges this partial file with defaults on first boot
# and rewrites it, so never clobber an existing (merged) copy.
if [ -f plugins/Jobs/generalConfig.yml ]; then
  log "jobs: plugins/Jobs/generalConfig.yml exists — leaving as-is (verify per POST-BOOT.md)"
else
  mkdir -p plugins/Jobs
  cat >plugins/Jobs/generalConfig.yml <<'EOF'
# MuchuCraft (SPEC-TOKEN.md) — pre-seeded PARTIAL Jobs Reborn config.
# Jobs (CMILib ConfigReader) honors values already present in this file and
# appends every other key with its default value + comments on first enable,
# rewriting the whole file. After the first boot with Jobs installed, verify
# these values survived the merge — checklist in server/plugins/POST-BOOT.md.
#
# Key paths verified against Jobs v5.2.6.3 source (GeneralConfigManager.java).

Economy:
  Limit:
    # THE emission budget of the 1:1 token economy: each player can earn at
    # most 100 MUCHU per rolling 24h from jobs, so the max daily new liability
    # is 100 x active players. Keep in sync with treasury top-up policy.
    Money:
      Use: true
      StopWithExp: false
      StopWithPoint: false
      # A plain number is a flat cap (equations like '500+500*(totallevel/100)'
      # are also supported — do NOT reintroduce one without owner sign-off).
      MoneyLimit: '100'
      # Rolling window in seconds: 86400 = 24 hours.
      TimeLimit: 86400
      # Empty = use TimeLimit above (a clock time here would override it).
      ResetTime: ''
      # Seconds between "limit reached" chat announcements.
      AnnouncementDelay: 30

ExploitProtections:
  General:
    # Never pay for breaking blocks that a player placed (place/break farm
    # protection) — mandatory when Vault money is backed by real tokens.
    PlaceAndBreak:
      Enabled: true
      NewMethod: true
      IgnoreOreGenerators: true
      # Days to remember player-placed blocks.
      KeepDataFor: 14
      GlobalBlockTimer:
        Place:
          Use: true
          Timer: 3
        Break:
          Use: true
          Timer: 3
      # No payment for silk-touch re-mining loops either.
      SilkTouchProtection: true
EOF
  log "jobs: seeded generalConfig.yml (money cap 100/day, exploit protections)"
fi

# UltraCosmetics: its default treasure chests PAY OUT Vault money (15–100 per
# chest) — an unacceptable faucet for a token-backed economy. Seed the full
# bundled default config with ONLY TreasureChests.Loots.Money.Enabled flipped
# to false. Never clobber an existing copy.
UC_JAR="$(compgen -G 'plugins/UltraCosmetics-*.jar' | head -n1 || true)"
if [ -f plugins/UltraCosmetics/config.yml ]; then
  log "ultracosmetics: plugins/UltraCosmetics/config.yml exists — leaving as-is (verify per POST-BOOT.md)"
elif [ -n "$UC_JAR" ]; then
  mkdir -p plugins/UltraCosmetics
  unzip -p "$UC_JAR" config.yml | awk '
    $0 == "  Loots:" { inloots = 1 }
    inloots && $0 == "    Money:" { inmoney = 1 }
    inmoney && $0 == "      Enabled: true" { print "      Enabled: false"; inmoney = 0; inloots = 0; next }
    { print }
  ' >plugins/UltraCosmetics/config.yml
  UC_MONEY="$(awk '
    $0 == "  Loots:" { inloots = 1 }
    inloots && $0 == "    Money:" { inmoney = 1 }
    inmoney && $1 == "Enabled:" { print $2; exit }
  ' plugins/UltraCosmetics/config.yml)"
  [ "$UC_MONEY" = "false" ] \
    || die "ultracosmetics: failed to disable treasure-chest money loot in seeded config"
  log "ultracosmetics: seeded config.yml with treasure-chest money loot disabled"
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

# ---------------------------------------------------------------------------
# POST-FIRST-BOOT (earn gate, SPEC-PHASE3 §2) — NOT run by this script.
# After the server has booted once (LuckPerms + Jobs data generated) and while
# it is RUNNING, bootstrap the deposit earn gate from the repo root:
#
#   scripts/lp-bootstrap.sh              # idempotent; STARTER_JOB=builder
#
# It creates the `depositor` group (weight 10, jobs.join.<job>=true for all 12
# jobs), restricts the default group to the starter job (jobs.join.builder
# true, every other jobs.join.<job> false), and self-verifies via `lp export`.
# Node is `jobs.join.<job>` — verified on Jobs 5.2.6.3; `jobs.use.<job>` is NOT
# a real node, and `jobs.use` must never be negated (payouts require it).
# Details + verified behavior notes: docs/EARN-GATE.md
# ---------------------------------------------------------------------------
