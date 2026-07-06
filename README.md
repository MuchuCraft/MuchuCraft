<p align="center">
  <img src="Muchu.png" alt="MuchuCraft logo" width="220">
</p>

<h1 align="center">MuchuCraft</h1>

<p align="center">
  <b>Real Minecraft in your browser — log in with your Solana wallet.</b><br>
  A genuine Paper server with genuine plugins, played through an open-source web client.<br>
  No passwords, no <code>/register</code>: your wallet signature <i>is</i> your username.
</p>

---

## What is this?

Classic "cracked" Minecraft servers let anyone pick a username and protect it with
`/register <password>`. MuchuCraft replaces that with **Sign-In-With-Solana**: you connect
a wallet (Phantom, Solflare, Backpack…), sign a human-readable message, and the username
you chose is cryptographically bound to your wallet — forever yours, no password to leak
or forget. Then the browser client drops you straight into a real Minecraft world.

Under the hood this is **not** a Minecraft clone: it is a real **Paper 1.21.11** server
running 15 real plugins (EssentialsX, LuckPerms, WorldEdit, WorldGuard, GriefPrevention,
Jobs Reborn, SkinsRestorer, shops, cosmetics…), reached through the MIT-licensed
[minecraft-web-client](https://github.com/zardoy/minecraft-web-client) (the client behind
mcraft.fun), which runs the actual Minecraft protocol in your browser.

And the economy is real too: the in-game currency **is the MUCHU SPL token, 1:1**. Earn
it through Jobs, quests, and events; `/deposit` tokens into the game from your bound
wallet; withdraw your balance on-chain from the wallet page. A custom zero-dependency
Paper plugin (MuchuBridge) bridges the Vault economy to the gateway, a double-entry
ledger with a solvency monitor keeps every in-game coin backed by treasury tokens, and
deposit-gated earning tiers keep bot farms unprofitable. Ships pointed at **devnet**;
mainnet is a config swap (see `docs/MAINNET-CUTOVER.md`).

Players spawn at **The Amethyst Compass** — a scripted purpur-and-amethyst plaza in a
snowy cherry grove, WorldGuard-protected from griefing (build/PvP/creepers/mob-spawns
all denied, proven by automated grief tests) — then head into a pregenerated 6000-block
world to claim land with GriefPrevention, set homes, join jobs, and play.

## Quick start

Prerequisites: Linux, **Java 21+** (25 recommended — WorldEdit 7.4.4 is built for it),
**Node 24+**, ~2 GB disk, and outbound network for first-time downloads.

```bash
git clone https://github.com/MuchuCraft/MuchuCraft.git
cd MuchuCraft
cp .env.example .env          # then set RCON_PASSWORD to a long random string
./start-all.sh                # downloads Paper + plugins + web client on first run
```

Open **http://localhost:8090/** for the landing page — PLAY NOW takes you through
wallet connect → username claim → straight into the world. Stop with `./stop-all.sh`.
For the token economy on devnet, run `cd gateway && node scripts/devnet-setup.mjs` once
(creates the test mint + treasury), then restart the gateway. To host publicly, put the gateway behind TLS
(wallet extensions require a secure context) and set `SIWS_DOMAIN`/`SIWS_URI` to your
real domain — see [Configuration](#configuration).

## How it works

```
Browser
 ├─ /login/  wallet launcher ── POST /api/auth/nonce ─┐  SIWS message built server-side
 │                             POST /api/auth/verify ─┤  ed25519 verify (tweetnacl)
 │                                                    ▼
 ├─ /        minecraft-web-client (mineflayer in the browser)
 │              │  Authorization: Bearer <session token>
 │              ▼
 └──────► Gateway (Node, :8090)
            ├─ WebSocket⇄TCP proxy — the ONLY door to the server
            │    · validates the wallet-backed session token
            │    · sniffs the Minecraft Login Start packet and kills any
            │      connection whose username ≠ the wallet's username
            ├─ SQLite: users · nonces · sessions (wallet ↔ username binding)
            └─ RCON: in-game "wallet verified" welcome
                        │
                        ▼ TCP 127.0.0.1:25565 (localhost-only, offline-mode)
           Paper 1.21.11 + EssentialsX · LuckPerms · WorldEdit · ViaVersion · Chunky · Vault
```

**The auth flow.** The server issues a single-use, 5-minute nonce and builds a
[SIWS-style](https://github.com/phantom/sign-in-with-solana) message (domain-bound,
expiry-stamped). Your wallet signs it; the gateway verifies the ed25519 signature against
your address, claims the username on first sign-in (one wallet per name, case-insensitive
unique), and mints a 24 h session token. Nonces burn on first use — replays get a 400.

**Why usernames can't be stolen.** The Paper server binds to localhost in offline mode,
so every connection must pass the gateway proxy. The proxy parses the first bytes of the
Minecraft protocol handshake (VarInt-framed, pre-compression) and extracts the Login
Start username. If it doesn't match the username your wallet authenticated, the
connection is destroyed before a single byte reaches the server:

```
proxy-shutdown:username does not match your wallet session
```

## Project layout

| Path | What it is |
|---|---|
| `gateway/` | Node gateway: auth API, SQLite, WS⇄TCP proxy with login sniffer, static hosting |
| `gateway/src/mcsniff.js` | Pure incremental Minecraft handshake/Login-Start parser |
| `gateway/public/login/` | Wallet launcher page (vanilla JS, Wallet Standard + legacy providers) |
| `server/` | Paper server: `setup.sh` downloads jar (sha256-verified) + plugins, boots & pregenerates |
| `client/` | Web client bundle (downloaded by `setup.sh`; `NOTES.md` documents the wire protocol) |
| `gateway/src/token/` | 1:1 MUCHU economy: double-entry ledger, withdrawal worker, deposit watcher, solvency monitor |
| `bridge-plugin/` | MuchuBridge Paper plugin (Java, zero deps): Vault↔gateway HTTP bridge + `/deposit` command |
| `gateway/public/site/` | The landing website served at `/` |
| `scripts/` | Reproducible world/ops scripts: spawn builder, WorldGuard protection, LuckPerms bootstraps |
| `e2e/` | Live end-to-end suites: fake wallet + mineflayer bots through the real proxy (36 cases) |
| `docs/` | P2E research & plan, mainnet cutover runbook, earn gate, skins, player guide, spawn/protection docs |
| `SPEC*.md` | The architecture contracts each build phase was implemented against |

## Testing

```bash
cd gateway && npm test        # 169 unit tests: SIWS crypto, DB, ledger, proxy, sniffer, deposits, skins
./start-all.sh
cd e2e && npm install
node run-e2e.js               # 6 cases: auth, bot spawn, impostor kill, replay/409/403
node run-token-e2e.js         # 8 cases: real devnet withdrawal, caps, on-chain deltas
node run-deposit-e2e.js       # 6 cases: real devnet deposit, credit, earn-gate flip, dust
node run-phase4-proof.js      # 16 cases: grief protection, /home, kit, region flags, mobs
```

The e2e suites prove the whole pipeline with no browser: real ed25519 keypairs sign real
SIWS messages, **mineflayer bots connect through the actual WebSocket proxy** as ordinary
players, tokens actually move on devnet (withdrawals and deposits verified by exact
on-chain balance deltas), and a non-op bot literally attempts to grief spawn and gets
refused by WorldGuard. All 36 cases pass.

## Configuration

All knobs live in `.env` (see `.env.example`):

| Key | Meaning |
|---|---|
| `PORT` | Gateway HTTP/WS port (launcher, client, proxy — one origin) |
| `MC_HOST` / `MC_PORT` | Paper server address (keep it on localhost) |
| `MC_VERSION` | Pinned Minecraft version (must be supported by the bundled client) |
| `RCON_PORT` / `RCON_PASSWORD` | RCON for in-game welcomes and graceful shutdown |
| `SESSION_TTL_HOURS` | Wallet session lifetime |
| `SIWS_DOMAIN` / `SIWS_URI` | Domain embedded in signed messages — must match the page host |
| `DB_PATH` | SQLite location (wallet↔username bindings live here — back it up) |
| `MC_SEED` | World seed (default: a snowy-mountain cherry-grove village at spawn) |

## The MUCHU economy (1:1, live on devnet)

In-game money **is** the MUCHU token: earn up to 100/day through Jobs (everyone starts
with the Builder job; depositing 25+ MUCHU unlocks all 12), spend it in shops, land
claims and cosmetics, `/deposit` from your bound wallet (credited automatically by
source-address matching — no memos), and withdraw 1:1 to your wallet from the launcher.
Guardrails are first-class: per-user/global daily withdrawal caps, single in-flight
withdrawal, payouts only to the wallet that owns the username, a solvency monitor that
pauses withdrawals if treasury tokens ever fall below outstanding in-game balances, and
a kill switch. The mainnet runbook is [`docs/MAINNET-CUTOVER.md`](docs/MAINNET-CUTOVER.md).

The research behind the design — and the honest risks: Mojang's blockchain policy for
Minecraft servers (which killed NFT Worlds and Critterz), why most P2E economies
collapsed, and the regulatory picture — lives in [`docs/P2E-PLAN.md`](docs/P2E-PLAN.md).
Read it before pointing this at mainnet. All blockchain code stays strictly outside the
game server: the Paper plugin only speaks localhost HTTP to the gateway.

## Credits & legal

- [zardoy/minecraft-web-client](https://github.com/zardoy/minecraft-web-client) (MIT) and the
  [PrismarineJS](https://github.com/PrismarineJS) ecosystem — the browser client and protocol libraries.
- [PaperMC](https://papermc.io/), [EssentialsX](https://essentialsx.net/),
  [LuckPerms](https://luckperms.net/), [WorldEdit](https://enginehub.org/worldedit),
  [ViaVersion](https://viaversion.com/), [Chunky](https://github.com/pop4959/Chunky),
  [Vault](https://github.com/MilkBowl/Vault) — each under its own license, downloaded at
  setup time rather than redistributed here.
- MuchuCraft is **not affiliated with Mojang or Microsoft**. Minecraft is a trademark of
  Mojang Synergies AB. Read Mojang's
  [Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) before hosting
  publicly — especially before enabling anything token-related (see the P2E plan).

Project code is MIT licensed.
