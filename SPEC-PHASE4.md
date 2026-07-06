# MuchuCraft Phase 4 — spawn build, protection, player experience

Extends SPEC.md / SPEC-TOKEN.md / SPEC-PHASE3.md (conventions apply). Goal: a beautiful,
grief-proof Muchu spawn plaza; players then head into the wild, claim land, set homes,
join jobs, and play. Everything must be scripted/idempotent (committed under scripts/),
never hand-placed, so a fresh world can be rebuilt.

World facts: seed -2350879005487267529, world spawn ≈ (0, 118, 0) — snowy mountain
cherry-grove village at spawn (e2e bot spawned at -3.5, 118, 1.5). Cherry + snow +
purpur/amethyst = the Muchu palette (#9945FF purple / #14F195 green accents →
purpur, amethyst, crying obsidian sparingly, cherry wood, quartz, verdant froglights/
emerald accents, lanterns).

## 1. Spawn plaza  [builder agent: scripts/build-spawn.mjs + docs/SPAWN.md]

scripts/build-spawn.mjs (rcon-client from gateway/, .env creds, idempotent — safe to
re-run): builds via vanilla console commands only (/fill /setblock /summon /data /kill,
no player context needed). Design requirements (agent has creative freedom within them):
- Circular-feel plaza ~radius 20 centered (0, ~117, 0): terraform gently (foundation
  fill below, clear air above to +12) but do NOT flatten beyond radius ~24 — the cherry
  grove and village around it are the scenery, keep them.
- Floor: quartz/purpur pattern with amethyst inlays; a центральный spawn dais with a
  Muchu "M" or diamond motif; lantern + amethyst-cluster lighting everywhere (light
  level ≥ 9 across the plaza, no mob-spawnable dark spots — verify with a fill-light
  pass); low perimeter wall/hedge with 4 open gateways (N/E/S/W) and path stubs leading
  out.
- Info: floating text_displays (summon with billboard center, styled text, Muchu purple)
  — "Welcome to MuchuCraft", "Your wallet is your identity", "/jobs join — earn MUCHU",
  "/deposit — top up in-game", "/sethome & /spawn", website hint. Re-runs must not
  duplicate: tag them (Tags:["muchu_spawn"]) and /kill @e[tag=muchu_spawn] first.
  A couple of oak_hanging_sign/sign boards with the same via /setblock + data.
- /setworldspawn at the dais (verify the exact block is safe: air above, solid below);
  set gamerule spawnRadius 0 so everyone appears on the dais.
- Essentials spawn: set via console if supported, else write plugins/Essentials/spawn.yml
  and `essentials reload` — verify /spawn teleports there (integrator proves with a bot).
- docs/SPAWN.md: the design, the palette, how to re-run/extend the script.

## 2. Protection  [protection agent: WorldGuard + scripts/protect-spawn.sh + config]

- Install WorldGuard (Modrinth/EngineHub, version for Paper 1.21.11; depends on the
  installed WorldEdit 7.4.4) into server/plugins/ + add to server/setup.sh. Loads on the
  integrator's restart.
- Spawn region WITHOUT player context: write the region into the world's WorldGuard
  regions.yml (cuboid min/max covering the plaza + a margin, e.g. ±32 horizontal, y 80→
  200) then `rg reload` via RCON. Flags: passthrough deny (non-members can't build/break),
  pvp deny, mob-spawning deny, creeper-explosion deny, tnt deny, fire-spread deny,
  lava-fire deny, enderman-grief deny (mob-griefing flag), greeting-title "MuchuCraft
  Spawn" (or greeting message in Muchu purple), exit/entry allow. Members: none (ops
  bypass naturally). VERIFY the exact 1.21.x flag names against the shipped WorldGuard
  defaults before writing the YAML; malformed regions.yml must not brick the plugin —
  validate by rg info after reload.
- Wilderness stays claimable via GriefPrevention (players protect their own builds);
  confirm GP initial claim blocks > 0 and accrual rate sane (players can claim a first
  house within their first hour) — set GriefPrevention config: InitialBlocks ≥ 200,
  BlocksAccruedPerHour ≥ 120, and document.
- Keep server.properties spawn-protection=0 (WorldGuard is the mechanism; vanilla
  spawn-protection would silently block depositor builds near spawn edges).
- World bounds: /worldborder center 0 0 + /worldborder set 6000 (3000 radius), matching
  pregen (section 4).

## 3. Player experience  [experience agent: LuckPerms perms + Essentials config + docs/PLAYER-GUIDE.md]

Via RCON lp commands (idempotent script scripts/perms-bootstrap.sh, mirroring
scripts/lp-bootstrap.sh style) + Essentials file edits (+ essentials reload):
- default group: essentials.spawn, sethome, home, sethome.multiple.default (2 homes),
  tpa/tpaccept/tpdeny, balance, balancetop, pay, msg/r, mail, afk, help, motd, rules,
  kits.starter, warp, delhome, ignore; griefprevention claim basics (GP grants by
  default — verify).
- depositor group additionally: essentials.sethome.multiple.depositor (5 homes),
  warp extras if any. (Jobs perms already handled by Phase 3 gate.)
- Essentials config: set sethome-multiple: {default: 2, depositor: 5}; teleport
  cooldown/delay modest (3s warmup, 30s cooldown); respawn-listener-priority high +
  respawn-at-home false (respawn at spawn unless bed).
- Starter kit (kits.yml): stone tools, 16 bread, torches, 1 cherry sapling, and a
  written_book "Welcome to MuchuCraft" (concise in-book guide: wallet identity, earn
  MUCHU via /jobs, /deposit to unlock all jobs, /withdraw on the website, /sethome,
  claiming land with a golden shovel, /spawn). Kit delay: once (delay -1? verify
  Essentials once-only kit syntax) — book content must be valid SNBT; test the kit give.
- motd.txt / rules.txt: Muchu-branded, mention website URL and core commands.
- docs/PLAYER-GUIDE.md: the full player-facing guide (also usable as website FAQ source).

## 4. Pregeneration  [experience agent, background]

Chunky via RCON: chunky radius 3000 (blocks), chunky start — DO NOT wait for completion
(it continues/resumes on its own across restarts); record progress command in docs.
Verify it started (log line) and note expected disk (~2-6 GB) in the report.

## 5. Integration & proof  [integrator]

1. Order: builder script runs against the RUNNING server first (no restart needed for
   vanilla commands); then restart (./stop-all.sh && ./start-all.sh) to load WorldGuard;
   then protection + perms scripts; then re-run build-spawn.mjs once to confirm
   idempotency (no duplicate text_displays: count @e[tag=muchu_spawn] unchanged).
2. Empirical protection proof with a NON-op wallet-bound bot (reuse e2e harness patterns;
   fresh username e.g. GriefTester): join → verify it spawned ON the dais (position
   within 3 blocks of world spawn) → attempt to dig a plaza floor block (mineflayer
   bot.dig) → assert the block is UNCHANGED (bot.blockAt after; plus RCON execute if
   block check) → attempt to place a block → unchanged → walk outside the region (bot
   pathfind or teleport via RCON to a wilderness coord) → dig/place SUCCEEDS there.
3. /spawn, /sethome + /home round-trip, /kit starter (book received), /rules, /motd all
   as the non-op bot (assert via chat replies + position checks).
4. Region flags: pvp/mob-spawn/creeper flags present in rg info output; no mobs inside
   plaza after 2 min observation (execute count @e[type=zombie,distance..40] style).
5. Full regression: run-e2e.js + run-token-e2e.js + run-deposit-e2e.js all green (spawn
   changes must not break spawn-event timing; if the bot spawns on the dais slightly
   elevated, adjust nothing unless a case fails).
6. Chunky pregen started + progressing; worldborder set.
7. Leave stack RUNNING; report per-check PASS/FAIL with evidence (coordinates, command
   outputs, counts).
