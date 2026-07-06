# MuchuCraft Spawn Plaza — "The Amethyst Compass"

Built by `scripts/build-spawn.mjs` (SPEC-PHASE4 §1). Fully scripted, idempotent,
vanilla-console-commands-only — a fresh world can be rebuilt with one command
against a running server:

```
node scripts/build-spawn.mjs         # build / repair (safe to re-run)
node scripts/build-spawn.mjs --dry   # print per-phase command counts only
```

Requires: running Paper server with RCON (root `.env` creds), `rcon-client`
from `gateway/node_modules`. Optional: `prismarine-nbt` from `e2e/node_modules`
for the level.dat spawn probe.

## Site & design

World seed `-2350879005487267529`: a snowy-mountain cherry-grove village.
The plaza is a circular-feel disc (r≈20) centered on block **(0, 116, 0)**
— players walk at y=117 — terraced *into* the mountain that rises to ~y130
on the north/west, and standing on a quartz-brick plinth over the ravine
that opens to the east. The generated village stays as scenery:

- the village's own **oak ravine bridge** (x≈21–27, z≈0) is threaded through
  the east balcony untouched;
- the south grand stair lands exactly on the village dirt path grade (~y110);
- terracing stops at r≈24.5; the cherry grove beyond is untouched.

### Palette (Muchu: #9945FF purple / #14F195 green)

purpur (block/pillar/stairs/slab) · quartz (block/smooth/bricks) ·
amethyst_block + amethyst_cluster · crying_obsidian (sparingly, glows) ·
cherry (stripped log/wood, fence, signs) · verdant_froglight · lanterns ·
hidden `light[level=15]` blocks.

### Layer map

| y | what |
|---|---|
| 100–115 | stone foundation slab (seals the caves under the plaza; ravine-facing outer ring y110–115 is a quartz-brick plinth) |
| 116 | plaza floor (walk level 117) |
| 117 | dais tier + stair skirt, perimeter wall body, hidden light grid |
| 118 | **world spawn (0,118,0)** — feet on the crying-obsidian dais center |
| 117–123 | gates, pillars, lanterns, froglights |
| 117–134 | cleared air above the plaza disc |

### Floor (y=116)

- inner **quartz field** with hash-scattered amethyst inlays,
- **purpur ring** at r≈10 with amethyst gems,
- 4 **stripped-cherry diagonal rays** (r 7–15),
- **purpur promenade** (r 15.5–18.5) with glowing crying-obsidian dots,
- **smooth-quartz rim walk** (r 18.5–20.5),
- 3-wide **cross paths** to the gates: purpur_pillar centre line laid along
  the path axis, purpur flanks, crying-obsidian glow dots every 6 blocks.

### Dais (y=117, d ≤ 5.5)

9×9 tier: crying-obsidian **spawn block** at (0,117,0), amethyst centre
cross (`|x|+|z|==1`), purpur diamond ◇ outline (`|x|+|z|==3`) on quartz,
amethyst corner gems at (±3,±3) crowned with amethyst clusters. The tier is
ringed by outward purpur stairs so players/bots walk up without jumping.
Spawn column verified every run: solid @117, air @118, air @119.

### Perimeter & gates

Low wall (quartz_bricks + purpur_slab cap) on the r≈20 ring with 8 lantern
pillars, open at N/E/S/W (7-wide). Each gate is a **torii**: purpur_pillar
posts (±4), stripped-cherry nuki (y120) and kasagi (y122), verdant-froglight
crown, amethyst-cluster caps, and a waxed glowing cherry **hanging sign**
(front: gate name/direction, back: "MuchuCraft / Spawn Plaza / wallet = you").

### Path stubs

- **N / W** (uphill): quartz steps rising 116→119 into a carved landing
  (y119, purpur centre line) lit by lanterns and a froglight set into the
  cut face — "stairs to the overlook".
- **S** (downhill): grand stair descending 115→110 to the village path,
  cherry-fence lantern posts at the foot.
- **E** (ravine): quartz balcony (walk y116) on quartz-brick piers with
  cherry-fence railing, merging into the village's oak bridge.

### Info: 4 grand pillars + text displays

Diagonal pillars at (±12,±12): purpur base/cap, stripped-cherry shaft,
verdant-froglight crown + amethyst cluster, each carrying a cherry wall sign
facing the dais: **JOBS** (`/jobs join`), **MUCHU** (`/deposit`,
`/withdraw`), **HOMES** (`/sethome`, `/spawn`), **LAND** (golden shovel).

Six `text_display` entities, all `Tags:["muchu_spawn"]`, `billboard:center`,
translucent deep-purple background:

| pos | text |
|---|---|
| (0.5, 121.9, 0.5) | **⬡ Welcome to MuchuCraft ⬡** / *Your wallet is your identity* (scale 2.3) |
| (0.5, 120.6, 0.5) | connect wallet · play · earn — withdraw MUCHU on the MuchuCraft website |
| (0.5, 119.8, −7.5) | ❖ `/jobs join` — earn MUCHU while you play |
| (9.5, 119.8, 0.5) | ❖ `/deposit` tops you up in-game · `/withdraw` on the website |
| (0.5, 119.8, 8.5) | ❖ `/sethome` saves your base · `/spawn` brings you back |
| (−8.5, 119.8, 0.5) | ❖ claim land with a golden shovel — the wilderness is yours |

**Idempotency:** every re-run first `minecraft:kill @e[type=text_display,
tag=muchu_spawn]`, then re-summons. Proven: run 1 `before=0 → after=6`;
run 2 `before=6, killed=6 → after=6` (no duplicates). Counting uses
`execute store result score … if entity @e[tag=muchu_spawn]`.

### Lighting / mob-spawn audit

- Hidden `minecraft:light[level=15]` grid every **5 blocks** at feet level
  (y117; y118 over the dais; never at the spawn block itself): worst-case
  taxicab distance to a source is 5 → **min floor light 10 ≥ 9**, so no
  mob-spawnable dark spots on the plaza. 44 grid lights + 1 per gateway.
- Layered visible light: 8 wall lanterns, 4 gate froglights + torii cluster
  caps, 4 pillar froglights, crying-obsidian floor dots (light 10), stub
  lanterns/froglights, amethyst clusters (sparkle, light 5).
- Light blocks are invisible and have no collision; the fill-clear pass
  wipes and re-places them deterministically on each run.

## Spawn administration

- `setworldspawn 0 118 0` (in minecraft:overworld) →
  `Set the world spawn point to 0, 118, 0 [0.0, 0.0] in minecraft:overworld`;
  persisted in `world/level.dat` as
  `Data.spawn = {pos:[0,118,0], yaw:0, pitch:0, dimension:"minecraft:overworld"}`
  (verified by the script via prismarine-nbt after `save-all`).
- `gamerule respawn_radius 0` → everyone appears exactly on the dais.
- Essentials: the script writes `server/plugins/Essentials/spawn.yml`
  (`spawns.default` + `spawns.all` at 0.5/118.0/0.5, world `world`) and runs
  `essentials reload`. **Note:** the EssentialsX **Spawn addon jar is not
  installed** (only EssentialsX core), so `/spawn` & `/setspawn` do not exist
  yet; the file is in the exact format EssentialsXSpawn reads, so it takes
  effect as soon as the addon is added (experience/integrator step).

## 1.21.11 quirks (hard-won; keep in mind when extending)

- **Game rules were renamed** (registry style): `spawnRadius` →
  `respawn_radius`, `keepInventory` → `keep_inventory`, … Old names are
  "Incorrect argument" errors.
- **`/kill` is overridden by Essentials** (expects a player name): always use
  `minecraft:kill` for selectors, at the dispatcher root.
- **`setworldspawn <x> <y> <z>`** — the old trailing float angle argument is
  rejected; 3-coordinate form works (angle defaults `[0.0, 0.0]`).
- **Sign/text_display text is native SNBT components**, not JSON strings:
  `text:{text:"…",color:"#9945FF",bold:1b,extra:[…]}`.
- **Commands fail in unloaded chunks** ("That position is not loaded"): the
  script `forceload add -48 -48 47 47` at start and removes it at the end.
- Signs are re-placed as `air` → sign so text edits apply on re-run
  (`setblock` onto an identical block state would not update NBT).

## Extending

All geometry is generated in `scripts/build-spawn.mjs` from small pure
functions (`floorBlock`, `daisBlocks`, `phase*`). To change the design,
edit the functions and re-run; deterministic hashes (`hash(x,z,m)`) keep
decorative scatter stable between runs. Add new floating text by appending
to `phaseDisplays()` and bumping `EXPECTED_DISPLAYS`. Keep everything inside
r≈24.5 — beyond that is protected scenery (cherry grove + village).

## Verification (last run)

```
PASS spawn block solid (crying_obsidian @ 0,117,0)
PASS spawn feet air (0,118,0) · PASS spawn head air (0,119,0)
PASS floor under dais (0,116,0)
PASS light grid samples (5,118,0) (10,117,5) (-10,117,-10) (0,117,-20)
PASS level.dat spawn probe {"pos":[0,118,0],…}
muchu_spawn text_displays: 6/6 · hard errors: 0 · 1704 commands ≈ 2s
```
