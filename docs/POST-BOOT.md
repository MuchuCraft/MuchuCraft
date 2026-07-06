# POST-BOOT checklist — economy plugins (SPEC-TOKEN.md)

For the integrator, after the next Paper restart. Everything below was staged
WITHOUT booting the server, so plugin-generated config merges must be verified.
All paths are relative to the repo root (`/home/ubuntu/cookieclickersol`).

## What was staged

| Jar (server/plugins/) | Version | api-version | Source (pinned in server/setup.sh) |
|---|---|---|---|
| `CMILib1.5.9.6.jar` | 1.5.9.6 | 1.13 | Zrips GitHub releases (hard dep of Jobs 5.x) |
| `Jobs5.2.6.3.jar` | 5.2.6.3 | 1.13 | Zrips GitHub releases (Spigot resource 4216) |
| `EconomyShopGUI-7.1.1.jar` | 7.1.1 | 1.13 | Spiget resource 69927 (serves latest; warn-if-newer in setup.sh) |
| `GriefPrevention-16.18.7.jar` | 16.18.7 | 1.21.10 | Modrinth `dGfCZHqk` (tagged 1.21.10/1.21.11) |
| `UltraCosmetics-3.15.0.1-RELEASE.jar` | 3.15.0.1 | 1.17 | Modrinth `NliHJ5Uo` (tagged 1.21.11) — OPTIONAL |

All five verified: HTTP 200, plausible size, `unzip -l` shows `plugin.yml`,
sha512 recorded in `server/setup.sh` (fresh clones re-fetch identical bytes,
except EconomyShopGUI which Spiget only serves as "latest" — setup.sh warns if
upstream moved past 7.1.1).

Pre-seeded configs (all under `server/plugins/`, which is gitignored —
`server/setup.sh` recreates every seed for fresh clones):

- `Essentials/config.yml` — existing generated file, ONLY these keys edited:
  `currency-symbol: 'MUCHU '`, `min-money: 0` (was -10000), `starting-balance: 0`
  (already 0). Kits untouched (none configured).
- `Essentials/worth.yml` — replaced with an empty map (`worth: {}`): /sell,
  /sellall and sell signs are dead (no uncapped faucet).
- `Jobs/generalConfig.yml` — PARTIAL seed: daily money cap + exploit
  protections (key paths from Jobs v5.2.6.3 `GeneralConfigManager.java`).
  Jobs merges it with defaults and rewrites the file on first enable.
- `UltraCosmetics/config.yml` — full bundled default with exactly one change:
  `TreasureChests.Loots.Money.Enabled: false` (default treasure chests pay out
  15–100 Vault money per chest = mint-from-nothing faucet).

## RCON helper

RCON listens on 127.0.0.1:${RCON_PORT} (root `.env`). Reuse the gateway's
`rcon-client` dep (never echo RCON_PASSWORD):

```bash
mcrcon() {
  (cd /home/ubuntu/cookieclickersol/gateway && node --input-type=module -e '
process.loadEnvFile("../.env");
const { Rcon } = await import("rcon-client");
const r = await Rcon.connect({ host: "127.0.0.1", port: Number(process.env.RCON_PORT ?? 25575), password: process.env.RCON_PASSWORD });
const out = await r.send(process.argv.slice(1).join(" "));
console.log(out.replace(/§./g, ""));
await r.end();
' "$@")
}
```

(Tested against the running server before the restart: `mcrcon plugins` answered.)

## 1. Plugins loaded

```bash
mcrcon plugins
```

Expect **12** plugins, none red/disabled: Chunky, CMILib, EconomyShopGUI,
Essentials, GriefPrevention, Jobs, LuckPerms, MuchuBridge, UltraCosmetics,
Vault, ViaVersion, WorldEdit. (MuchuBridge is staged by the bridge agent; if
its jar is absent when you restart, expect 11.)

Also sweep the boot log:

```bash
grep -iE 'cmilib|jobs|economyshopgui|griefprevention|ultracosmetics' server/logs/latest.log | grep -viE 'loading|enabling' | head -50
```

- Jobs must report hooking into Vault/Essentials for payments (a line naming
  Vault or Essentials as the economy). If Jobs disables itself complaining
  about CMILib, the CMILib jar/version is the first suspect.
- If **UltraCosmetics** errors on this Paper 1.21.11 build: it is optional —
  `rm server/plugins/UltraCosmetics-3.15.0.1-RELEASE.jar` (and its folder),
  restart. Nothing depends on it.

## 2. EssentialsX economy values

```bash
grep -E '^(currency-symbol|currency-symbol-suffix|min-money|starting-balance):' server/plugins/Essentials/config.yml
head -12 server/plugins/Essentials/worth.yml   # must still end in: worth: {}
```

Expected: `currency-symbol: 'MUCHU '` · `min-money: 0` · `starting-balance: 0`
· `worth: {}`.

**KNOWN CAVEAT — currency symbol display:** EssentialsX 2.22.0
(`Settings#_getCurrencySymbol`) rejects any symbol longer than ONE character
and silently falls back to `$`, so `/balance` will DISPLAY `$123` even though
the config carries the spec'd `'MUCHU '`. Balance math, Vault, the bridge and
withdrawals are unaffected (cosmetic only). Options if the owner cares: accept
`$`, or pick a single-char symbol (e.g. `Ⓜ`), or patch locale strings. Do not
"fix" it by reverting the config value — SPEC-TOKEN.md pins it.

In-game spot checks: `/sell hand` while holding cobblestone → "…cannot be
sold"; `/balance` shows 0 for a fresh player.

## 3. Jobs Reborn — daily money cap + exploit protections

Jobs rewrites `generalConfig.yml` on first enable (merging our seed with all
defaults + its own comments). Verify the seeded values SURVIVED the merge:

```bash
grep -n -A14 '^  Limit:' server/plugins/Jobs/generalConfig.yml | grep -E 'Use:|MoneyLimit:|TimeLimit:|ResetTime:' | head -8
grep -n -A20 'PlaceAndBreak:' server/plugins/Jobs/generalConfig.yml | grep -E 'Enabled:|NewMethod:|SilkTouchProtection:|KeepDataFor:' | head -8
```

Must show (under `Economy.Limit.Money` and
`ExploitProtections.General.PlaceAndBreak` respectively):

- `Use: true`
- `MoneyLimit: '100'` (or `100` — flat 100 MUCHU cap, THE emission budget:
  max daily new liability = 100 × active players)
- `TimeLimit: 86400` · `ResetTime: ''`
- `Enabled: true` · `NewMethod: true` · `SilkTouchProtection: true`

If Jobs regenerated the file from scratch instead (seed ignored/renamed —
look for `generalConfig.yml.old` or a `backup` folder), re-apply those keys
and `mcrcon jobs reload`.

RCON smoke:

```bash
mcrcon jobs info Miner break   # payout table for the Miner job → proves Jobs + job files loaded
mcrcon jobs reload             # must answer without errors
```

(`jobs limit` / `jobs browse` are player-only — in-game: `/jobs join Miner`,
break a few stone, `/jobs limit` must show money capped at 100.)

## 4. eco give/take smoke (Vault ⇄ Essentials round trip)

Needs a player who has joined at least once (any name in
`server/plugins/Essentials/userdata/`, or run the e2e first and use
`E2ETester`):

```bash
mcrcon eco give <player> 5
mcrcon balance <player>        # previous + 5
mcrcon eco take <player> 5
mcrcon balance <player>        # back to previous
mcrcon eco take <player> 999999   # MUST fail (min-money: 0 → no overdrafts)
```

The last command must be refused (insufficient funds) — with real tokens
backing balances, negative balances would be unbacked liability.

## 5. EconomyShopGUI — sell prices ≪ buy prices

Shop/section files generate on first boot under
`server/plugins/EconomyShopGUI/` (from the jar's `121-shops/` templates for
this MC version). Spot-check that every sell price stays well under buy
(defaults are sell = 25% of buy):

```bash
grep -rn -A1 'buy:' server/plugins/EconomyShopGUI/ --include='*.yml' | head -30
```

Reference defaults (Ores): DIAMOND buy 52.5 / sell 13.13 · ANCIENT_DEBRIS buy
529 / sell 132.25 · COAL buy 5.25 / sell 1.32. In-game: `/shop` opens the GUI;
buying must debit, selling credit at those prices.

**Economy note for the owner:** ESG selling is a second faucet NOT covered by
the Jobs 100/day cap (players can farm items and `/sellall`). SPEC-TOKEN.md
accepts the default shops; the solvency monitor is the backstop. If emission
must stay strictly ≤ 100/day/player, lower ESG sell prices to `-1` (disable)
per item/section — decide consciously.

## 6. GriefPrevention — no hidden faucet/sink

`plugins/GriefPreventionData/config.yml` generates on first boot (GP's data
folder is `GriefPreventionData`, not `GriefPrevention` — verified on the
2026-07-06 integration boot). The economy integration must stay INERT (both
default 0):

```bash
grep -E 'ClaimBlocksPurchaseCost|ClaimBlocksSellValue' server/plugins/GriefPreventionData/config.yml
```

`ClaimBlocksSellValue` > 0 would let players mint MUCHU by selling claim
blocks — must be 0. In-game: place a chest → GP claim messages appear.

## 7. UltraCosmetics — money loot stays off

UC rewrites/extends its config on boot; verify the seed survived:

```bash
grep -n -A3 '  Loots:' server/plugins/UltraCosmetics/config.yml | head -6
```

`Loots.Money.Enabled` must be `false`. Treasure keys cost money to BUY (sink —
fine); chests must never PAY money. Also confirm `Economy: 'Vault'` untouched.

## 8. After everything passes

- `mcrcon plugins` all green, eco smoke clean → hand off to the bridge/e2e
  agents (`e2e/run-token-e2e.js` step 2 uses `eco give E2ETester 50`).
- Re-running `bash server/setup.sh` stays idempotent: it skips existing jars,
  re-pins the three Essentials keys, rewrites the empty `worth.yml`, and never
  clobbers the (now merged) `Jobs/generalConfig.yml` or
  `UltraCosmetics/config.yml`.
