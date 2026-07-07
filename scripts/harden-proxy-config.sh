#!/usr/bin/env bash
# MuchuCraft: relax per-IP limits that break the proxy architecture.
#
# Every browser player connects THROUGH the gateway proxy, so the Minecraft
# server sees them ALL coming from 127.0.0.1. Any per-IP connection/player
# limit therefore throttles the ENTIRE playerbase as if they were one person:
#   - GriefPrevention MaxPlayersPerIpAddress capped the whole server (default 3!)
#   - GriefPrevention LoginCooldownSeconds made everyone share one login cooldown
#   - Paper connection-throttle rate-limited all joins collectively
# The proxy already gates every connection with wallet auth, so these are both
# redundant and actively harmful here. Also lowers view/sim distance so chunk
# sends are lighter (faster, more reliable loads).
#
# Idempotent; run after the server has booted once (configs must exist).
set -euo pipefail
SRV="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)"

gp="$SRV/plugins/GriefPreventionData/config.yml"
if [ -f "$gp" ]; then
  sed -i -E 's/MaxPlayersPerIpAddress: [0-9]+/MaxPlayersPerIpAddress: 0/' "$gp"
  sed -i -E 's/LoginCooldownSeconds: [0-9]+/LoginCooldownSeconds: 0/' "$gp"
  echo "[harden] GriefPrevention: MaxPlayersPerIpAddress=0, LoginCooldownSeconds=0"
else
  echo "[harden] WARN: $gp not found (boot the server once first)"
fi

bk="$SRV/bukkit.yml"
if [ -f "$bk" ]; then
  sed -i -E 's/connection-throttle: [0-9-]+/connection-throttle: -1/' "$bk"
  echo "[harden] bukkit.yml: connection-throttle=-1"
fi

sp="$SRV/server.properties"
if [ -f "$sp" ]; then
  sed -i -E 's/^view-distance=.*/view-distance=6/' "$sp"
  sed -i -E 's/^simulation-distance=.*/simulation-distance=5/' "$sp"
  echo "[harden] server.properties: view-distance=6, simulation-distance=5"
fi

echo "[harden] done — restart the server to apply."
