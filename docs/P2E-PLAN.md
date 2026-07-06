# MuchuCraft P2E Plan — the MUCHU token

Proposal based on multi-agent research (July 2026): P2E economy post-mortems, Minecraft
economy plugins, Solana token engineering, abuse prevention, and the regulatory/platform
landscape. Facts below were verified against primary sources; judgments are marked.

> **Decision log (2026-07-06).** The owner chose a **full 1:1 model** instead of the
> phased points-first approach recommended below: the in-game currency IS the mainnet
> MUCHU token, redeemable at par from a treasury the owner funds with market-bought
> tokens. Implementation contract: `SPEC-TOKEN.md`; mainnet steps: `docs/MAINNET-CUTOVER.md`.
> Consequences accepted with eyes open: every in-game faucet is a direct claim on the
> treasury (Jobs daily limits are now the emission budget in real money), bot abuse is
> direct theft rather than inflation, and this is the strongest "real income" shape both
> regulatorily and under Mojang's blockchain policy (§0). Mitigations implemented:
> solvency monitor with auto-pause, per-user/global daily withdrawal caps, withdrawal
> minimums, single in-flight withdrawal per user, payouts only to the bound wallet,
> hot-wallet float kept separate from the bulk treasury, and a kill switch
> (`WITHDRAWALS_ENABLED=false`). The research and guardrail rationale below is kept
> as-is — the sink/faucet, anti-abuse, and monitoring sections apply doubly under 1:1.

## 0. Read this first: the two existential risks

**Platform risk (Mojang).** Mojang's Usage Guidelines (July 20, 2022, still live) state
blockchain technologies "are not permitted to be integrated inside our Minecraft client
and server applications," and Minecraft content may not be used to create scarce digital
assets. This rule is why the two biggest Minecraft-crypto projects died: **NFT Worlds**
(~100k players; token −60% in hours; forced to abandon Minecraft entirely, then migrated
tokens twice more) and **Critterz** (2,000 daily players → 8 in six weeks). MuchuCraft is
a Paper server; a token earned by gameplay sits squarely in the banned category, and the
offline-mode browser client does not exempt us. If we proceed, we do it knowing Mojang
could demand a shutdown at any time — and we architect so that **no blockchain code ever
touches the Minecraft server or client**: the game only ever writes *points* to our own
SQLite; all token activity happens on our website, outside the game.

**Economic risk (the P2E graveyard).** Every uncapped-emission earn-token studied went to
approximately zero: Axie's SLP (−98%; emergency 56% emission cut came with a public
"total and permanent economic collapse" warning), StepN's GST (−97% in six weeks),
CryptoMines' ETERNAL (−99.5%, game dead in 4 months), NFT Worlds' WRLD. The one durable
pattern (Pixels, ~1M DAU peak, still operating): **off-chain soft currency for daily
play, one scarce on-chain token touched only at controlled bridge points, fixed
emission budgets, real sinks, and real non-token revenue.** Even survivors' tokens are
down 90–99% from highs. At MuchuCraft's scale (tens–hundreds of players) a liquid MUCHU
market cannot exist; MUCHU's honest job is **retention, status, and fun — not income**.
That is also the safer regulatory posture (see §7).

## 1. Recommended model (assessment, high confidence)

Combine the two verified surviving patterns:

1. **Off-chain first.** The in-game economy runs entirely in EssentialsX/Vault currency
   (branded "Muchu") plus a **Muchu Points** ledger in the gateway's SQLite, keyed to the
   existing wallet↔username table. Free to emit, free to sink, instantly re-balanceable,
   fully clawback-able while we tune it — and no tradeable asset exists for regulators,
   bots, or Mojang to care about yet.
2. **Fixed seasonal pools.** If/when the token launches, players never earn MUCHU
   per-action. They earn *points* all season; at season end a **fixed, pre-announced
   MUCHU pool** (sized to what we can afford — possibly small) is split pro-rata /
   leaderboard-tiered, claimable on the website with a wallet signature. Total emission
   is budgeted top-down and *cannot* scale with player count or grinding hours — this
   single property prevents the Axie/StepN failure mode, and it makes bot fleets
   self-diluting (each added bot reduces every bot's share).
3. **One token, no governance token.** Dual-token was the most thoroughly falsified
   design of 2021 (both flagship examples hyperinflated), and a governance token adds
   securities exposure for nothing at our scale.

## 2. Phased rollout

### Phase 0 — In-game economy foundation (no blockchain at all)
Install and tune the earning/sink plugin stack (§3). Brand the Essentials currency
symbol as MUCHU. Configure emission caps and anti-exploit before anything is worth
farming. Deliverable: a fun survival economy that would be worth playing with zero crypto.

### Phase 1 — Points season (8–12 weeks, still no token)
- **Muchu Points ledger** in gateway SQLite: double-entry journal (see §5), earned from
  quest completions, events, votes, and *quality-weighted, capped* activity — never raw
  online-time.
- **MuchuBridge plugin** (~200-line custom Paper plugin): localhost HTTP endpoints for
  balance read/credit/debit + `UserBalanceUpdateEvent` webhooks pushed to the gateway.
  RCON (`eco give/take`, output parsing) works as a v1 fallback but is string-fragile —
  the plugin gives exact BigDecimal values and push events. This is the only new Java
  code in the project, and it contains zero blockchain logic.
- Anti-bot layers live at the proxy and gateway (§6).
- Season end: publish leaderboard; points convert to cosmetics/titles/next-season perks.
  **This phase is the current industry playbook ("points meta") and costs nothing if
  interest fizzles.** Run at least one full season before any token exists.

### Phase 2 — MUCHU token on devnet (engineering rehearsal, $0)
- Mint MUCHU as **Token-2022 with only metadata-pointer + token-metadata extensions**
  (name "Muchu", symbol "MUCHU", logo = downscaled Muchu.png hosted with a metadata
  JSON). **Skip transfer-fee and transfer-hook extensions** — wallet/DEX compatibility
  killers. Legacy SPL + Metaplex is the zero-risk alternative. **6 decimals**; ledger
  stores raw u64 units as INTEGER (never floats).
- Keys: mint authority on a keypair that never touches the game box (Ledger later,
  Squads multisig if the token ever has real value). Treasury hot wallet on the gateway
  box holds only working float.
- **Withdrawal/claim service** in the gateway (@solana/kit 7 + @solana-program/token-2022):
  idempotency-key gated payouts, signature persisted before first send, never re-sign
  until the prior blockhash provably expired (the canonical double-spend guard),
  idempotent ATA creation (treasury pays ~0.002 SOL rent for a player's first claim),
  TransferChecked, compute-budget instructions, per-user and global daily caps with a
  circuit-breaker kill-switch.
- Claim page on the website (wallet already connected there) — **not** in the game.
- Run a full season settlement end-to-end on devnet. Public devnet RPC suffices for
  setup; free Helius tier before wiring webhooks/monitoring.

### Phase 3 — Mainnet (only if a points season proved real demand)
- Fixed pre-announced pool per season; **per-player cap ~2–5% of pool**; 2–10% bridge
  tax; multi-week vesting on claims; minimum claim size (ATA rent makes dust claims
  cost-dominant).
- Revoke freeze authority at launch (rug-scanner hygiene); keep mint authority on
  multisig/cold key (continued seasonal emission needs it).
- Nightly reconciliation: on-chain treasury balance + ledger outflow account must equal
  total minted; any drift = incident. Alert on any treasury outflow not matching a
  withdrawal row (key-compromise canary).
- One-time mainnet cost ≈ $0.50–1.60; per-claim cost ≈ $0.0005 + $0.17 once per new
  player (ATA rent). At 100 claims/day steady-state: ~$1.35/mo. Costs are a non-issue;
  ATA rent is the only material driver.

## 3. In-game plugin stack (all verified compatible with recent Paper 1.21.x)

| Role | Plugin | Notes |
|---|---|---|
| Primary faucet | **Jobs Reborn** | Pays Vault money for mining/farming/hunting/building. `ExploitProtections` (CoreProtect-backed place/break tracking, silk-touch blocks, spawner controls) + `Limits` section = the per-player daily emission cap primitive. |
| Scripted content | **BeautyQuests** (or PikaMug Quests) | One-time/cooldown quests; emissions capped by quest design. |
| Daily ritual | **VotingPlugin + NuVotifier** | ~1 vote/24h/site, inherently capped; free marketing. |
| Events | **EvenMoreFish** | Scheduled fishing competitions with fixed prize pools. |
| Retention | **PlaytimeRewards** | Small milestones only; pair with EssentialsX auto-AFK so AFK time never accrues. |
| Primary sink | **EconomyShopGUI** | Admin shop; buy prices ≫ sell prices; premium adds dynamic pricing. |
| P2P + tax sink | **Fadah** auction house | Listing tax > 0 is the actual sink (transfers themselves are net-zero). |
| Land sink | **GriefPrevention** (`/buyclaimblocks`) or **Lands** (premium) | Lands adds recurring upkeep taxes — the strongest continuous drain. |
| Pure sink | **UltraCosmetics** | Cosmetics remove currency and return nothing of intrinsic value. Ideal. |

Config gotchas (verified): EssentialsX must be the *only* Vault economy provider; empty
`worth.yml`/disable `/sell` and audit kits (built-in faucets bypass caps); audit every
Jobs-payout→shop-sell loop for positive-EV cycles; `min-money: 0`; keep `/pay` (net-zero)
but log via balance webhooks; never allow username changes (offline-mode UUIDs are
name-derived — our wallet binding already enforces this).

## 4. Faucet/sink guardrails (the numbers that matter)

- **Budget top-down**: fix total emission per season in advance. Never per-action rates
  that scale with hours or headcount.
- **Hard daily cap** per player (StepN's energy system is the reference), plus
  **diminishing returns**: full rate first ~60–90 min of qualifying play, then 50%,
  then ~10%; weekly caps too — shift-grinding (the Critterz scholar pattern) must not pay.
- **Reward varied, verified actions** (quests, events, votes, boss kills, judged builds),
  never raw online-time — AFK time is the most bottable faucet in Minecraft.
- **Sinks players want, recurring, non-pay-to-win**: cosmetics, land upkeep, convenience
  (/home slots, keep-inventory insurance), status (titles, name colors), upgrade burns,
  5–10% marketplace tax, 2–10% bridge tax.
- **Dashboard from day one**: weekly faucet:sink ratio; if faucets exceed sinks by ~20%
  for two weeks, cut emissions immediately (Axie waited until it needed an emergency 56%
  cut). Forever-rule: monthly value of tokens out ≤ real revenue in (Pixels' "net
  ecosystem spend" target).
- **Seasons**: 8–12 weeks; balances convert at a published rate or decay at season end;
  all nerfs/buffs land at season boundaries; fresh cosmetic sets each season.

## 5. Ledger design (gateway SQLite, extends existing db.js)

Double-entry bookkeeping, amounts in BIGINT raw units (10^6 = 1 MUCHU):

```sql
ledger_accounts(id, kind 'user'|'system', user_id NULL, name)
  -- system accounts: 'emissions', 'sinks', 'onchain_outflow'
journal_entries(id, created_at, reason, ref)
journal_legs(entry_id, account_id, delta BIGINT)  -- SUM(delta)=0 enforced per entry
withdrawals(id, idempotency_key UNIQUE, user_id, dest_address, amount, state
  CHECK(state IN ('pending','signed','submitted','confirmed','failed')),
  signature, last_valid_block_height, created_at, updated_at)
```

Earning: +player/−emissions. Spend: −player/+sinks. Withdrawal: reserve (−player/
+onchain_outflow) *before* any on-chain action; reverse on permanent failure. Balance =
SUM of legs. The Node ledger is the source of truth; the in-game Essentials balance is a
projection reconciled through MuchuBridge. Deposits (if ever needed): Solana Pay
reference keys are the cleanest correlation primitive.

## 6. Anti-abuse (assume industrial botting from day one)

Sobering fact: **our own client is mineflayer** — a headless bot is byte-for-byte
indistinguishable at the protocol layer, and our repo documents the wire protocol.
Movement-simulation anticheats would false-flag legitimate browser players. Defense must
be behavioral and economic:

1. **Structural**: fixed emission pools make bot fleets self-diluting (§1). Size daily
   caps so `cap × token price × survival-time < stake forfeited + aged-wallet cost`.
2. **Proxy-layer (our unique advantage — every connection is wallet-authenticated)**:
   one concurrent connection per wallet; N registrations per IP/day; session-length caps
   (only first 4–6h/day earn-eligible); action-timing entropy, APM distributions, verb
   diversity, cross-wallet action-sequence similarity clustering; browser fingerprint +
   IP/ASN correlation as scoring inputs (not gates).
3. **In-game**: Jobs `Limits` + CoreProtect-backed place/break protection;
   SpawnReason-aware mob payouts (kill grinder economics at the root); EssentialsX
   auto-AFK freeze; optional randomized mid-session map-pixel captchas (hardest for
   mineflayer to OCR).
4. **Sybil (wallet manufacturing is free — binding alone is insufficient)**: wallet-age
   + on-chain history gates before earning activates (`getSignaturesForAddress`), funding-
   parent clustering (LayerZero removed 59% of 1.3M applicants this way), new-wallet earn
   ramp, invite tree with cascading bans, and optionally a small refundable SOL stake to
   activate earning — the single highest-leverage defense, at a real friction cost.
5. **Value gate**: because balances are off-chain until claim, withdrawals above a
   threshold go to a manual review queue, and retroactive sybil filtering happens
   *before* value finalizes — the LayerZero pattern.

## 7. Regulatory posture (factual landscape, not legal advice)

Earned tokens weaken the "investment of money" Howey prong at earn time, but a freely
tradeable token managed by a small central team maps closely onto "efforts of others,"
and earnings-focused marketing is the classic aggravating factor. 2026 climate: federal
enforcement receded (SEC dismissed most non-fraud registration cases; CLARITY Act
pending), but **state** regulators filled the vacuum, and randomized rewards can brush
gambling statutes. The points-first design is the dominant industry pattern precisely
because points aren't tradeable. If a mainnet claim ever ships: no earnings promises
anywhere (present MUCHU as a seasonal trophy/collectible), geo-restrict claims like the
major airdrops do (US persons commonly blocked; OFAC always; UK/Canada frequently; EU
triggers MiCA duties), and note that earned tokens are ordinary income at receipt for US
tax purposes.

## 8. Decisions needed before Phase 1

1. Proceed at all, given the Mojang platform risk? (Architecture minimizes surface but
   cannot eliminate the rule.)
2. Season length (default 10 weeks) and season-1 prize framing (cosmetics/status only).
3. Stake-gate earning (strongest anti-sybil, most friction) — yes/no/aged-wallet-alt.
4. Phase-2 trigger criteria (e.g., ≥N daily-active wallets sustained over a full season).
5. Mainnet pool sizing and whether MUCHU launches transferable or bAXS-style bonded.
