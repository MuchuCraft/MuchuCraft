#!/usr/bin/env bash
# server/setup.d/experience.sh — MuchuCraft Phase 4 §3/§4 player-experience seed
# (experience agent). Wired into server/setup.sh by the integrator; also safe to
# run standalone at any time (idempotent — every write converges to the same
# state). server/plugins/ is gitignored, so this script must be able to recreate
# every Essentials edit on a fresh clone.
#
# What it does (files only — no server interaction):
#   - plugins/Essentials/config.yml: sethome-multiple {default: 2, depositor: 5},
#     teleport-delay 3, teleport-cooldown 30, respawn-at-home false
#     (EssentialsX honors a pre-created/partial config.yml; missing keys use
#     plugin defaults — same convention as the setup.sh economy seed).
#   - plugins/Essentials/kits.yml: the one-time `starter` kit incl. the
#     "Welcome to MuchuCraft" written book (full canonical file).
#   - plugins/Essentials/motd.txt + rules.txt: Muchu-branded.
#
# AFTER the server is up (these need a live server, not files):
#   1. scripts/perms-bootstrap.sh        # LuckPerms QoL grants + self-verify
#   2. RCON: essentials reload           # only if the server was already running
#   3. RCON: chunky center 0 0 && chunky radius 3000 && chunky start
#      (SPEC-PHASE4 §4 pregen — resumes across restarts; check with
#       `chunky progress`; expect roughly 2-6 GB of world data)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
ESS_DIR="$SERVER_DIR/plugins/Essentials"

log() { echo "[experience-setup] $*"; }

mkdir -p "$ESS_DIR"

# ---------------------------------------------------------------------------
# config.yml — scalar keys: overwrite if present, append if absent (partial
# configs are valid; EssentialsX fills missing keys with defaults).
# ---------------------------------------------------------------------------
CONFIG="$ESS_DIR/config.yml"
[ -f "$CONFIG" ] || : >"$CONFIG"

set_scalar() { # key value
  if grep -q "^${1}:" "$CONFIG"; then
    sed -i "s/^${1}: .*/${1}: ${2}/" "$CONFIG"
  else
    printf '%s: %s\n' "$1" "$2" >>"$CONFIG"
  fi
  log "config.yml: ${1}: ${2}"
}
set_scalar teleport-cooldown 30   # SPEC-PHASE4 §3: modest /home //tpa cooldown
set_scalar teleport-delay 3      # SPEC-PHASE4 §3: 3s warmup (no combat escape)
set_scalar respawn-at-home false # respawn at spawn unless the player has a bed

# sethome-multiple is a map: replace the whole block if present, else append.
# Node names verified against EssentialsX-2.22.0 (Settings#getHomeLimit):
# essentials.sethome.multiple.<KEY> for every KEY of this map, granted by
# scripts/perms-bootstrap.sh (default → 2 homes, depositor → 5).
if grep -q '^sethome-multiple:' "$CONFIG"; then
  awk '
    /^sethome-multiple:/ {
      print "sethome-multiple:"
      print "  default: 2"
      print "  depositor: 5"
      inblock = 1
      next
    }
    inblock && /^[[:space:]]/ { next }      # swallow the old map entries
    inblock { inblock = 0 }
    { print }
  ' "$CONFIG" >"$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
else
  printf 'sethome-multiple:\n  default: 2\n  depositor: 5\n' >>"$CONFIG"
fi
log "config.yml: sethome-multiple {default: 2, depositor: 5}"

# ---------------------------------------------------------------------------
# kits.yml — canonical file (stock EssentialsX example kits + MuchuCraft
# starter kit). delay -1 = one-time kit. The welcome book is a console command
# line ('/...', '{player}' replaced with the receiver's name by EssentialsX
# Kit.java) because that is the only kit syntax that carries full 1.21
# item-component SNBT.
# ---------------------------------------------------------------------------
cat >"$ESS_DIR/kits.yml" <<'EOF'
# EssentialsX kit configuration.
# If no kits are defined in this file, the plugin will attempt to copy them from 'config.yml'.

# All items MUST be followed by a quantity.
# Kit names should be in lowercase and will be treated as such in permissions and costs.
# Syntax: - item[:durability] amount [enchantment:level]... [itemmeta:value]...
# For detailed information on item meta, visit https://wiki.ess3.net/wiki/Item_Meta
#
# To make a kit execute a command, add '/<command>' to the item list. Use {USERNAME} to reference the player receiving the kit.
# Use {PLAYER} to display the player's display name instead of the username.
# 'delay' refers to the cooldown between how often you can use each kit, measured in seconds. Set to -1 for a one-time kit.
#
# You can also organize kits into separate files within the 'kits' subdirectory.
# Essentials will treat all '.yml' files in the subdirectory as valid kit files and add them along with those in here.
# Each file in the 'kits' subdirectory must be formatted the same as this file.
#
# For more information, refer to https://wiki.ess3.net/wiki/Kits

kits:
  # MuchuCraft starter kit (SPEC-PHASE4.md §3). delay -1 = one-time kit (see
  # header above). The welcome book is given via a console command line because
  # EssentialsX-2.22.0 kit command lines (leading '/', '{player}' replaced with
  # the receiver's name, dispatched as console — Kit.java) are the only way to
  # carry full 1.21 item-component SNBT. Granted to everyone via
  # essentials.kits.starter (scripts/perms-bootstrap.sh).
  starter:
    delay: -1
    items:
      - stone_sword 1
      - stone_pickaxe 1
      - stone_axe 1
      - stone_shovel 1
      - bread 16
      - torch 32
      - cherry_sapling 1
      - '/minecraft:give {player} minecraft:written_book[minecraft:written_book_content={title:"Welcome to MuchuCraft",author:"Muchu",pages:[{text:"",extra:[{text:"MuchuCraft\n\n",color:"dark_purple",bold:true},{text:"Your wallet is your identity. Your username is bound to the Solana wallet you signed in with — no passwords, ever.\n\nEverything you earn here is ",color:"black"},{text:"MUCHU",color:"dark_purple",bold:true},{text:".",color:"black"}]},{text:"",extra:[{text:"Earn MUCHU\n\n",color:"dark_green",bold:true},{text:"/jobs join Builder",color:"dark_purple"},{text:" — get paid to build.\n\n",color:"black"},{text:"/deposit",color:"dark_purple"},{text:" tops up in-game and unlocks ALL jobs.\n\n",color:"black"},{text:"/withdraw",color:"dark_purple"},{text:" cashes out to your wallet on the website.",color:"black"}]},{text:"",extra:[{text:"Home & Land\n\n",color:"dark_green",bold:true},{text:"/sethome",color:"dark_purple"},{text:" saves your base (2 homes, 5 once you deposit), ",color:"black"},{text:"/home",color:"dark_purple"},{text:" returns, ",color:"black"},{text:"/spawn",color:"dark_purple"},{text:" goes to the plaza.\n\nClaim land with a golden shovel: right-click two opposite corners.",color:"black"}]},{text:"",extra:[{text:"Handy\n\n",color:"dark_green",bold:true},{text:"/kit starter",color:"dark_purple"},{text:" — this kit, once per player.\n",color:"black"},{text:"/rules /motd /help\n/pay /balance /mail /tpa\n\n",color:"dark_purple"},{text:"Manage MUCHU at https://web.muchu.app — the site where you connected your wallet. Have fun!",color:"black"}]}]}] 1'
  tools:
    delay: 10
    items:
      - stonesword 1
      - stoneshovel 1
      - stonepickaxe 1
      - stoneaxe 1
  dtools:
    delay: 600
    items:
      - dpickaxe 1 efficiency:1 durability:1 fortune:1 name:&4Gigadrill lore:The_drill_that_&npierces|the_heavens
      - dshovel 1 digspeed:3 name:Dwarf lore:Diggy|Diggy|Hole
      - lhelm 1 color:255,255,255 name:Top_Hat lore:Good_day,_Good_day
      - daxe:780 1
      - /broadcast {USERNAME} just got some fancy tools!
  notch:
    delay: 6000
    items:
      - playerhead 1 player:Notch
  color:
    delay: 6000
    items:
      - writtenbook 1 title:&4Book_&9o_&6Colors author:KHobbits lore:Ingame_color_codes book:Colors
  firework:
    delay: 6000
    items:
      - fireworkrocket 1 name:Angry_Creeper color:red fade:green type:creeper power:1
      - fireworkrocket 1 name:Starry_Night color:yellow,orange fade:blue type:star effect:trail,twinkle power:1
      - fireworkrocket 2 name:Solar_Wind color:yellow,orange fade:red shape:large effect:twinkle color:yellow,orange fade:red shape:ball effect:trail color:red,purple fade:pink shape:star effect:trail power:1
EOF
log "kits.yml: starter kit seeded (one-time, with welcome book)"

# ---------------------------------------------------------------------------
# motd.txt / rules.txt — Muchu-branded (SPEC-PHASE4 §3)
# ---------------------------------------------------------------------------
cat >"$ESS_DIR/motd.txt" <<'EOF'
&5Muchu&dCraft &7— play Minecraft, earn &aMUCHU&7 on Solana.
&7Signed in as &d{PLAYER}&7 — your wallet is your identity.
&aEarn:  &f/jobs join Builder &7(then &f/deposit&7 to unlock every job)
&aStart: &f/kit starter &8| &f/sethome &8| &f/spawn &8| &f/rules
&aMoney: &f/balance /pay /deposit /withdraw
&7Cash out or top up at &dhttps://web.muchu.app&7 — the site where you connected your wallet.
&7Players online: &f{ONLINE}
EOF
cat >"$ESS_DIR/rules.txt" <<'EOF'
&5MuchuCraft rules
&a1. &fNo griefing. Protect your builds with a golden shovel claim; unclaimed builds are at your own risk.
&a2. &fThe spawn plaza is protected — build out in the wild.
&a3. &fNo hacks, exploits, dupes, or lag machines.
&a4. &fBe kind in chat. No spam, no scams — nobody legit will ever ask for your seed phrase.
&a5. &fEconomy abuse (bug faucets, alt farming, payout laundering) gets your wallet banned.
&a6. &fHave fun and keep MUCHU moving.
EOF
log "motd.txt + rules.txt written"

log "done. Post-boot: run scripts/perms-bootstrap.sh, then RCON 'essentials reload' if the server was already up."
