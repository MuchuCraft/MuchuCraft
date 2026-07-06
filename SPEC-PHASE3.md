# MuchuCraft Phase 3 — deposits, earn gate, website, skins

Extends SPEC.md + SPEC-TOKEN.md (read both first; all conventions apply). Current state:
stack RUNNING, token module live (withdrawals proven on devnet), RPC = Helius devnet
(SOLANA_RPC_URL in .env), 12 plugins enabled incl. MuchuBridge on :8091.
New .env keys (present): DEPOSIT_MIN=1, DEPOSIT_GATE_MIN=25, DEPOSIT_POLL_SECONDS=20.

## 1. Deposits  [deposit agent: gateway/src/token/deposits.js + tests + e2e/run-deposit-e2e.js]

Players send MUCHU from their BOUND wallet to the treasury; the gateway credits in-game
1:1. No memos — correlation is by source address (every player's wallet is known).

- Watcher (started from worker.js or index.js alongside the worker): every
  DEPOSIT_POLL_SECONDS, getSignaturesForAddress(treasuryATA, {until: <cursor>}) via the
  configured RPC, then getTransaction (jsonParsed) per new signature. For each incoming
  SPL transfer of MUCHU_MINT into the treasury ATA: source token account's OWNER is the
  depositor address. Persist cursor; survive restarts (scan back until last stored sig).
- Tables: deposits(signature TEXT PK, slot, block_time, from_address, amount_raw,
  user_id NULL, status CHECK IN ('credited','unmatched','dust','pending_retry'),
  created_at). Signature PK = idempotency; a re-scan can never double-credit.
- Matching: from_address == users.address → credit: bridge POST /credit (in-game +) and
  journal entry (+player / −... deposits INCREASE liability but the tokens arrived in
  treasury, so record +player_liability leg against a 'deposits_in' system account —
  solvency stays balanced by construction). amount < DEPOSIT_MIN → status 'dust', no
  credit, log. Unknown from_address → 'unmatched', log loudly (manual handling).
  Bridge/RPC failure mid-credit → 'pending_retry', retried next tick (journal ref =
  deposit signature keeps ledger idempotent).
- Self-deposits FROM the treasury address itself and withdrawal-change txs must be
  excluded (skip when from_address == treasury owner).
- API: GET /api/token/status gains {deposit: {address: <treasury OWNER address>,
  minimum, gate: {threshold, cumulativeRaw, unlocked}}}. New GET /api/token/deposits
  (session) → recent deposits for that user (array, same style as /withdrawals).
- Gateway → bridge push: on boot and on change, POST /deposit-info
  {address, minimum, gateThreshold} to the bridge (Bearer BRIDGE_TOKEN) so /deposit works
  in-game. Tolerate bridge-down (retry with backoff, warn).
- Tests (mock RPC fixtures + mock bridge): parse jsonParsed transfer fixtures (both
  transferChecked and transfer forms), dedupe on signature, dust, unmatched, retry path,
  cursor persistence, journal refs, gate accounting.
- e2e/run-deposit-e2e.js (style of run-token-e2e.js; devnet, stack up): E2ETester's
  persisted wallet holds devnet MUCHU from withdrawal runs (≥35) and ~1 SOL. 1) session +
  status → read deposit address + gate (expect locked unless prior runs unlocked; assert
  shape) 2) send 25 MUCHU on devnet from e2e wallet → treasury (build with @solana/kit
  from gateway/node_modules; transferChecked; wait confirmed) 3) poll /api/token/status
  ≤3 min until in-game balance +25 and gate.unlocked true 4) RCON `lp user E2ETester
  parent info` shows depositor group 5) negative: tiny 0.5 MUCHU deposit → after 2 poll
  cycles it appears in deposits table as dust (assert via /api/token/deposits NOT
  crediting; balance unchanged) 6) bot joins and runs `/deposit` in chat; assert the chat
  reply contains the deposit address (bot 'message' event). PASS/FAIL summary, exit codes.

## 2. Earn gate  [gate agent: LuckPerms/Jobs config via RCON + docs/EARN-GATE.md; may edit gateway/src/token/deposits.js ONLY for the promote call contract below]

Goal: non-depositors earn a trickle; cumulative deposits ≥ DEPOSIT_GATE_MIN unlocks full
earning. Mechanism (VERIFY against installed Jobs 5.2.6.3 — read the jar/plugin docs):
Jobs join permission is the reliable primitive (jobs.use.<jobname> or jobs.join.<jobname>
— confirm the exact node by testing on the live server with a LuckPerms group). Design:
- LuckPerms bootstrap (idempotent, via RCON): create group `depositor`; default group
  gets join permission for exactly ONE starter job (pick the lowest-paying of the 12
  loaded jobs, e.g. Fisherman or Woodcutter — check `jobs browse` payouts); `depositor`
  gets join permissions for ALL jobs. Remove/negate default access to the rest. Verify
  with a real test: RCON `lp user E2ETester parent add/remove depositor` + `jobs join X`
  expectations documented (join checks happen at /jobs join time AND payout time?
  document what you verify).
- Deposit agent calls: promoteToDepositor(username) — implement as RCON
  `lp user <name> parent add depositor` from the deposits watcher when the gate unlocks
  (and on login for already-unlocked users as idempotent insurance). Demotion: not
  automatic (deposits are cumulative).
- docs/EARN-GATE.md: the tier table (starter job + 100/day cap for everyone; all 12 jobs
  for depositors), the verified permission nodes, how to tune DEPOSIT_GATE_MIN, and the
  RCON bootstrap commands for fresh installs (also append them to server/setup.sh as a
  post-first-boot note or an idempotent lp-bootstrap script scripts/lp-bootstrap.sh
  using rcon-client from gateway).

## 3. Website  [web agent: gateway/public/site/* + the routing edit in gateway/src/index.js + config.json merge]

- gateway/public/site/: index.html, site.css, site.js (vanilla, no CDNs), muchu.png
  (copy from root). Dark Solana aesthetic matching the launcher (#9945FF/#14F195).
  Sections: hero (logo, "Real Minecraft. In your browser. Your wallet is your identity.",
  big PLAY NOW → /login/, secondary "Open game client" → /?play=1), How it works (3
  steps: connect wallet → claim username → play), Features grid (real Paper server +
  plugins; wallet-owned usernames; 1:1 MUCHU: earn in-game & withdraw on-chain; deposit
  to unlock full earning; skins), MUCHU section (deposit/withdraw explainer, honest
  "devnet beta" badge sourced from /api/token/status cluster), FAQ (is this real
  minecraft? what wallet? is my username mine forever? what does depositing do?), footer:
  GitHub repo link, "not affiliated with Mojang/Microsoft".
- Routing in index.js (edit ONLY the bare-/ handler): GET / with NO query → serve
  site/index.html (NOT a redirect anymore); GET / with any of ip/token/username/version/
  autoConnect/play/singleplayer → client dist index.html as today; /login/ unchanged;
  site assets under /site/*.
- config.json merge additions (public-config override the gateway already serves):
  promoteServers: [{ip: "127.0.0.1:25565", name: "MuchuCraft", description:
  "Wallet-verified survival — muchucraft", version: "<MC_VERSION>"}] (replaces upstream
  mcraft.fun promos), defaultHost: "127.0.0.1:25565". Verify keys against
  client/dist/config.json shape (see client/NOTES.md + dist config.json).

## 4. Skins  [skin agent: SkinsRestorer install + gateway skin support + launcher picker]

- server: download SkinsRestorer (Modrinth, latest compatible with Paper 1.21.11) into
  server/plugins/ + add to server/setup.sh (pinned URL, sha if available). Offline-mode
  note: SkinsRestorer works on offline servers out of the box; check config for
  api/mineskin needs. Do NOT restart the server (integrator does).
- gateway: users gains skin column (db.js migration additive: ALTER TABLE ... ADD COLUMN
  skin TEXT NULL — guard with PRAGMA table_info check). POST /api/auth/skin (session
  Bearer) {skin: "name:<mcname>" | "url:<https png url>"} — validate (mc name regex, or
  https URL ending .png, ≤300 chars), store. GET /api/auth/session response gains skin.
  Apply on login: netproxy's post-sniff hook already calls rcon welcome — extend rcon.js
  sendWelcome flow (or a sibling applySkin) to also run the SkinsRestorer console command
  ~2s after join when users.skin set. VERIFY the exact SkinsRestorer console syntax
  against the installed version (`sr set <player> <skin/url>`? `skin set ...`?) — test
  live via RCON after integrator restart; document in code comment + docs.
- launcher (gateway/public/login/): in the session/continue view add "Skin"控件: a text
  field accepting a Minecraft username or a skin PNG URL + 3 preset buttons (classic
  Steve/Alex/a MuchuCraft-purple preset by URL — use well-known skin URLs from
  textures.minecraft.net only if stable, else name-based presets like "Notch") + Save →
  POST /api/auth/skin → confirmation; show current skin value from session. No CDNs.
- The skin applies next join (and immediately if online — via the RCON command). Note
  in UI copy: "applies when you join".

## 5. Integration  [integrator]

1. gateway npm test — full suite (old + new deposit/skin tests) green.
2. ./stop-all.sh && ./start-all.sh (loads SkinsRestorer; 13 plugins now). RCON `plugins`
   green; latest.log clean; verify SkinsRestorer enabled in offline mode.
3. LuckPerms bootstrap ran (gate agent's script) — verify groups + perms via RCON.
4. Website smoke: GET / (no query) → site html w/ muchu.png + PLAY NOW → /login/;
   GET /?play=1 → client html; GET /config.json → promoteServers = MuchuCraft only,
   defaultHost set; /login/ still works; /site/site.css 200.
5. Skin smoke: set a skin via API for E2ETester, verify RCON command path fires on a bot
   join (log line) and SkinsRestorer accepts it (command output in latest.log).
6. Full e2e matrix: run-e2e.js (6), run-token-e2e.js (8), run-deposit-e2e.js (new) — all
   green against devnet through the Helius RPC. Watch the 500/day per-user withdrawal cap
   across repeated runs (remainingIssues #5 from last round) — if tripped, use RCON
   eco/set + note it, don't weaken the cap.
7. Leave stack RUNNING; report per-step PASS/FAIL + evidence (deposit credit signature,
   gate flip proof).
