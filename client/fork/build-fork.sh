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
# Client-source patch: sanitize item names/lore so raw NBT-component JSON never
# shows in tooltips (ViaBackwards delivers 1.20.5+ component names flat() can't parse).
cp "$HERE/sharedConnectorSetup.patched.ts" src/react/inventory/sharedConnectorSetup.ts
# Item name/lore → readable text (componentToText); keeps Jobs GUI job info
# from rendering as raw NBT JSON or being replaced by the icon item name.
cp "$HERE/items.patched.ts" src/mineflayer/items.ts

# Mesher WASM-readiness gate (fixes stars/xray on slower machines): the mesher
# worker processed chunk columns before its WASM instantiated. The patched
# worker buffers wasm-dependent terrain messages until ready. The
# minecraft-renderer npm package ships src+dist but NOT its worker build
# scripts, so we vendor them (from github.com/zardoy/minecraft-renderer) and
# rebuild dist/mesherWasm.js in place; the rsbuild below then copies it.
MR="node_modules/minecraft-renderer"
if [ -d "$MR/src/wasm-mesher/worker" ]; then
  cp "$HERE/mesherWasm.worker.patched.ts" "$MR/src/wasm-mesher/worker/mesherWasm.ts"
  mkdir -p "$MR/scripts" "$MR/src/lib"
  cp "$HERE/mesher-build-scripts/buildMesherWorker.mjs" "$MR/scripts/"
  cp "$HERE/mesher-build-scripts/buildWorkerShared.mjs" "$MR/scripts/"
  cp "$HERE/mesher-build-scripts/esbuildDataPlugin.mjs" "$MR/scripts/"
  cp "$HERE/mesher-build-scripts/buildSharedConfig.mjs" "$MR/src/lib/"
  echo "[fork] rebuilding mesher worker with WASM-readiness gate"
  ( cd "$MR" && node scripts/buildMesherWorker.mjs )
fi

echo "[fork] building (rsbuild)"
pnpm build

echo "[fork] installing built client into $CLIENT_DIR/dist"
rm -rf "$CLIENT_DIR/dist"
cp -r dist "$CLIENT_DIR/dist"

# Re-apply the MuchuCraft pointer-lock + stale-SW-purge guard.
node "$CLIENT_DIR/../scripts/patch-client-dist.mjs" "$CLIENT_DIR/dist"
echo "[fork] done — client/dist now serves the fork with drag-to-move"
