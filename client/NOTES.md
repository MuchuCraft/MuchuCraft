# client/NOTES.md — verified facts about the shipped web client bundle

Everything below was verified by reading the actual files in this directory
(`server.js`, `dist/*`) from the self-host bundle. Line numbers refer to
`client/server.js` (the esbuild bundle) as unpacked here.

## 1. Bundle provenance

- Source: `https://github.com/zardoy/minecraft-web-client/releases/latest/download/self-host.zip`
- Release tag: **v2.0.1** (GitHub API `releases/latest` → `"tag_name": "v2.0.1"`,
  published `2026-06-13T15:51:47Z`). `dist/release.json` agrees:
  `{"latestTag":"v2.0.1", ..., "previousTag":"v2.0.0"}`; `dist/version.txt` = `2026-06-13T15`.
- zip: 18,132,589 bytes, sha256 `ab02f8200a1cee0a32dd9715f9e78bb30fe9c0889a7b46c11d158f044d751197`.
- Layout after unzip: `client/dist/` (static app, ~79 MB) and `client/server.js`
  (2.2 MB esbuild bundle of express + compression + cors + express-ws +
  `zardoy/prismarinejs-net-browserify` `api.js` — the reference proxy).

## 2. Pinned Minecraft version → MC_VERSION=1.21.11

The shipped dist bundles minecraft-protocol's version module with 1.21.11 as the
**default and newest** supported Java version (`dist/static/js/945.b3f6f1ee.js`):

```js
m.exports={defaultVersion:"1.21.11",supportedVersions:["1.7","1.8.8","1.9.4","1.10.2",
"1.11.2","1.12.2","1.13.2","1.14.4","1.15.2","1.16.5","1.17.1","1.18.2","1.19","1.19.2",
"1.19.3","1.19.4","1.20","1.20.1","1.20.2","1.20.4","1.20.6","1.21.1","1.21.3","1.21.4",
"1.21.5","1.21.6","1.21.8","1.21.9","1.21.11"]}
```

Protocol data for it is present too:

```js
{"minecraftVersion":"1.21.11","version":774,"dataVersion":4671,"usesNetty":true,...}
```

(The repo README's "1.8–1.21.5" is stale for this build. The `1.21.20+` strings that
also appear in bundles are Bedrock version data, irrelevant for Java server play.
A second, shorter `supportedVersions=["1.8.8",...,"1.18.2"]` array in the same bundle
is flying-squid's built-in *singleplayer server* list, not the client protocol list.)

Paper cross-check: `https://fill.papermc.io/v3/projects/paper/versions/1.21.11/builds/latest`
returns a **STABLE** build:

```json
{"id":132,"channel":"STABLE","downloads":{"server:default":{"name":"paper-1.21.11-132.jar",
 "checksums":{"sha256":"5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"},...}}}
```

Newest version supported by BOTH = **1.21.11** → root `.env` line set to `MC_VERSION=1.21.11`.

## 3. Proxy wire protocol (from `server.js` = net-browserify `api.js`)

Mount root (server.js:25442): `var urlRoot = options.urlRoot || "/api/vm/net";`

### 3.1 POST /api/vm/net/connect

Client request (dist `945.b3f6f1ee.js`): `method:"POST"`, header
`Content-Type: application/json`, plus every entry of `getProxy().headers`
(this is where `Authorization` arrives), body = `JSON.stringify(m)` where `m`
is the net.connect options object — i.e. it contains **`host` and `port`** keys
(plus other harmless option keys minecraft-protocol passes through):

```js
er.setHeader("Content-Type","application/json"),
Object.entries(getProxy().headers).forEach(([m,x])=>{er.setHeader(m,x)}),
er.write(JSON.stringify(m)),er.end()
```

The `Authorization` header value is built from the page's `?token=` query param
(dist `index.e3d79375.js`):

```js
var getDefaultProxyParams=function(){var e;return{headers:{Authorization:
"Bearer ".concat(null!=(e=new URLSearchParams(location.search).get("token"))?e:"")}}}
```

Server behavior (server.js:25489–25597):

- missing host/port → **400** `{code:400, error:"No host and port specified"}`
- `options.validate(req,res)` hook: falsy/throws →
  **403** `{code:403, error:"You are not allowed to connect to this server"}` or
  **500** `{code:500, error:"Internal server error at validation step"}`
- `options.to` allowlist mismatch → **403** `{code:403, error:"Destination not allowed"}`
- TCP dial errors → **502** `{code:502, error:"Socket error: "+err.code, details:err}`;
  dial timeout → **504** `{code:504, error:"Socket timed out. ..."}`
- **Success 200** (server.js:25545–25557):

```js
var token = generateToken();            // crypto.randomBytes(32).toString("hex")
sockets[token] = socket;
var remote = socket.address();          // {address, family, port} OBJECT
res.send({ token, remote });
```

  So the success JSON keys are exactly **`token`** (64 hex chars = 32 random bytes)
  and **`remote`**, where `remote` is the `net.Socket#address()` object
  `{address, family, port}`. The real client *depends on the object shape*
  (dist `945.b3f6f1ee.js`):

```js
O.remoteAddress=S.remote.address,O.remoteFamily=S.remote.family,
O.remotePort=S.remote.port,O._connectWebSocket(S.token,...)
```

- Error detection on the client is `void 0 !== S.error` and it renders
  `"Cannot open TCP connection ["+statusCode+"]: "+JSON.stringify(S.error)` —
  so any JSON body with an `error` key + non-2xx status is displayed fine.
- Client aborts the POST after **10 s** (`setTimeout(...,1e4)` →
  "Timeout for connecting to proxy ...").
- Unclaimed sockets/tokens in the reference impl are only reaped when the TCP
  socket times out (server.js:25487 `connectTimeout ?? timeout ?? 5e3`; the
  bundled launcher passes `timeout` = 10000 default, `--timeout`/`TIMEOUT` to
  override). There is **no explicit token TTL and no single-use marking**.

### 3.2 GET /api/vm/net/connect (health probe)

server.js:25585:

```js
res.json({code:200, description:"A proxy server for Minecraft web clients",
          time:Date.now(), processingTime:...});
```

The client really uses this: `fetch("<proxy>/api/vm/net/connect")` (plain GET,
**no Authorization header**) and treats a network failure as
"Selected proxy server ... most likely is down". Any 200 JSON works.

### 3.3 WS /api/vm/net/socket?token=<connection token> (data socket)

- Exact URL built by the client: `getProxyOrigin()+getProxy().path+"/socket?token="+m`
  → `ws(s)://<host>:<port>/api/vm/net/socket?token=<token>`. Query param name: **`token`**.
- server.js:25620–25626: unknown token ⇒ warn + `ws.close()` immediately (no frame).
- Binary piping: browser→server `socket.write(data,"binary")`; server→browser
  `ws.send(chunk,{binary:true})` — byte-for-byte, no framing added.
- **Text frames on the data socket** (both directions matter):
  - client→server `ping:<id>` is answered by the server *on this same socket* with
    `"pong:" + data.slice("ping:".length)` → exactly `pong:<id>` (server.js:25651–25653).
    The shipped client's latency UI uses THIS (not `/ping`):
    `bot._client.socket._ws.send("ping:".concat(t))` then matches
    `m.emit("pong",S.slice(5))` against the id — an extra `:<ms>` suffix would break it.
  - server→client `proxy-shutdown:<reason>` before close. Reference reasons
    (server.js:25455, 25686, 25693, 25702):
    - `proxy-shutdown:Proxy server is shutting down. ...` (SIGINT/SIGTERM)
    - `proxy-shutdown:Connection timed out. No packets were sent or received from either side in <n>ms.`
    - `proxy-shutdown:Minecraft server is not reachable anymore.` / `proxy-shutdown:Issue with the connection to the Minecraft server: <msg>`
    - `proxy-shutdown:Minecraft server closed the connection.`
    Client handling (dist `index.e3d79375.js`): reason = `e.slice(15)`
    (`"proxy-shutdown:".length`), shown as the disconnect reason.
  - The client also swallows `proxy-message*` and `proxy-command:*` text frames
    (reserved; anything else typed as text would be fed into the protocol stream):

```js
handleStringMessage=function(e){return!(e.startsWith("proxy-message")||
e.startsWith("proxy-command:"))&&(!e.startsWith("proxy-shutdown:")||(...,T=e.slice(15),!1))}
```

- Close symmetry (server.js:25699–25726): TCP `close` ⇒ send proxy-shutdown (if no
  reason sent yet) then `ws.close()`; WS `close` ⇒ `socket.end()`.

### 3.4 WS /api/vm/net/ping

server.js:25599–25619: answers text `ping:<id>` with
`ws.send("pong:" + pingId + ":" + <processingMs>)` — note the **extra `:<ms>` field**.
The shipped dist contains **no reference to the `/ping` endpoint** (the only
proxy paths in dist bundles are `path+"/connect"` and `path+"/socket?token="`);
in-game latency uses the data socket's ping/pong instead (3.3). Implementing
`/ping` is optional for this client build.

### 3.5 CORS

net-browserify's own middleware (server.js:25466–25485, active because the
launcher passes `allowOrigin:"*"`):

```js
res.header("Access-Control-Allow-Origin", allowOrigin);   // on /api/vm/net/* only
if (req.method.toUpperCase() == "OPTIONS") {
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");   // NO Authorization!
  res.header("Access-Control-Max-Age", 1728e3);
}
```

That list omits `Authorization`; cross-origin preflights only succeed because
server.js *also* mounts `app.use(cors())` (line 53945) before `netApi`, and the
`cors` package reflects `Access-Control-Request-Headers` and terminates OPTIONS
with 204. Takeaway for the gateway: answer preflights allowing at least
`Authorization, Content-Type` (SPEC is correct; do NOT copy only the netApi list).

## 4. Static serving by the bundled server.js

- `var isProd = process.argv.includes("--prod") || true;` (line 53937) — the
  `|| true` makes **prod mode unconditional** in this build; `--prod` is moot.
- Order: `compression()` → `cors()` → netApi (proxy) → `/config.json` route →
  COOP/COEP middleware → statics.
- Security headers set on **every** response in prod (lines 53976–53984):

```js
res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
if (req.path.endsWith(".wasm")) { res.setHeader("Content-Type", "application/wasm"); }
```

  (COOP `same-origin` + COEP `require-corp` = cross-origin isolation for
  SharedArrayBuffer. Don't forget the `application/wasm` content type —
  express usually gets it right from the extension, but the reference forces it.)
- Statics: `express.static("./public")` then `express.static("./dist")`; also
  `/wasm_mesher.js` + `/wasm_mesher_bg.wasm` served from the minecraft-renderer
  package if resolvable (those files already exist in `dist/` here). Default port 8080.

### 4.1 GET /config.json patching (lines 53954–53975)

```js
app.get("/config.json", (req, res, next) => {
  let config = {};  let publicConfig = {};
  try { config = require_config(); } catch { try { config = require_config2(); } catch {} }
  try { publicConfig = require("./public/config.json"); } catch {}
  res.json({ ...config, "defaultProxy": "",  // use current url (this server)
             ...publicConfig });
});
```

Facts: (a) base config is **baked into the bundle at build time**
(`config.json` / `dist/config.json` copies, identical to `client/dist/config.json`
whose upstream value is `"defaultProxy": "https://proxy.mcraft.fun"`);
(b) the merge is a **shallow spread**, not deep; (c) the ONLY key the server
forces is **`defaultProxy: ""`**; (d) operator overrides go in
`./public/config.json` and win.

### 4.2 config.json keys the gateway must serve

- **`defaultProxy: ""`** — empty string ⇒ same-origin proxy. Verified chain in dist:
  `getInitialProxies` only pushes a *truthy* `appConfig.defaultProxy`; with none and
  no `?proxy=` param, `setProxy({hostname:""})` keeps the built-in default
  `{hostname:window.location.hostname, port:window.location.port, path:"/api/vm/net"}`.
- **`allowAutoConnect: true`** — REQUIRED for `?autoConnect=true` to do anything.
  The client gates on it and it has **no default** (absent ⇒ falsy ⇒ no autoconnect;
  it is not in `dist/config.json` and the bundled server.js never sets it):

```js
if(ek.EX.autoConnect&&(null==(e=e1.N_.appConfig)?void 0:e.allowAutoConnect))
  return void src_connect({server:ek.EX.ip,proxy:getCurrentProxy(),
    botVersion:null!=(t=ek.EX.version)?t:void 0,username:getCurrentUsername(...
```

Recommended gateway response: `{...dist/config.json, defaultProxy: "", allowAutoConnect: true}`.

## 5. Query params the shipped client reads

Read through a Proxy over `new URLSearchParams(location.search)` (fallback:
`appConfig.appParams[key]`). Relevant ones, all verified in `index.e3d79375.js`:

| param | use |
|---|---|
| `token` | `Authorization: Bearer <token>` on POST /connect (and all proxy headers) — read directly, see 3.1 |
| `ip` | server address to connect to (`ek.EX.ip`, parsed by `parseServerAddress`) |
| `version` | protocol version for the bot (`botVersion:null!=(t=ek.EX.version)?t:void 0`) |
| `username` | in-game username (`ek.EX.username`) |
| `proxy` | overrides proxy selection (`getCurrentProxy()` prefers `ek.EX.proxy`) |
| `autoConnect` | truthy string + `appConfig.allowAutoConnect` ⇒ connect immediately |
| `lockConnect` | exact string compare `"true"===ek.EX.lockConnect` ⇒ hides server-edit UI |

(Extras that exist but we don't use: `alwaysReconnect`, `addPing`, `viewerWsConnect`, ...)

The SPEC `playUrl`
(`/?ip=...&version=...&username=...&token=...&autoConnect=true&lockConnect=true`)
matches all of the above.

## 6. Contradictions with SPEC.md

Sections under test: "Proxy wire protocol (client ⇄ gateway)" and "Static serving".

1. **`remote` is an object, not a string.** SPEC §Proxy-wire item 1 says the
   success reply is `{token: ..., remote: "<host>:<port>"}`. The reference server
   sends `remote = socket.address()` = `{address, family, port}` and the shipped
   client dereferences `S.remote.address / .family / .port` (see 3.1). A string
   would leave `bot._client.socket.remoteAddress` undefined (no crash, but it
   does not "match the real client"). Gateway should send the object form.
2. **`/ping` frame format + who uses it.** SPEC item 3 says `WS /api/vm/net/ping`
   answers `ping:<id>` with `pong:<id>` and calls it the latency UI. The bundled
   server answers `pong:<id>:<processingMs>` on `/ping` (extra field), and the
   shipped client never opens `/ping` at all — its latency UI pings over the
   **data socket**, where the reply is exactly `pong:<id>` (see 3.3/3.4). The
   gateway must implement `ping:`→`pong:<id>` on the DATA socket; `/ping` is
   optional (if implemented, either format is unobserved by this client).
3. **Connection-token lifecycle (single-use, 30s expiry) is not reference
   behavior.** SPEC item 1 states the token "is single-use, expires in 30s if
   unclaimed". The bundled server does neither: tokens live in `sockets{}` until
   the TCP socket ends (unclaimed ones die via the ~10s socket inactivity
   timeout), and a token is not consumed on WS attach. SPEC's stricter policy is
   fine (client-invisible) but it is a gateway invention, not "matching" behavior.
4. **CORS `Authorization` allowance.** SPEC item 4 (allow `Authorization` +
   `Content-Type`) is the right requirement, but note the reference netApi
   middleware itself only allows `Content-Type` on OPTIONS; `Authorization` works
   upstream only because of the extra `app.use(cors())` reflecting request
   headers (see 3.5). Implement SPEC's version, not a copy of the netApi headers.
5. **`config.json` merge: not deep, and `allowAutoConnect` is NOT set by the
   bundled server.** SPEC §Static-serving says dist/config.json is "deep-merged"
   with `{"defaultProxy": "", "allowAutoConnect": true}`. The reference does a
   shallow `{...config, defaultProxy:"", ...publicConfig}` and only forces
   `defaultProxy` (see 4.1). Adding `allowAutoConnect: true` is a MuchuCraft
   extension — and a mandatory one, since autoconnect is gated on it (see 4.2).
   A shallow merge is sufficient (both keys are top-level scalars).
6. **`--prod` is not actually a switch.** SPEC asks which headers server.js sets
   "in --prod mode"; in this build `isProd = process.argv.includes("--prod") || true`
   is always true, so COOP/COEP + statics are unconditional. Header names/values
   themselves match SPEC exactly (`Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Embedder-Policy: require-corp`).

Minor, not contradictions: reference error bodies carry an extra `code` key next
to `error` (SPEC's `{error}` shape is compatible — the client only requires the
`error` key); reference also sets `Content-Type: application/wasm` for `.wasm`
paths (SPEC doesn't mention it; harmless/recommended).
