#!/usr/bin/env bash
# MuchuCraft — Paper server launcher (Aikar's G1GC flags).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[ -f paper.jar ] || { echo "[server] ERROR: paper.jar missing — run setup.sh first" >&2; exit 1; }

# Resolve java: PATH first, then sdkman candidates (non-login shells lack the
# sdkman PATH entries). Among everything found, pick the HIGHEST major version:
# Paper 1.21.11 needs Java 21+, but WorldEdit 7.4.4 is compiled for Java 25
# (class file 69), so an older PATH java must not shadow a newer sdkman one.
java_major() { "$1" -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -n1; }

CANDIDATES=()
p="$(command -v java || true)"
[ -n "$p" ] && CANDIDATES+=("$p")
[ -x /home/ubuntu/.sdkman/candidates/java/current/bin/java ] \
  && CANDIDATES+=(/home/ubuntu/.sdkman/candidates/java/current/bin/java)
for c in /home/ubuntu/.sdkman/candidates/java/*/bin/java; do
  [ -x "$c" ] && CANDIDATES+=("$c")
done

JAVA_BIN=""
BEST=0
for c in "${CANDIDATES[@]}"; do
  v="$(java_major "$c" || true)"
  [ -n "$v" ] || continue
  if [ "$v" -gt "$BEST" ]; then BEST="$v" JAVA_BIN="$c"; fi
done
[ -n "$JAVA_BIN" ] || { echo "[server] ERROR: java not found on PATH or in sdkman" >&2; exit 1; }

echo "[server] using java: $JAVA_BIN"

exec "$JAVA_BIN" -Xms4G -Xmx8G \
  -XX:+UseG1GC \
  -XX:+ParallelRefProcEnabled \
  -XX:MaxGCPauseMillis=200 \
  -XX:+UnlockExperimentalVMOptions \
  -XX:+DisableExplicitGC \
  -XX:+AlwaysPreTouch \
  -XX:G1NewSizePercent=30 \
  -XX:G1MaxNewSizePercent=40 \
  -XX:G1HeapRegionSize=8M \
  -XX:G1ReservePercent=20 \
  -XX:G1HeapWastePercent=5 \
  -XX:G1MixedGCCountTarget=4 \
  -XX:InitiatingHeapOccupancyPercent=15 \
  -XX:G1MixedGCLiveThresholdPercent=90 \
  -XX:G1RSetUpdatingPauseTimePercent=5 \
  -XX:SurvivorRatio=32 \
  -XX:+PerfDisableSharedMem \
  -XX:MaxTenuringThreshold=1 \
  -Dusing.aikars.flags=https://mcflags.emc.gs \
  -Daikars.new.flags=true \
  -jar paper.jar nogui
