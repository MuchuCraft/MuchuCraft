# Earn gate — deposit-gated Jobs access (SPEC-PHASE3 §2)

Non-depositors earn a trickle from ONE starter job; players whose cumulative
on-chain deposits reach `DEPOSIT_GATE_MIN` MUCHU are promoted to the
`depositor` LuckPerms group and can join ALL jobs. Demotion is never automatic
(deposits are cumulative).

## Tiers

| Tier | LuckPerms group(s) | Jobs joinable | Daily earning cap |
|---|---|---|---|
| Everyone (default) | `default` | **Builder** only (starter) | 100 MUCHU/day (Jobs global money limit) |
| Depositor (cumulative deposits ≥ `DEPOSIT_GATE_MIN`, currently 25 MUCHU) | `default` + `depositor` (weight 10) | all 12: Brewer, Builder, Crafter, Digger, Enchanter, Explorer, Farmer, Fisherman, Hunter, Miner, Weaponsmith, Woodcutter | 100 MUCHU/day (same global cap) |

- The 100/day cap is `Limit.Money` in `server/plugins/Jobs/generalConfig.yml`
  (`MoneyLimit: '100'`, `TimeLimit: 86400`) and applies to EVERY player — it is
  the emission budget from SPEC-TOKEN, not part of this gate.
- Starter job choice: Builder is the lowest-paying of the 12 loaded jobs by
  the income tables in `server/plugins/Jobs/jobs/*.yml` — avg 1.45 / max 7.50
  MUCHU per action over 169 paid actions (compare Fisherman avg 18.50,
  Woodcutter avg 8.75, Hunter avg 83.32), and placing blocks consumes
  resources, so it is a true trickle. Override with
  `STARTER_JOB=<job> scripts/lp-bootstrap.sh`.
- `max-jobs: 3` (generalConfig.yml) still limits depositors to 3 concurrent
  jobs; the gate controls WHICH jobs are joinable, not how many.

## Verified permission nodes (Jobs 5.2.6.3 + LuckPerms 5.5.53, live server)

The reliable primitive is **`jobs.join.<jobname lowercase>`**, checked together
with the global **`jobs.use`**. From the installed jar
(`JobsCommands.hasJobPermission` bytecode):

```
hasJobPermission(sender, job) =
    sender.hasPermission("jobs.use")
 && sender.hasPermission("jobs.join." + job.getName().toLowerCase())
```

Facts verified EMPIRICALLY with a throwaway LuckPerms group + a mineflayer bot
on the running server (each line was an actual test case):

- Jobs registers every `jobs.join.<job>` node with Bukkit
  `PermissionDefault.TRUE` (`PermissionHandler.registerPermissions`), so with
  no LuckPerms nodes set ANY player can join ANY job — the default group must
  explicitly NEGATE the non-starter jobs. (Bot joined Miner with zero LP nodes.)
- `lp group <g> permission set jobs.join.miner false` → `/jobs join miner`
  fails with "You don't have permission!";
  `lp user E2ETester permission check jobs.join.miner` → `Result: false,
  Cause: <group> has jobs.join.miner set to false in context global`.
- `jobs.use.<job>` is NOT a real node in this Jobs version: with
  `jobs.use.miner` set false the bot still joined Miner. Do not use it.
- `jobs.use` set false blocks ALL Jobs interaction (join denied) — and the
  payout path also requires it (`PermissionHandler.hasWorldPermission` checks
  `jobs.use` + `jobs.world.<world>`), so never negate `jobs.use`.
- **Join checks happen at `/jobs join` time only** (also gating what
  `/jobs browse`, `/jobs info` and the Jobs GUI show, via the same
  `hasJobPermission`). Payout time does NOT re-check `jobs.join.<job>`:
  negating the node while the bot was employed as Farmer did not fire it and
  `/jobs stats` still listed the job. A player stays in (and keeps earning
  from) jobs joined before a negation lands — acceptable here because
  promotion is one-way, but remember `lp user <name> parent add depositor`
  must land BEFORE the player tries to join a non-starter job, not before
  they earn.
- Group precedence: users inherit `default` (negations) AND `depositor`
  (grants). `depositor` carries **weight 10** so its `true` nodes out-weigh
  the default group's `false` nodes — verified live: a default-only bot was
  denied Brewer; after `lp user ... parent add depositor` the same bot joined
  Brewer immediately (no relog needed).

### RCON + LuckPerms gotcha

LuckPerms executes commands asynchronously: over RCON its output NEVER comes
back in the response packet (commands still execute). `lp user <name> parent
info` via RCON returns an empty string. To verify LuckPerms state
non-interactively use `lp export <name>` (writes
`server/plugins/LuckPerms/<name>.json.gz`) and inspect the JSON — this is
exactly what `scripts/lp-bootstrap.sh` does to self-verify. From in-game chat
(a real player/bot with `luckperms.user.permission.check`) output is visible.

## Bootstrap (fresh installs)

After the server's FIRST boot (LuckPerms + Jobs must have generated their
data), run the idempotent bootstrap against the running server:

```
scripts/lp-bootstrap.sh          # STARTER_JOB=builder by default
```

It enumerates the loaded jobs from `server/plugins/Jobs/jobs/*.yml`, applies
the nodes below via RCON (creds from root `.env`), then self-verifies via
`lp export`. Re-running always converges. Equivalent raw console/RCON
commands:

```
lp creategroup depositor
lp group depositor setweight 10
lp group depositor permission set jobs.join.<job> true     # for each of the 12 jobs
lp group default permission set jobs.join.builder true     # the starter job
lp group default permission set jobs.join.<job> false      # every other job
```

## Promotion flow (gateway)

- `gateway/src/token/rcon-gate.js` exports `promoteToDepositor(username)`:
  lazy RCON connection, sends `lp user <username> parent add depositor`,
  3s timeouts, never throws, logs delivery/failure. Wired into the deposits
  watcher via `attachDeposits({..., promoteToDepositor})` in
  `gateway/src/index.js`.
- The watcher calls it when a user's cumulative credited deposits reach the
  gate, and again on every later credited deposit (idempotent insurance —
  re-adding an existing parent is a LuckPerms no-op).
- `lp user` resolves offline players from LuckPerms' own storage; it only
  fails (silently) for names that never joined the server. Such users are
  re-promoted by a later deposit tick.
- Demotion: none. `lp user <name> parent remove depositor` by hand if ever
  needed.

## Tuning DEPOSIT_GATE_MIN

`DEPOSIT_GATE_MIN` (root `.env`, MUCHU, default 25) is read by the gateway
deposits module at boot; the threshold is compared against each user's
CUMULATIVE credited deposits (sum over the `deposits` table, statuses
`credited`). To change it: edit `.env`, restart the gateway
(`./stop-all.sh && ./start-all.sh` or the integrator's flow). Notes:

- Raising it does NOT demote already-promoted players (one-way gate).
- Lowering it promotes existing users on their NEXT credited deposit (the
  check runs per credited deposit, not retroactively on boot).
- Keep it ≥ `DEPOSIT_MIN` (deposits below `DEPOSIT_MIN` are recorded as
  'dust' and never credited, so they never count toward the gate).
- Sizing intuition: at the 100 MUCHU/day cap, a 25 MUCHU gate is ~6 hours of
  capped Builder earnings — cheap enough to try, real enough to spam-filter.
