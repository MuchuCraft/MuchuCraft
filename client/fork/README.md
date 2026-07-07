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
