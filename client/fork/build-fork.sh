#!/usr/bin/env bash
# Builds the MuchuCraft client fork: upstream minecraft-web-client + our
# inventory drag-to-move patch (see README.md). Installs the built client into
# client/dist. Idempotent-ish: re-clones into a temp dir each run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(dirname "$HERE")"          # client/
WORK="${MWC_FORK_DIR:-/home/ubuntu/mwc-fork}"
UPSTREAM_COMMIT="d154db48ba7c7ededc96dc121a69eb8f406663d9"

if [ ! -d "$WORK/.git" ]; then
  echo "[fork] cloning upstream into $WORK"
  git clone https://github.com/zardoy/minecraft-web-client "$WORK"
fi
cd "$WORK"
git fetch --depth 1 origin "$UPSTREAM_COMMIT" 2>/dev/null || true
git checkout -q "$UPSTREAM_COMMIT" 2>/dev/null || echo "[fork] using current checkout"

command -v pnpm >/dev/null || { corepack enable 2>/dev/null || npm i -g pnpm; }
echo "[fork] installing deps"
pnpm install

echo "[fork] applying MuchuCraft inventory drag-to-move patch"
cp "$HERE/Slot.patched.tsx" node_modules/minecraft-inventory/src/components/Slot/Slot.tsx

echo "[fork] building (rsbuild)"
pnpm build

echo "[fork] installing built client into $CLIENT_DIR/dist"
rm -rf "$CLIENT_DIR/dist"
cp -r dist "$CLIENT_DIR/dist"

# Re-apply the MuchuCraft pointer-lock + stale-SW-purge guard.
node "$CLIENT_DIR/../scripts/patch-client-dist.mjs" "$CLIENT_DIR/dist"
echo "[fork] done — client/dist now serves the fork with drag-to-move"
