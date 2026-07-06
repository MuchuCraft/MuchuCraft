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
running real plugins (EssentialsX, LuckPerms, WorldEdit, ViaVersion, Chunky, Vault),
reached through the MIT-licensed [minecraft-web-client](https://github.com/zardoy/minecraft-web-client)
(the client behind mcraft.fun), which runs the actual Minecraft protocol in your browser.

## Quick start

Prerequisites: Linux, **Java 21+** (25 recommended — WorldEdit 7.4.4 is built for it),
**Node 24+**, ~2 GB disk, and outbound network for first-time downloads.

```bash
git clone https://github.com/MuchuCraft/MuchuCraft.git
cd MuchuCraft
cp .env.example .env          # then set RCON_PASSWORD to a long random string
./start-all.sh                # downloads Paper + plugins + web client on first run
```

Open **http://localhost:8090/login/**, connect your wallet, claim a username, and play.
Stop everything with `./stop-all.sh`. To host publicly, put the gateway behind TLS
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
| `e2e/` | Live end-to-end suite: fake wallet + mineflayer bot through the real proxy |
| `docs/P2E-PLAN.md` | Play-to-earn research & phased MUCHU token plan |
| `SPEC.md` | The full architecture contract the system was built against |

## Testing

```bash
cd gateway && npm test        # 67 unit tests: SIWS crypto, DB, auth routes, sniffer, proxy
./start-all.sh
cd e2e && npm install && npm test   # 6 live cases against the running stack
```

The e2e suite proves the whole pipeline with no browser: it generates a real ed25519
keypair, signs the real SIWS message, gets a session, then connects a **mineflayer bot
through the actual WebSocket proxy** and waits for the in-world spawn event — plus four
adversarial cases (no token → 403, impostor username → killed, second wallet claiming a
taken name → 409, replayed nonce → 400). All six pass.

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

## MUCHU & play-to-earn

The economy roadmap — an earnable MUCHU currency, seasonal on-chain settlement, and the
research behind it (including the honest risks: Mojang's blockchain policy for Minecraft
servers, and why most P2E economies collapsed) — lives in
[`docs/P2E-PLAN.md`](docs/P2E-PLAN.md). Short version: points first, token later, fixed
seasonal pools, and all blockchain code kept strictly outside the game server.

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
