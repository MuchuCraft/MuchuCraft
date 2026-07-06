# Skins (SPEC-PHASE3 §4) — SkinsRestorer + gateway skin support

Players pick a skin in the launcher (a Minecraft username to copy, or an https
PNG URL). The gateway stores it per user and applies it through SkinsRestorer's
console command over RCON on every join.

## Installed plugin

| | |
|---|---|
| Plugin | SkinsRestorer **15.12.4** |
| File | `server/plugins/SkinsRestorer.jar` |
| Source | `https://cdn.modrinth.com/data/TsLS8Py5/versions/jPoqTGpe/SkinsRestorer.jar` (Modrinth project `TsLS8Py5`, version `jPoqTGpe` — immutable CDN URL, pinned in `server/setup.sh`) |
| sha512 | `5db2d7dd96e8b0d30f2344383fe6459b0c128db691c242ada04a84e9ffb940de27c69add81223fa0550fc8dc36612469d32d46ffa56e5328a70edb343697cb68` |
| Compatibility | game versions 1.8–1.21.11 (matches our Paper 1.21.11); `plugin.yml` has `api-version: 1.13`, `folia-supported: true`, loads at `STARTUP` |

The jar only loads after a server restart — the **integrator** owns that
(SPEC-PHASE3 §5 step 2: 13 plugins after restart).

## How it works on an offline-mode server

Paper runs `online-mode=false` (wallet auth replaces Mojang auth), so player
game profiles have no skin textures. SkinsRestorer fixes that out of the box on
offline servers: it fetches skin property data (texture + signature) and
injects it into the player's game profile, refreshing the player so everyone
sees the skin. No config changes are required for offline mode.

Outbound internet **from the server host** is needed for skin lookups:

- `name:<mcname>` skins resolve through the Mojang API (name → UUID → textures).
- `url:<https .png>` skins are uploaded through the **MineSkin** API, which
  fetches the URL and returns signed texture data. That means URL skins must be
  **publicly reachable** (a localhost URL will not work) and are subject to
  MineSkin rate limits. No API key is required by default; if rate-limited, a
  key can be set in `server/plugins/SkinsRestorer/config.yml` (generated on
  first boot) under the MineSkin/API section.

Skins are cached by SkinsRestorer per player, so a skin applied once persists
across restarts on the server side too.

## Console command syntax (verified against the shipped 15.12.4 jar)

SkinsRestorer 15.x registers commands programmatically (no `commands:` block in
`plugin.yml`). Determined by decompiling
`net/skinsrestorer/shared/commands/SkinCommand.class` from the installed jar:

- Root command: `skin` (alias `skins` opens the GUI — not usable from console).
- Subcommand: `set|select <skinName> <selector>` — sets `<skinName>` for the
  target `<selector>` (a player name works; console must always pass it).
- The `<skinName>` argument parser also accepts **http/https URLs**
  (`ValidationUtil.validSkinUrl` → MineSkin upload), so one console form covers
  both of our stored formats.
- `skin url <url> [skinVariant]` exists but is **player-only** (its handler
  takes an `SRPlayer`), i.e. unusable from console — which is why the gateway
  uses `skin set`.
- `sr applyskin <selector>` re-applies a stored skin (useful for debugging).

The exact console command the gateway sends (built in
`gateway/src/rcon.js` → `buildSkinCommand`):

```
skin set <mcname-or-https-png-url> <player>
```

Examples:

```
skin set Notch E2ETester
skin set https://example.com/skin.png E2ETester
```

**Live verification (integrator — VERIFIED on the running stack, 2026-07-06):**

1. `rcon plugins` → SkinsRestorer 15.12.4 listed green (13 plugins). ✔
2. Via RCON with the player online: `skin set Notch E2ETester` works, BUT —
   like LuckPerms — SkinsRestorer executes RCON commands asynchronously and
   directs its output to the (already-answered) RCON sender, so **the RCON
   reply is empty and nothing appears in `latest.log`**. Acceptance is proven
   by its persisted storage instead: a successful set writes
   `plugins/SkinsRestorer/players/<offline-uuid>.player` (containing a
   `skinIdentifier`) and `skins/<id>.playerskin`. Console sender bypasses
   permission checks, so no LuckPerms nodes are needed. ✔
3. `scripts/skin-smoke.mjs` automates the full check: set a skin via
   `POST /api/auth/skin` for E2ETester, join with a bot, assert the gateway
   log line `[proxy] rcon skin apply: skin set ...` and the SkinsRestorer
   storage writes above. ✔
4. **Timing (found live):** the apply must not fire before the player finishes
   the configuration phase — an apply 2 s after the Login Start sniff missed
   (SkinsRestorer's `<selector>` could not resolve the player; nothing was
   persisted), while the same command ~3 s after spawn succeeded. The proxy
   therefore fires the apply **6 s** after the sniff (`skinDelayMs`), safely
   after the proven 4 s welcome tellraw.

## Gateway flow

- `users.skin TEXT NULL` — additive migration in `gateway/src/db.js`, guarded
  by a `PRAGMA table_info(users)` check (idempotent across reopens; upgrades
  pre-Phase3 databases in place).
- `POST /api/auth/skin` (session Bearer) with body
  `{"skin": "name:<mcname>" | "url:<https png url>" | null}`:
  - `name:` value must match `^[A-Za-z0-9_]{3,16}$`.
  - `url:` value must be https, end in `.png`, contain only printable ASCII
    (values are interpolated into a space-delimited console command), and the
    whole descriptor is capped at 300 characters.
  - `null` (or `""`) clears the stored skin.
  - On success, if the player is online right now, the RCON command applies the
    skin immediately (best-effort, never fatal).
- `GET /api/auth/session` response now includes `skin` (string or `null`).
- Apply on join: the net proxy's post-sniff login hook schedules
  `rcon.applySkin(username, skin)` 6 s after a verified login whenever
  `users.skin` is set (`gateway/src/netproxy.js`, `skinDelayMs`). 6 s (not the
  originally spec'd ~2 s) because SkinsRestorer's player selector cannot see
  the player until the configuration phase completes — verified live, see
  "Live verification" above. The wallet welcome message still fires at ~4 s.
  All RCON paths log-and-drop on failure (never throw — SPEC "RCON"
  discipline).

## Launcher usage

On the "Welcome back — continue as" view (`/login/` with a valid session):

- A **Skin** field accepts either a Minecraft username (the skin to copy) or an
  https PNG URL; the launcher adds the `name:`/`url:` prefix itself.
- Three presets: **Steve** (`MHF_Steve`), **Alex** (`MHF_Alex`) and
  **Ender purple** (`MHF_Enderman`) — Mojang-owned MHF helper accounts with
  stable skins. Name-based presets are used because `textures.minecraft.net`
  URLs do not end in `.png` and would fail the SPEC'd URL validation.
- **Save skin** → `POST /api/auth/skin` → confirmation. The current stored
  value is prefilled from the session. UI copy: *"Applies when you join."*

## Tests

`gateway/test/skins.test.js` (in the normal `npm test` suite): validation
matrix, migration idempotency + legacy-DB upgrade, session `skin` field,
`POST /api/auth/skin` (401/400/store/clear), console command construction, and
apply-on-join wiring with a stub RCON (including the impostor negative case).
