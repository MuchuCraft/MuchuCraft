# MuchuCraft 1:1 Token Economy — build contract

Owner decision: the in-game currency IS the MUCHU token, 1:1. Players earn in-game
(Essentials/Vault balance, denominated in MUCHU) and withdraw at par to their bound
Solana wallet from a treasury the owner funds with market-bought tokens. Devnet first;
mainnet cutover = .env change + funded keypair. Conventions: same as SPEC.md (ESM,
node:test, no floats — BIGINT raw units internally, decimal STRINGS at API boundaries).

## Architecture

```
Paper (Jobs Reborn pays Vault MUCHU) ──► EssentialsX economy (source of truth for spendable balance)
        ▲                                        ▲
        │ RCON (ops)                             │ localhost HTTP (Bearer BRIDGE_TOKEN)
        │                              MuchuBridge plugin (:8091)
        │                                        ▲
Gateway ├── /api/token/* routes ── ledger (SQLite, double-entry) ── withdrawal worker
        │                                                              │
        └── solvency monitor: Σ in-game balances + pending ≤ treasury  ▼
                                                    Solana RPC: TransferChecked from
                                                    treasury hot wallet → player's ATA
```

Withdrawal flow: player (authed session) requests amount → gateway debits in-game via
bridge (atomic) → ledger journal (−player liability/+onchain_outflow) → worker signs &
sends SPL transfer to the session's BOUND wallet only → confirmed | permanent-fail ⇒
refund credit via bridge + reversal entry.

## .env additions (already present; .env.example mirrors with placeholders)

SOLANA_CLUSTER=devnet | mainnet-beta        SOLANA_RPC_URL=...
MUCHU_MINT= (devnet setup fills)            MUCHU_DECIMALS=6
TREASURY_KEYPAIR_PATH=/home/ubuntu/.muchucraft/treasury.json   (outside repo, chmod 600)
BRIDGE_PORT=8091   BRIDGE_TOKEN=<generated>
WITHDRAWALS_ENABLED=true   WITHDRAW_MIN=10   WITHDRAW_MAX_PER_TX=1000
WITHDRAW_DAILY_CAP_PER_USER=500   WITHDRAW_GLOBAL_DAILY_CAP=5000

## MuchuBridge Paper plugin  [bridge agent]  — bridge-plugin/ in repo

Java 21-compatible source (compile with the sdkman JDK; targetting the running Paper
1.21.11). NO Gradle/Maven required: bridge-plugin/build.sh downloads compile-time jars
(paper-api from repo.papermc.io maven — or compile against server/versions extracted
paper jar — plus VaultAPI 1.7 from jitpack/GitHub), javac + jar into
server/plugins/MuchuBridge.jar. plugin.yml: name MuchuBridge, api-version '1.21',
depend: [Vault]. Zero runtime deps beyond the JDK (use com.sun.net.httpserver).

HTTP server on 127.0.0.1:BRIDGE_PORT only. Every request requires
`Authorization: Bearer <BRIDGE_TOKEN>` (401 otherwise). Port+token read from
plugins/MuchuBridge/config.yml, which build.sh/start-all.sh templates from root .env.
All economy ops hop to the main thread (Bukkit scheduler callSyncMethod) and use the
Vault Economy service. Amounts are decimal strings (BigDecimal), never floats.

- GET  /health            → {ok:true, economy:"<provider name>"}
- GET  /balance?player=N  → {player, balance:"123.45"} | 404 if never joined
- POST /debit  {player, amount, ref} → atomic has()+withdrawPlayer: {ok:true, newBalance}
                                        | 409 {error:"insufficient"} | 404 | 400
- POST /credit {player, amount, ref} → {ok:true, newBalance}
- POST /balances {players:[...]}     → {balances:{name:"12.34", ...}} (skip unknowns)

ref is logged (audit). Gateway owns idempotency; the plugin just executes.

## Gateway token module  [gateway-token agent]  — gateway/src/token/*

- `solana.js`: thin chain layer over @solana/kit 7 (+ @solana-program/token and
  token-2022 — DETECT the mint's owner program via getAccountInfo and use matching
  transfer/ATA derivation so a mainnet Token-2022 mint works unchanged). Exports:
  loadTreasury(path), getMintInfo(), getTreasuryState() → {sol, tokenRaw},
  sendWithdrawal({destAddress, rawAmount, onPersistSignature}) implementing the
  exchange-guide rules: idempotent ATA create (treasury pays rent), TransferChecked,
  compute-budget ixs, persist signature + lastValidBlockHeight BEFORE first send
  (callback), rebroadcast same bytes ~2s while polling getSignatureStatuses, NEVER
  re-sign until currentBlockHeight > stored lastValidBlockHeight and status still null.
- `bridge-client.js`: fetch wrapper for MuchuBridge (2s timeout, typed errors).
- `ledger.js`: extends db with tables (raw units BIGINT, 10^MUCHU_DECIMALS = 1 MUCHU):
    ledger_accounts(id, kind, user_id, name)  -- system: 'ingame_liability','onchain_outflow','adjustments'
    journal_entries(id, created_at, reason, ref UNIQUE)
    journal_legs(entry_id, account_id, delta)  -- SUM=0 per entry, enforced in txn
    withdrawals(id, idempotency_key UNIQUE, user_id, dest_address, amount_raw,
      state CHECK IN ('requested','debited','signed','submitted','confirmed','failed','refunded'),
      signature, last_valid_block_height, error, created_at, updated_at)
  Helpers: caps accounting (per-user/global daily sums), one non-terminal withdrawal
  per user enforced by partial-unique index or query-in-txn.
- `routes.js` (mounted /api/token, session Bearer required):
    GET  /status     → {balance:"...", withdrawable:true|false+reason, caps, treasury:{ok},
                        cluster, mint, boundWallet}
    POST /withdraw   {amount:"25"} → 202 {withdrawalId} | 400 (min/max/format) |
                      409 (insufficient / one-in-flight) | 429 (caps) | 503 (paused)
                      destination is ALWAYS the session's bound wallet.
    GET  /withdrawals → recent list incl. state + signature.
- `worker.js`: single-flight queue draining 'requested' rows: debit via bridge →
  'debited' + journal → sign/send → 'confirmed' (journal already reflects) or permanent
  fail → refund via bridge credit + reversal entry → 'refunded'. Crash recovery on boot:
  rows in signed/submitted → check stored signature before anything else. Circuit
  breaker: WITHDRAWALS_ENABLED=false env, solvency failure, or global cap trips pause
  the worker (rows stay 'requested').
- Solvency monitor: every 60 min + on worker start: liability = Σ POST /balances over
  all users in db + Σ non-terminal withdrawal amounts; if treasury tokenRaw < liability
  → pause + loud log + /status reflects it.
- index.js wiring: mount only when MUCHU_MINT set; warn-not-crash when unset.
- Tests (no network): ledger invariants (SUM=0, idempotency key dedupe, caps math,
  one-in-flight), state machine transitions incl. refund path with a MOCK solana.js
  and MOCK bridge; routes via ephemeral app (mock chain+bridge): min/max/caps/409/503,
  destination is bound wallet, decimal-string→raw conversions (reject >6 dp, negatives,
  exponent notation).

## Economy plugins  [economy agent]  — server/ additions, NO server boots

Download into server/plugins/ (verify HTTP 200 + sane size; Modrinth API preferred,
Spiget https://api.spiget.org/v2/resources/<id>/download for Spigot-only):
Jobs Reborn (Spigot 4216 — or Zrips GitHub releases), EconomyShopGUI (Spigot 69927),
GriefPrevention (Modrinth), UltraCosmetics (Modrinth, optional if incompatible).
Update server/setup.sh so fresh clones fetch these too. Configure (files under
server/plugins/<name>/ are generated on first boot — pre-create the ones we must pin):
- EssentialsX config.yml: currency-symbol 'MUCHU ', min-money: 0, starting-balance: 0;
  empty worth.yml (no /sell faucet); note kits untouched (none configured).
- Jobs generalConfig.yml: ExploitProtections ON (place/break protection), Limits →
  money cap 100/day/player (THE emission budget: max daily liability = 100 × players).
- EconomyShopGUI: default shops fine; ensure sell prices ≪ buy prices (spot-check).
- Since configs only fully generate on boot, write a server/plugins/POST-BOOT.md
  checklist of every value to verify after the integrator's boot, and pre-seed config
  files where the plugin honors pre-created ones (Essentials does; Jobs does).

## Wallet UI  [ui agent]  — gateway/public/login/ only

Add a "Wallet" card to the launcher when a session exists (alongside Continue-as):
in-game MUCHU balance, bound wallet (short), withdraw form (amount + min/caps hints from
GET /api/token/status), submit → poll GET /withdrawals until confirmed/failed, history
list with explorer links (cluster-aware: explorer.solana.com/tx/<sig>?cluster=devnet).
Graceful when /api/token/status 404s (token not configured): hide the card. Same
no-framework/no-CDN rules as SPEC.md.

## Devnet setup + token e2e  [devnet agent]

- gateway/scripts/devnet-setup.mjs (run with cwd=gateway): create/load
  ~/.muchucraft/devnet-mint-authority.json + TREASURY_KEYPAIR_PATH (chmod 600), airdrop
  devnet SOL with retries (faucet 429s are normal — retry/backoff, small amounts),
  create legacy SPL mint (6 decimals, authority = mint-authority key), create treasury
  ATA, mint 1,000,000 MUCHU, sed MUCHU_MINT= into root .env, print a summary +
  MAINNET-CUTOVER.md (docs/): swap MUCHU_MINT, fund treasury keypair with bought tokens
  + SOL for fees/ATA rent, set SOLANA_RPC_URL (Helius free tier), review caps, keep
  bulk tokens in a separate cold wallet and top up the hot float.
- e2e/run-token-e2e.js (style of run-e2e.js; stack must be up, devnet reachable):
  1) session for E2ETester (persisted fakewallet) 2) RCON `eco give E2ETester 50`
  3) GET /api/token/status shows balance ≥50 4) POST /withdraw 25 → poll to 'confirmed'
  5) on-chain: E2ETester wallet ATA gained exactly 25 MUCHU (raw 25_000_000)
  6) negatives: withdraw 5 (below min) → 400; withdraw 10_000 (over balance) → 409;
  second withdraw while first in-flight (submit two fast) → 409; PASS/FAIL summary,
  exit codes as run-e2e.js. Devnet flakiness: generous timeouts, retry status polls.
