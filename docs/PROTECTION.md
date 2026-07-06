# MuchuCraft protection (SPEC-PHASE4.md §2)

Three layers keep spawn pristine while the wilderness stays claimable:

| Layer | Mechanism | Scope |
|---|---|---|
| Spawn plaza | WorldGuard region `spawn` | cuboid (-32, 80, -32) → (32, 200, 32) in `world`, priority 10 |
| Wilderness | GriefPrevention claims (golden shovel) | everywhere else; players protect their own builds |
| World bounds | vanilla worldborder | center 0 0, 6000 wide (radius 3000, matches Chunky pregen) |

Vanilla `spawn-protection` stays **0** in `server.properties` — WorldGuard is the
spawn mechanism. Vanilla spawn protection is op-only and would silently block
depositor builds near the plaza edges.

## Versions (verified pairing)

- **WorldGuard 7.0.16** (`worldguard-bukkit-7.0.16.jar`, Modrinth project
  `DKY9btbd`, version `EZl3moba`, sha512-pinned). Its `plugin.yml` declares
  `api-version: "1.21.11"` and `depend: [WorldEdit]` — built exactly for this
  Paper 1.21.11 (7.0.16 changelog: "Update to 1.21.11"; 7.0.17 targets MC 26.1+).
- **WorldEdit 7.4.4** (already installed) is a hard dependency; WorldGuard even
  loads `regions.yml` through WorldEdit's `com.sk89q.util.yaml.YAMLProcessor`.

Install for fresh clones: `server/setup.d/worldguard.sh` (idempotent, sha512 +
plugin.yml verified, mirrors `server/setup.sh` conventions). The jar only
loads on a server (re)start.

## Applying protection: `scripts/protect-spawn.sh`

Run order (WorldGuard must be loaded, i.e. after the restart):

```
server/setup.d/worldguard.sh          # install jar (once)
./stop-all.sh && ./start-all.sh       # integrator: loads WorldGuard
scripts/protect-spawn.sh              # all live steps below
```

The script is idempotent and does, in order:

1. **Assert** `spawn-protection=0` in `server.properties` (hard fail otherwise).
2. **GriefPrevention** (`server/plugins/GriefPreventionData/config.yml`):
   raises `Claims.InitialBlocks` to ≥ 200 and
   `Claims.Claim Blocks Accrued Per Hour.Default` to ≥ 120 (GP 16.18.7 key
   names — the old "BlocksAccruedPerHour" name is this nested key now). Edits
   are refused if they would touch more than those two lines; a
   `config.yml.pre-protect-spawn` backup is kept. Reload command is
   **`gpreload`** (verified from GP's plugin.yml — there is *no*
   `griefprevention reload`); it replies nothing over RCON but logs
   `Configuration updated.` to `server/logs/latest.log`. A restart also
   applies it. Note: `InitialBlocks` applies when a player's data is first
   created; existing players keep their stored totals (accrual applies to
   everyone hourly, capped by `Max Accrued Claim Blocks`).
3. **Worldborder**: `worldborder center 0 0` + `worldborder set 6000`,
   verified via `worldborder get` (vanilla commands reply synchronously over
   RCON).
4. **WorldGuard spawn region**: writes
   `server/plugins/WorldGuard/worlds/world/regions.yml`, then
   `rg reload -w world`, then proves the load (see below).

If run before the restart, steps 1–3 still apply and the script fails loudly
at step 4 telling you to restart — re-run it afterwards.

### regions.yml write safety

`regions.yml` exists only after WorldGuard's first boot. The script:

- **fresh-creates** the file when it is missing, empty, or contains only the
  auto-generated header + an empty `regions:` / `regions: {}` map;
- **overwrites** it when the only regions present are `spawn` (ours) and/or
  `__global__` — this makes re-runs converge even after WorldGuard rewrites
  the file in its own canonical format (comments stripped, keys reordered);
- **fails loudly without touching the file** if any other region exists —
  merge by hand or via in-game `/rg` commands instead. A
  `regions.yml.pre-protect-spawn` backup is written before any overwrite.

### Verification (async-RCON-proof)

WorldGuard commands (`rg reload`, `rg info`, `rg list`, …) reply
asynchronously (`AsyncCommandBuilder`), so their RCON replies are usually
empty — same class of quirk as LuckPerms/SkinsRestorer. The script therefore
proves the region loaded *deterministically*:

1. `rg reload -w world` — WorldGuard re-reads regions.yml into memory.
2. `rg save -w world` — WorldGuard rewrites regions.yml **from memory**.
3. The script polls for the rewrite (sha change) and asserts the rewritten
   file still contains region `spawn` and **all 12 flags**. Unknown flag
   names would have been dropped on load, so this doubles as a flag-name
   check against the running WorldGuard build. Parse failures reset the
   region set and fail the check.

`rg info -w world spawn` is still attempted (3 tries) and printed when the
reply wins the async race; in-game `/rg info spawn` always works (ops).

## Region schema (verified against worldguard-bukkit-7.0.16.jar)

Schema read by `YamlRegionFile.loadAll()` — this exact document was round-
tripped through WorldGuard's own loader/saver classes as a pre-ship test:

```yaml
regions:
    spawn:
        type: cuboid                            # cuboid | poly2d | global
        min: {x: -32.0, y: 80.0, z: -32.0}      # cuboid corners, x/y/z doubles
        max: {x: 32.0, y: 200.0, z: 32.0}
        priority: 10                            # higher wins on overlap
        flags:                                  # flag-name: value map
            passthrough: deny
            pvp: deny
            mob-spawning: deny
            creeper-explosion: deny
            tnt: deny
            fire-spread: deny
            lava-fire: deny
            enderman-grief: deny
            entry: allow
            exit: allow
            greeting-title: '&5MuchuCraft Spawn'
            greeting: '&5Welcome to MuchuCraft Spawn. &7Builds here are protected - claim your own land in the wild with a golden shovel.'
        owners: {}                              # domains: players / unique-ids / groups
        members: {}
# poly2d uses: min-y, max-y, points: [{x: .., z: ..}, ...]
# optional: parent: <region-id>
```

Flag semantics (names extracted from this jar's `Flags` class):

| Flag | Value | Effect |
|---|---|---|
| `passthrough` | deny | region is protective: non-members cannot build/break (ops bypass naturally; members list is empty) |
| `pvp` | deny | no player-vs-player damage |
| `mob-spawning` | deny | no natural mob spawns inside the plaza |
| `creeper-explosion` | deny | creepers cannot damage blocks |
| `tnt` | deny | TNT cannot ignite/explode |
| `fire-spread` | deny | fire does not spread |
| `lava-fire` | deny | lava does not start fires |
| `enderman-grief` | deny | endermen cannot pick up/place blocks (the "mob-griefing" flag for endermen) |
| `entry` / `exit` | allow | everyone may walk in/out (defaults, pinned explicitly per spec) |
| `greeting-title` | string | title shown on entry; `&`-color codes supported (WG `replaceColorMacros`) |
| `greeting` | string | chat message on entry, Muchu purple (`&5`) |

`StateFlag` values marshal as the strings `allow` / `deny`. WorldGuard's
canonical save may rewrite doubles as ints and reflow the YAML — both forms
load identically.

## Extending

- **New protected area**: preferred — in-game as an op:
  `//pos1`, `//pos2`, `/rg define <id>`, `/rg flag <id> <flag> <value>`,
  `/rg setpriority <id> <n>`. WorldGuard saves the file itself. protect-spawn.sh
  will then refuse to touch regions.yml (foreign region present) — that is by
  design; adjust the spawn region with `/rg` commands from then on, or fold
  the new region into the script's heredoc and delete the extras.
- **More flags**: add to the `flags:` map in the script's heredoc — names must
  exist in this WG build (`/rg flags spawn` in-game lists them; the round-trip
  check fails loudly on typos). Useful extras: `deny-message` (custom denial
  text), `interact`, `chest-access`, `item-pickup`.
- **Bigger plaza**: bump `min`/`max` in the heredoc (keep y 80→200 headroom).
- **Other worlds**: regions live per world under
  `plugins/WorldGuard/worlds/<level-name>/regions.yml`; the script reads
  `level-name` from server.properties.

## GriefPrevention wilderness settings

`server/plugins/GriefPreventionData/config.yml` (GP 16.18.7):

```yaml
GriefPrevention:
  Claims:
    InitialBlocks: 200                  # first claim ~14x14 usable immediately
    Claim Blocks Accrued Per Hour:
      Default: 120                      # a first house is claimable within the hour
```

Claims are enabled in `world` (Survival mode), disabled in nether/end.
Golden shovel modifies claims, stick inspects. Spawn overlap is not an issue:
GP won't let players claim where they can't build, and the WorldGuard region
denies building for non-members anyway.

## Quick verification cheat-sheet

```
scripts/protect-spawn.sh                       # full run, prints PASS/FAIL per step
node scripts/rcon-cmd.mjs 'worldborder get'    # "... currently 6000 block(s) wide"
/rg info spawn                                 # in-game (op): flags + priority
grep -A2 'spawn:' server/plugins/WorldGuard/worlds/world/regions.yml
```

Empirical grief-proofing (non-op bot digs/places inside vs outside the
region) is the integrator's SPEC-PHASE4.md §5 step 2.
