# MuchuCraft player guide

Play real Minecraft in your browser. Your Solana wallet is your account, and
everything you earn in-game is **MUCHU** — a real token you can cash out.
(This page doubles as the website FAQ source.)

## 1. Your wallet is your identity

- You joined by connecting a Solana wallet on the MuchuCraft website and
  signing a message. That signature — not a password — proves you own your
  username. Nobody can log in as you without your wallet.
- One wallet = one username, permanently bound on first join.
- Nobody legit will EVER ask for your seed phrase. Not admins, not "support",
  not in chat, not in mail. Rule 4 exists for a reason.

## 2. First five minutes

| Do this | Why |
|---|---|
| `/kit starter` | One-time kit: stone tools, 16 bread, 32 torches, a cherry sapling, and the **Welcome to MuchuCraft** book (this guide, in miniature). |
| `/rules` and `/motd` | House rules + the quick command cheat-sheet. |
| `/jobs join Builder` | Start earning MUCHU immediately (see below). |
| Walk out of the spawn plaza | The plaza is protected — you cannot build there. The wilderness is all yours. |
| `/sethome` at your first base | So `/home` can always bring you back. |

## 3. Earning MUCHU

- **Jobs pay you.** `/jobs join Builder` and every block you place earns a
  trickle. `/jobs stats` shows progress, `/jobs info Builder` shows what pays.
- **Deposits unlock the good jobs.** Everyone starts with the Builder job
  only. Once your *cumulative* deposits reach the gate (currently **25
  MUCHU**), you are promoted to **depositor** and can join ALL 12 jobs —
  Brewer, Builder, Crafter, Digger, Enchanter, Explorer, Farmer, Fisherman,
  Hunter, Miner, Weaponsmith, Woodcutter (up to 3 at once).
- **Daily cap.** Job earnings are capped at 100 MUCHU per day per player —
  the server's emission budget. Trading with players (`/pay`, shops) is not
  capped.
- **In-game money is MUCHU 1:1.** `/balance` is denominated in MUCHU and
  withdrawable at par.

## 4. Deposit & withdraw

- `/deposit` (in game) shows the deposit address for your bound wallet — send
  MUCHU there and it lands on your in-game balance after confirmation.
- **Withdraw on the website** (the page where you connected your wallet):
  enter an amount and it is sent on-chain to your bound wallet. Minimums and
  daily caps are shown on the withdraw form.
- Depositor status is cumulative and never taken away.

## 5. Homes & getting around

- `/sethome [name]` — save your location. Everyone gets **2 homes**;
  depositors get **5**.
- `/home [name]` — teleport back. `/delhome <name>` removes one.
- `/spawn` — return to the spawn plaza.
- `/tpa <player>` — ask to teleport to a friend; they answer with
  `/tpaccept` or `/tpdeny` (`/tpacancel` to withdraw the request).
- Teleports have a **3 second warm-up** (do not move, do not take damage) and
  a **30 second cooldown** — no combat escapes, no teleport spam.
- Respawning takes you to spawn unless you have slept in a bed.

## 6. Protecting your builds (claims)

- The spawn plaza is grief-proof by the server; **your** builds are protected
  by claims you make yourself.
- Get a **golden shovel** (craft it — 2 sticks + 3 gold ingots) and
  right-click the ground at two opposite corners of your build. Sparkling
  borders confirm the claim.
- Inside your claim nobody else can build, break, or open chests. Share
  access with `/trust <player>` (undo: `/untrust`), containers only with
  `/containertrust`.
- You start with enough claim blocks for a first house and passively earn
  more every hour you play. `/abandonclaim` refunds a claim.
- Unclaimed wilderness builds are NOT protected — claim early.

## 7. Chat, mail & money between players

- `/msg <player> <text>` and `/r <text>` — private messages; `/ignore
  <player>` mutes a pest.
- `/mail send <player> <text>` — offline messages; read with `/mail read`.
- `/pay <player> <amount>` — send MUCHU in-game.
- `/balance` (`/bal`) — your MUCHU; `/balancetop` — the leaderboard.
- `/afk` — flag yourself away.

## 8. Command cheat-sheet

| Command | What it does |
|---|---|
| `/kit starter` | One-time starter kit + welcome book |
| `/jobs join Builder` / `/jobs stats` | Earn MUCHU |
| `/deposit` | Deposit address for topping up |
| `/balance`, `/balancetop`, `/pay` | MUCHU money |
| `/sethome`, `/home`, `/delhome` | Homes (2, depositors 5) |
| `/spawn`, `/warp` | Get around |
| `/tpa`, `/tpaccept`, `/tpdeny`, `/tpacancel` | Teleport to friends |
| `/msg`, `/r`, `/mail`, `/ignore` | Chat & mail |
| `/rules`, `/motd`, `/help`, `/afk` | Info & status |
| golden shovel, `/trust`, `/abandonclaim`, `/claimslist` | Land claims |

*Withdrawals live on the website, not in a command.*

---

### Server notes (ops, not players)

- Permissions behind this guide: `scripts/perms-bootstrap.sh` (LuckPerms,
  idempotent, self-verifying via `lp export`). Essentials seeds:
  `server/setup.d/experience.sh`.
- World pregeneration (SPEC-PHASE4 §4): Chunky, center 0 0, radius 3000
  blocks. Check with RCON `chunky progress`; it resumes across restarts.
  Expect roughly 2-6 GB of world data when complete.
- `/spawn` requires the EssentialsXSpawn module; the `essentials.spawn`
  permission is already granted so it works the moment the jar is installed.
