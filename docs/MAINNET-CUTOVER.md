# MuchuCraft — mainnet cutover runbook

Devnet and mainnet run the exact same code. The cutover is a `.env` swap plus a
funded treasury keypair — nothing else changes. Work through this checklist in
order; each step is small and reversible until the final gateway restart.

## 0. What changes conceptually

On devnet we mint our own play-money MUCHU (`gateway/scripts/devnet-setup.mjs`
owns the mint authority and prints 1,000,000 into the treasury). On mainnet we
do NOT mint anything: MUCHU is a real, market-traded token. The owner **buys**
tokens on the market and deposits them into the treasury hot wallet. The
gateway pays withdrawals 1:1 out of that inventory; the solvency monitor pauses
withdrawals if in-game liabilities ever exceed what the treasury holds.

## 1. Swap the .env values

Edit the root `.env`:

```
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<your provider URL — see §4, do NOT use api.mainnet-beta.solana.com for production>
MUCHU_MINT=<the real MUCHU mint address on mainnet>
MUCHU_DECIMALS=<the real mint's decimals — VERIFY on-chain, do not assume 6>
```

Checks before proceeding:

- Confirm the mint address from at least two independent sources (project docs
  + explorer). A wrong mint here pays withdrawals in the wrong token.
- Verify decimals on-chain (`solana spl-token display <mint>` or an explorer)
  and set `MUCHU_DECIMALS` to match. All raw-unit math derives from it.
- The gateway's chain layer detects the mint's owner program automatically, so
  a Token-2022 mint works unchanged — but note which program owns it for your
  own explorer sanity checks.
- Leave `WITHDRAWALS_ENABLED=false` until §6's smoke test passes.

## 2. Treasury hot wallet: new keypair, small float only

Generate a FRESH keypair for mainnet — never reuse the devnet treasury file
(it has lived on a dev box; assume it is burned):

```
solana-keygen new --outfile /home/ubuntu/.muchucraft/treasury-mainnet.json
chmod 600 /home/ubuntu/.muchucraft/treasury-mainnet.json
```

Point `TREASURY_KEYPAIR_PATH` at it in `.env`. This is a **hot** wallet: the
gateway holds its key in memory and signs autonomously. Treat it like a cash
register, not a vault.

Fund it with:

- **Bought MUCHU tokens** — enough to cover expected withdrawal volume for a
  few days, not your whole position. A sane starting float is
  `WITHDRAW_GLOBAL_DAILY_CAP × 2` (with the default caps: 10,000 MUCHU).
- **SOL float for fees and rent** — every withdrawal is one transaction
  (~0.000005 SOL fee + priority fee) and may need to create the player's ATA
  (~0.002 SOL rent, paid by the treasury). 0.5 SOL comfortably covers
  thousands of withdrawals; top up when it drops below ~0.1 SOL.

## 3. Cold wallet for the bulk

Keep the bulk of the bought tokens in a **separate cold wallet** (hardware
wallet or an offline keypair that never touches this server). Operational
rhythm:

- Cold wallet holds the position; hot wallet holds a 1–3 day float.
- Top up hot from cold manually (a plain SPL transfer) when the float runs
  low — this is a deliberate human action, never automated.
- If the hot wallet is ever drained by a bug or compromise, the loss is capped
  at the float, and `WITHDRAW_GLOBAL_DAILY_CAP` bounds the bleed rate on top.

## 4. RPC provider

The public `api.mainnet-beta.solana.com` endpoint is aggressively rate-limited
and unsuitable for production sends. Use a dedicated provider — a **Helius
free tier** key is sufficient for this scale:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>
```

(Any provider with standard JSON-RPC + WebSocket works: Helius, Triton,
QuickNode, Alchemy.) Keep the key out of git; `.env` already is.

## 5. Review the caps

The devnet caps are testing values. Before mainnet, re-derive them from real
economics — remember every MUCHU withdrawn is a real token you bought:

| Var | Meaning | Think about |
|---|---|---|
| `WITHDRAW_MIN` | smallest withdrawal | keep ≥ a few cents' worth so fees/rent don't dominate |
| `WITHDRAW_MAX_PER_TX` | largest single withdrawal | your appetite for a single mistake |
| `WITHDRAW_DAILY_CAP_PER_USER` | per-player daily | ties to the Jobs emission budget (100 MUCHU/day/player earn cap) — a player should not be able to withdraw far faster than they can earn |
| `WITHDRAW_GLOBAL_DAILY_CAP` | protocol-wide daily | your maximum daily loss if everything goes wrong at once; also sizes the hot float (§2) |

Also re-check the earn side: Jobs Reborn's 100/day/player money cap is the
emission budget. Max daily new liability = 100 × active players; make sure
your token buying keeps up with that or lower the cap.

## 6. Cutover procedure

1. `./stop-all.sh` (or stop just the gateway).
2. Apply all `.env` edits from §§1–5, with `WITHDRAWALS_ENABLED=false`.
3. Start the stack. Check the gateway log: the token module must report the
   real mint, the treasury address, and its token/SOL balances.
4. `GET /api/token/status` — verify `cluster=mainnet-beta`, correct mint, and
   `treasury.ok` once the hot wallet is funded.
5. Smoke test with your own account: set `WITHDRAWALS_ENABLED=true`, restart,
   withdraw the minimum, confirm the transfer on an explorer
   (`https://explorer.solana.com/tx/<sig>`), and confirm the ledger row goes
   `requested → … → confirmed`.
6. Watch the solvency monitor line in the logs: liabilities (Σ in-game
   balances + pending withdrawals) must be ≤ treasury holdings, or the worker
   pauses itself.

## 7. Kill switch

- **Pause withdrawals**: set `WITHDRAWALS_ENABLED=false` in `.env` and restart
  the gateway. Pending rows stay `requested` and drain later; in-game play is
  unaffected. This is the first response to anything suspicious.
- The worker also self-pauses on: solvency failure or the global daily cap
  tripping. Do not "fix" a self-pause by raising caps — find the cause.
- **Full stop**: `./stop-all.sh` halts gateway + server (players lose access;
  use for suspected key compromise).
- If the hot key is compromised: stop the gateway, move any remaining hot
  funds to the cold wallet from a trusted machine, generate a new hot keypair,
  update `TREASURY_KEYPAIR_PATH`, refund a fresh float, restart.

## 8. Rollback

Restore the devnet `.env` values (the devnet mint/keys still exist) and
restart. Devnet and mainnet state never mix: the ledger DB records withdrawals
against whatever cluster was active, so avoid flip-flopping with pending
withdrawals in flight — drain or refund them first (worker handles permanent
failures by refunding in-game balances automatically).

## Status 2026-07-06 — cutover attempted, BLOCKED (two independent reasons)

1. **The mainnet mint does not resolve.** `R76wEBCrjipkHB8999utYpsECG6qM5S7a49YWKmuchu`
   returns no account. If this is a pre-ground vanity keypair, the token still needs to
   be created with it; if the token exists, re-check the address.
2. **This host cannot currently read mainnet account data at all.** The USDC mint —
   which certainly exists — is unreadable via both the Helius mainnet RPC and the
   public mainnet RPC from this box (genesis-hash queries work; account queries return
   null). Until that is resolved, the withdrawal worker and solvency monitor cannot
   operate safely against mainnet from here.

Preparation completed in advance: all devnet-era test balances zeroed (in-game money
supply is 0), token e2e suites refuse mainnet without E2E_ALLOW_MAINNET=1, and
`gateway/scripts/mainnet-preflight.mjs` now gates the flip — run it with your mainnet
RPC; it must print ALL CHECKS PASSED before touching .env. Fund the treasury hot wallet
(address printed by the preflight) with a small SOL float (~0.5) and the MUCHU float
you're comfortable keeping hot; keep the bulk in a separate wallet.
