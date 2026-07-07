# MuchuCraft client fork — inventory drag-to-move

The upstream browser client (`zardoy/minecraft-web-client` + its `minecraft-inventory`
package) uses **vanilla Minecraft** item handling: left-click a slot to lift the stack
onto the cursor, left-click a destination to drop it. A press-and-hold **drag** across
slots fires no `click` (press and release land on different elements), so it does
nothing — and web players, who expect drag-and-drop, read the inventory as broken.

We can't fix this by injecting DOM events from outside: the client only honors real,
trusted events on slots. So we fork the client and add the behavior inside its own React
handlers, where a real user's mousedown/mouseup already flow through the trusted path.

## The change

`Slot.patched.tsx` is `minecraft-inventory/src/components/Slot/Slot.tsx` with an
**empty-hand drag-to-move** addition (search `MuchuCraft` in the file):

- `handleMouseDown`: when the hand is empty and there's an item under the cursor, arm a
  drag by recording the source slot (module-level, shared across slot instances).
- `handleMouseUp`: on the destination slot, if a drag was armed, the button is left, the
  hand is still empty, and the pointer actually moved, fire the client's own two clicks —
  lift from source, drop on destination — then clear the armed state.

It reuses `sendAction({type:'click', ...})`, the exact path a real click-pick/click-place
uses, so it's as reliable as clicking. Vanilla behavior is untouched: same-slot clicks,
right-click split, shift-click quick-move, and held-item distribute-drag all still work.

## Rebuilding (see build-fork.sh)

`build-fork.sh` clones the pinned upstream commit, overlays this patched file, builds with
rsbuild, and installs the result into `../dist`. The built `dist/` is gitignored (large);
this patch + script are the reproducible source of truth.

## Known-open: mesher WASM init race (stars / xray)

`mesherWasm.worker.patched.ts` is a clean fix for a real upstream bug: the
mesher worker instantiates its WASM asynchronously after the first `mesherData`
message (`initWasm()` awaits `wasm.default()`), but chunk/geometry messages that
drain during that await call the mesher before the instance exists →
`undefined.__wbindgen_malloc` → the column never meshes. On slower machines the
WASM always finishes after the first chunks, so those players get stars/xray
consistently while faster machines render fine.

The fix (search `MuchuCraft` in the file): buffer every non-`mesherData`
message until `allDataReady`, then replay in order.

**APPLIED.** `minecraft-renderer` ships `src`+`dist` but not its worker build
scripts, so we vendor them from github.com/zardoy/minecraft-renderer
(`mesher-build-scripts/`) — they externalize minecraft-data (avoiding a 259 MB
bundle) and handle the wasm import. `build-fork.sh` overlays the patched
worker source, runs `buildMesherWorker.mjs` to rebuild `dist/mesherWasm.js`,
and rsbuild copies it. The gate buffers only wasm-dependent terrain messages
(`chunk`/`dirty`/`blockUpdate`/`setRawMapChunk`) until `allDataReady`, so init
messages still flow. Verified: 5/5 concurrent loads rendered, 0 __wbindgen_malloc
errors, gate drained buffered chunks on every load (an earlier attempt that
buffered ALL non-mesherData messages stalled init — only terrain types are gated).
