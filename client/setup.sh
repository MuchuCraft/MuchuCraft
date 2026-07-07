#!/usr/bin/env bash
# Downloads the MIT-licensed minecraft-web-client self-host bundle (dist/ + reference server.js).
# Pinned to v2.0.1 — the version client/NOTES.md documents the wire protocol against.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ -d dist ]; then
  echo "[client] dist/ already present — nothing to do"
  exit 0
fi

VERSION="v2.0.1"
echo "[client] downloading minecraft-web-client ${VERSION} self-host bundle (~18 MB)..."
curl -fL -o self-host.zip "https://github.com/zardoy/minecraft-web-client/releases/download/${VERSION}/self-host.zip"
unzip -oq self-host.zip
[ -d dist ] || { echo "[client] extraction failed — no dist/"; exit 1; }
echo "[client] done ($(du -sh dist | cut -f1) in dist/)"

# MuchuCraft pointer-lock guard (fixes upstream #562 — GUI clicks re-capturing
# the mouse). Idempotent; re-applied on every fresh download.
node "$(dirname "${BASH_SOURCE[0]}")/../scripts/patch-client-dist.mjs" dist
