# MuchuCraft — browser Minecraft with Solana wallet auth

Real Paper Minecraft server + real plugins, played in the browser via the open-source
(MIT) mcraft.fun web client, with Solana wallet signatures replacing AuthMe-style
`/register <password>` username registration.

## Architecture

```
Browser
 ├─ /login/            wallet-connect launcher (vanilla JS, no build step)
 ├─ /                  minecraft-web-client static dist (self-host bundle)
 └─ WS+HTTP /api/vm/net/*  ──► Gateway (Node, port 8080)
                                ├─ /api/auth/*   nonce + SIWS verify + sessions (SQLite)
                                ├─ net proxy     validates Bearer session token,
                                │                sniffs MC Login Start username,
                                │                pipes WS bytes ⇄ TCP
                                └─ RCON client   in-game welcome messages
                                        │
                                        ▼ TCP 127.0.0.1:25565 (localhost-only)
                               Paper server (offline-mode)
                               plugins: EssentialsX, LuckPerms, WorldEdit,
                                        Vault, ViaVersion, Chunky
```

Why a proxy: browsers cannot open TCP. The web client runs mineflayer in the browser
with Node's `net` shimmed to speak an HTTP+WebSocket protocol to a proxy. We implement
that proxy ourselves so we can enforce wallet auth on every connection.

Security model: the Paper server binds to 127.0.0.1 and runs offline-mode, so the ONLY
way in is through the gateway proxy, which requires a valid wallet-backed session token
AND a Minecraft username matching that session. Wallet signature ⇒ username ownership.

## Layout & ownership (one agent per area; do not touch other areas)

```
/home/ubuntu/cookieclickersol/
├── .env .env.example          # shared config (already created)
├── SPEC.md                    # this file
├── client/                    # self-host bundle: dist/ + NOTES.md   [client agent]
├── server/                    # setup.sh start.sh paper.jar plugins/ [server agent]
├── gateway/
│   ├── package.json           # already created; deps preinstalled
│   ├── src/
│   │   ├── config.js db.js siws.js auth-routes.js index.js   [auth agent]
│   │   ├── netproxy.js mcsniff.js rcon.js                    [proxy agent]
│   ├── public/login/          # launcher page                       [launcher agent]
│   └── test/
│       ├── siws.test.js db.test.js auth-routes.test.js       [auth agent]
│       └── mcsniff.test.js netproxy.test.js                  [proxy agent]
├── e2e/                       # package.json created; deps preinstalled
│   ├── fakewallet.js wsclient.js run-e2e.js                  [testbot agent]
├── start-all.sh stop-all.sh README.md                        [written last]
```

Conventions: ESM everywhere (`"type": "module"`), Node 24, tests with `node:test` +
`node:assert/strict`, runnable via `npm test` (`node --test test/`). No TypeScript.
No new dependencies without need — SQLite comes from builtin `node:sqlite`
(`DatabaseSync`; if it proves unusable, fall back to better-sqlite3 and say so).
Env loading: `process.loadEnvFile(path)` in try/catch (root `.env`), never dotenv.
API errors: JSON `{ "error": "<human message>" }` with proper HTTP status.
Log lines: `[gateway] ...`, `[proxy] ...`, `[auth] ...`.

## Shared config (.env at repo root — already generated)

```
PORT=8080                 # gateway HTTP+WS port
MC_HOST=127.0.0.1
MC_PORT=25565
MC_VERSION=1.21.11        # client agent MUST correct this to the max version the
                          # shipped client build supports; server agent reads it
RCON_PORT=25575
RCON_PASSWORD=<generated>
SESSION_TTL_HOURS=24
SIWS_DOMAIN=localhost:8080   # domain embedded in signed messages; must match page host
SIWS_URI=http://localhost:8080/login/
DB_PATH=gateway/data/muchucraft.db
MC_SEED=                  # server agent fills with a scenic 1.21 seed
```

## Proxy wire protocol (client ⇄ gateway) — MUST match the real client

Source of truth: the shipped client. The client agent verifies each detail against the
bundled `server.js` + `dist/` in self-host.zip and records exact findings (JSON keys,
status codes, paths, headers, config.json keys) in `client/NOTES.md`. The proxy agent
implements to this spec, then reconciles against NOTES.md. Expected shape (from
research against zardoy/prismarinejs-net-browserify api.js):

1. `POST /api/vm/net/connect` — JSON body `{host, port}`; browser sends header
   `Authorization: Bearer <token>` where `<token>` is the page's `?token=` query param.
   - Validate: token must be an unexpired session (see DB). Otherwise **403** JSON error.
   - Ignore requested host/port destination except for logging — ALWAYS dial
     `MC_HOST:MC_PORT` (allowlist enforcement by construction).
   - On success reply `{token: <fresh random 32-byte hex CONNECTION token>, remote: "<host>:<port>"}`.
     The connection token is single-use, expires in 30s if unclaimed, and is unrelated
     to the session token.
   - `GET /api/vm/net/connect` = health/info JSON (200) — client may use it to probe the proxy.
2. `WS /api/vm/net/socket?token=<connection token>` — binary frames piped byte-for-byte
   ⇄ TCP socket to the Paper server. Text frame `proxy-shutdown:<reason>` sent to the
   browser before server-side close. Unknown/expired token ⇒ close immediately.
3. `WS /api/vm/net/ping` — text frames `ping:<id>` answered with `pong:<id>` (latency UI).
4. CORS: same-origin deployment, but still answer preflights and allow the
   `Authorization` + `Content-Type` headers (client may send them cross-origin).

### Username enforcement (login sniffer) — mcsniff.js

Buffer browser→server bytes (do NOT forward yet) and parse the first Minecraft frames
(uncompressed & unencrypted at this stage; offline mode never enables encryption and
compression only starts after the server's Set Compression packet):

- Frame = `[VarInt length][payload]`; payload = `[VarInt packetId]...`
- Frame 1 — Handshake (id 0x00): `[VarInt protocolVersion][String serverAddress][u16 port][VarInt nextState]`
  (String = VarInt byte-length + UTF-8 bytes.)
- nextState 1 (status ping): no username involved — flush buffer, pipe freely.
- nextState 2 (login) or 3 (transfer): Frame 2 — Login Start (id 0x00):
  `[String name (≤16)][16-byte UUID]`. Extract `name`.
  - `name === session.username` (exact match) ⇒ flush buffered bytes to TCP and pipe.
  - mismatch ⇒ text frame `proxy-shutdown:username does not match your wallet session`,
    close WS and TCP. Log it.
- Safety rails: if >4096 bytes buffered or >10s elapsed without a verdict ⇒ kill.
- VarInts are ≤5 bytes; handle frames split across WS messages (stream, not per-message).
- mcsniff.js exports a pure incremental parser: `createLoginSniffer()` with
  `.push(buf)` → `{verdict: 'pending'|'status'|'login', username?}` so it is unit-testable
  with byte streams split at every possible boundary.

## Auth flow (SIWS-style)

Launcher page flow: connect wallet → enter username → sign → play.

1. `POST /api/auth/nonce` `{username, address}` →
   `{message, nonce, expiresAt, mode: "register"|"login"}`
   - username must match `^[A-Za-z0-9_]{3,16}$`; address must be valid base58 32 bytes.
   - If username already bound to a DIFFERENT wallet ⇒ **409** `{error}` (no nonce).
   - Server constructs the message (client NEVER builds it):

```
${SIWS_DOMAIN} wants you to sign in with your Solana account:
${address}

Sign in to MuchuCraft to play Minecraft as "${username}". This request will not trigger a blockchain transaction or cost any fees.

URI: ${SIWS_URI}
Version: 1
Chain ID: mainnet
Nonce: ${nonce}
Issued At: ${issuedAtISO}
Expiration Time: ${expiresAtISO}
```

   - nonce = 16 random bytes hex; stored with username/address/message; expires in 5 min;
     single use (atomically consumed on first verify attempt, success OR failure).
2. Wallet signs the exact message bytes (UTF-8).
3. `POST /api/auth/verify` `{nonce, address, signature, signedMessage?}`
   - `signature`: base58 string OR array of numbers (launcher sends `Array.from(sig)`).
   - Primary check: `nacl.sign.detached.verify(utf8(message), sig, bs58.decode(address))`.
   - Fallback (Ledger/Solflare off-chain header): if `signedMessage` (number array)
     provided, accept iff signedMessage CONTAINS the exact UTF-8 message bytes as a
     contiguous subsequence AND the signature verifies over signedMessage.
   - On success: upsert user (first verify claims the username for that wallet — unique,
     case-insensitive), mint session `{token: 32B hex, expiresAt: now+SESSION_TTL_HOURS}`,
     reply `{token, username, address, expiresAt, playUrl}` where
     `playUrl = /?ip=${MC_HOST}:${MC_PORT}&version=${MC_VERSION}&username=${username}&token=${token}&autoConnect=true&lockConnect=true`
4. `GET /api/auth/session` (Bearer) → `{username, address, expiresAt}` or 401 (lets the
   launcher resume from a localStorage token without re-signing).
5. `GET /api/auth/username/:name` → `{status: "available"|"taken", registered: bool}`
   (+`"yours"` when a valid Bearer token owns it) for live availability feedback.
6. Rate limit (tiny in-memory fixed-window, per IP): 10/min for nonce+verify, 60/min others.

## DB (node:sqlite, WAL, file from DB_PATH; mkdir -p its dir)

```sql
users    (id INTEGER PK, username TEXT UNIQUE COLLATE NOCASE, address TEXT NOT NULL,
          created_at INTEGER, last_login_at INTEGER)
nonces   (nonce TEXT PK, username TEXT, address TEXT, message TEXT,
          expires_at INTEGER, used INTEGER DEFAULT 0)
sessions (token TEXT PK, user_id INTEGER REFERENCES users(id), created_at INTEGER,
          expires_at INTEGER, revoked INTEGER DEFAULT 0)
```

db.js exposes small explicit functions (createNonce, consumeNonce, getUserByName,
claimUsername, createSession, getSession, ...) — no ORM. All timestamps ms epoch.
Periodic cleanup of expired nonces/sessions (setInterval, unref'd).

## RCON (rcon.js — best-effort, failures logged, never fatal)

`rcon-client` to 127.0.0.1:RCON_PORT with RCON_PASSWORD. On a proxy connection that
passes the username sniff, ~4s later send:
`tellraw <name> {"text":"[MuchuCraft] ","color":"aqua","extra":[{"text":"Wallet verified: <addr4>…<addr4>","color":"gray"}]}`
On first-ever login of a user additionally broadcast
`tellraw @a {"text":"<name> claimed their username with a Solana wallet ✔","color":"green"}`.
Reconnect lazily per command; 3s timeout; queue-less (drop on failure).

## Static serving (index.js)

- `/login/` → express.static(gateway/public/login).
- `/` → express.static(client/dist) with headers on every response:
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`
  (client needs SharedArrayBuffer; verify exact header set the bundled server.js uses —
  see client/NOTES.md).
- `GET /config.json` (before static): dist/config.json deep-merged with
  `{"defaultProxy": "", "allowAutoConnect": true}` (exact keys per NOTES.md).
- Bare `GET /` or `/index.html` with NO `ip`/`token` query params → 302 `/login/`.
- compression() for static; NOT for WS.
- `GET /healthz` → `{ok: true, mc: <tcp dial check of MC_HOST:MC_PORT>}`.

## Paper server (server/) — setup.sh is idempotent, start.sh runs it

- Read MC_VERSION from root .env. Download Paper via fill API
  (`https://fill.papermc.io/v3/projects/paper/versions/<ver>/builds/latest` →
  `downloads["server:default"].url` + sha256; VERIFY the sha256).
- Plugins into server/plugins/ (Modrinth API for the pinned MC_VERSION; research-verified
  1.21.11 URLs exist for EssentialsX 2.22.0, LuckPerms 5.5.53, WorldEdit 7.4.4,
  ViaVersion 5.10.0, Chunky 1.4.40, Vault 1.7.3 from GitHub w/ -L; re-resolve if the
  pinned version differs).
- eula.txt `eula=true`. server.properties from .env:
  `online-mode=false`, `server-ip=127.0.0.1`, `server-port=MC_PORT`,
  `enforce-secure-profile=false`, `enable-rcon=true`, `rcon.port`, `rcon.password`,
  `network-compression-threshold=-1`, `view-distance=10`, `simulation-distance=8`,
  `spawn-protection=0`, `motd=§b§lMuchuCraft§r §7- wallet-verified Minecraft`,
  `level-seed=MC_SEED` (pick a documented scenic seed for this MC version and write it
  to .env), `max-players=50`.
- start.sh: `exec java -Xms4G -Xmx8G <Aikar G1GC flags> -jar paper.jar nogui`.
- Setup must VALIDATE: boot once in background, wait for `Done (`... in logs/latest.log,
  verify RCON responds (`list`), pregenerate spawn (`chunky radius 400; chunky start`,
  wait for completion in log or ~3 min cap), then `stop` via RCON and wait for exit.

## E2E (e2e/) — proves the whole stack with no browser

- fakewallet.js: tweetnacl keypair; `address` (bs58 pubkey), `signMessage(str)` → sig.
- wsclient.js: dials the gateway EXACTLY like the browser: POST /connect with
  `Authorization: Bearer`, get connection token, open WS /socket?token, wrap with
  `createWebSocketStream` → binary duplex.
- run-e2e.js (assumes gateway+server already running; check /healthz first):
  1. nonce→sign→verify for user `E2ETester` → session token.
  2. mineflayer bot (auth 'offline', version MC_VERSION, custom `connect:` using
     wsclient) → expect `spawn` event within 60s, send a chat line, disconnect cleanly.
  3. Negative: no/garbage Bearer on /connect → 403.
  4. Negative: valid session for `E2ETester` but bot logs in as `Impostor` → connection
     killed (never spawns; expect proxy-shutdown/close within 15s).
  5. Negative: second keypair asks nonce for `E2ETester` → 409.
  6. Negative: replayed nonce verify → 4xx.
  Exit 0/1 with a clear PASS/FAIL summary per case.

## Launcher page (gateway/public/login/) — vanilla JS, dark Solana-styled

- Wallet discovery: Wallet Standard two-way handshake (dispatch
  `wallet-standard:app-ready`, listen `wallet-standard:register-wallet`) as primary;
  filter wallets exposing `standard:connect` + `solana:signMessage` + a `solana:` chain;
  legacy fallback `window.phantom?.solana` / `window.solflare` / `window.backpack`
  (poll briefly after load). Render one button per wallet (name + icon).
- Flow: connect → username input (live availability via API, regex-validated) →
  "Sign & Play" → POST nonce → sign exact `message` string (legacy:
  `provider.signMessage(new TextEncoder().encode(message), 'utf8')`; wallet-standard:
  `features['solana:signMessage'].signMessage({account, message})`, send back its
  `signedMessage` too) → POST verify (signature as `Array.from(...)` number array) →
  store token in localStorage → redirect to `playUrl`.
- On load with stored token: GET /api/auth/session → show "Continue as <name>" + Play
  button (no re-sign) + logout. Handle rejection (code 4001) and no-wallet-found states
  with friendly copy. Show the full message text before signing (details/expandable).
- No frameworks, no build. Files: index.html, app.js, style.css.
