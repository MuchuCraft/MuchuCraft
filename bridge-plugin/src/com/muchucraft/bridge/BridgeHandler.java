package com.muchucraft.bridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The whole HTTP contract (gateway ⇄ plugin), all under one root context so
 * unknown paths are exact-match 404s:
 *   GET  /health            → {ok:true, economy:"<provider>"}
 *   GET  /balance?player=N  → {player, balance:"123.45"} | 404 if never joined
 *   POST /debit  {player, amount, ref} → {ok:true, newBalance} | 409 insufficient
 *   POST /credit {player, amount, ref} → {ok:true, newBalance}
 *   POST /balances {players:[...]}     → {balances:{name:"12.34", ...}}
 *   POST /deposit-info {address, minimum, gateThreshold, pageUrl?} → {ok:true}  (powers /deposit)
 * Every request needs "Authorization: Bearer BRIDGE_TOKEN" (constant-time compare).
 */
final class BridgeHandler implements HttpHandler {
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final Pattern AMOUNT = Pattern.compile("^[0-9]{1,12}(\\.[0-9]{1,6})?$");
    private static final Pattern PLAYER = Pattern.compile("^[A-Za-z0-9_]{1,16}$");
    private static final Pattern ADDRESS = Pattern.compile("^[1-9A-HJ-NP-Za-km-z]{32,44}$"); // base58 pubkey
    private static final Pattern PAGE_URL = Pattern.compile("^https?://[^\\s\"<>\\\\]{1,300}$"); // deposit web page

    private final MuchuBridgePlugin plugin;
    private final EcoOps eco;
    private final byte[] token;
    private final DepositInfo deposits;

    BridgeHandler(MuchuBridgePlugin plugin, byte[] token, DepositInfo deposits) {
        this.plugin = plugin;
        this.eco = new EcoOps(plugin);
        this.token = token;
        this.deposits = deposits;
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        try (ex) {
            if (!authorized(ex)) {
                send(ex, 401, Json.error("unauthorized"));
                return;
            }
            try {
                route(ex);
            } catch (ApiError e) {
                send(ex, e.status, Json.error(e.getMessage()));
            } catch (Exception e) {
                plugin.getLogger().warning("bridge internal error on " + ex.getRequestURI().getPath() + ": " + e);
                send(ex, 500, Json.error("internal error"));
            }
        }
    }

    private void route(HttpExchange ex) throws IOException {
        switch (ex.getRequestURI().getPath()) {
            case "/health" -> {
                requireMethod(ex, "GET");
                send(ex, 200, Json.write(Map.of("ok", true, "economy", eco.providerName())));
            }
            case "/balance" -> {
                requireMethod(ex, "GET");
                String player = requirePlayerName(queryParam(ex, "player"));
                send(ex, 200, Json.write(Map.of("player", player, "balance", eco.balance(player).toPlainString())));
            }
            case "/debit" -> mutate(ex, true);
            case "/credit" -> mutate(ex, false);
            case "/balances" -> {
                requireMethod(ex, "POST");
                Object players = body(ex).get("players");
                if (!(players instanceof List<?> list)) throw new ApiError(400, "players must be an array");
                Map<String, Object> balances = new LinkedHashMap<>();
                eco.balances(list.stream()
                                .filter(p -> p instanceof String name && PLAYER.matcher(name).matches())
                                .map(p -> (String) p)
                                .toList())
                        .forEach((name, bal) -> balances.put(name, bal.toPlainString()));
                send(ex, 200, Json.write(Map.of("balances", balances)));
            }
            case "/deposit-info" -> {
                requireMethod(ex, "POST");
                Map<String, Object> body = body(ex);
                if (!(body.get("address") instanceof String address) || !ADDRESS.matcher(address).matches()) {
                    throw new ApiError(400, "missing or invalid address");
                }
                String minimum = requireAmountString(body.get("minimum"), "minimum");
                String gateThreshold = requireAmountString(body.get("gateThreshold"), "gateThreshold");
                // pageUrl is OPTIONAL (older gateways omit it): when present it must
                // be a plain http(s) URL — it becomes a clickable open_url line.
                String pageUrl = null;
                Object rawPageUrl = body.get("pageUrl");
                if (rawPageUrl != null) {
                    if (!(rawPageUrl instanceof String s) || !PAGE_URL.matcher(s).matches()) {
                        throw new ApiError(400, "pageUrl must be an http(s) URL");
                    }
                    pageUrl = s;
                }
                deposits.set(address, minimum, gateThreshold, pageUrl);
                send(ex, 200, Json.write(Map.of("ok", true)));
            }
            default -> throw new ApiError(404, "not found");
        }
    }

    /** Non-negative plain decimal string, ≤6 dp (zero allowed — it is a threshold, not a payment). */
    private static String requireAmountString(Object v, String field) {
        if (!(v instanceof String s) || !AMOUNT.matcher(s).matches()) {
            throw new ApiError(400, field + " must be a non-negative decimal string with at most 6 decimals");
        }
        return s;
    }

    /** POST /debit and /credit: {player, amount, ref}; ref is audit-logged only. */
    private void mutate(HttpExchange ex, boolean debit) throws IOException {
        requireMethod(ex, "POST");
        Map<String, Object> body = body(ex);
        String player = requirePlayerName(body.get("player") instanceof String s ? s : null);
        BigDecimal amount = parseAmount(body.get("amount"));
        String ref = body.get("ref") instanceof String s ? s : "(no ref)";
        String op = debit ? "debit" : "credit";
        try {
            BigDecimal newBalance = debit ? eco.debit(player, amount) : eco.credit(player, amount);
            plugin.getLogger().info(String.format("%s player=%s amount=%s ref=%s newBalance=%s",
                    op, player, amount.toPlainString(), ref, newBalance.toPlainString()));
            send(ex, 200, Json.write(Map.of("ok", true, "newBalance", newBalance.toPlainString())));
        } catch (ApiError e) {
            plugin.getLogger().info(String.format("%s player=%s amount=%s ref=%s FAILED %d %s",
                    op, player, amount.toPlainString(), ref, e.status, e.getMessage()));
            throw e;
        }
    }

    // ---- request plumbing ----

    private boolean authorized(HttpExchange ex) {
        String header = ex.getRequestHeaders().getFirst("Authorization");
        if (header == null || !header.startsWith("Bearer ")) return false;
        byte[] presented = header.substring("Bearer ".length()).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(presented, token); // constant-time for equal lengths
    }

    private static void requireMethod(HttpExchange ex, String method) {
        if (!method.equals(ex.getRequestMethod())) throw new ApiError(405, "method not allowed");
    }

    private static String requirePlayerName(String name) {
        if (name == null || !PLAYER.matcher(name).matches()) throw new ApiError(400, "missing or invalid player");
        return name;
    }

    /** Amounts are strictly positive plain decimal strings, ≤6 dp — never floats, never exponents. */
    private static BigDecimal parseAmount(Object v) {
        if (!(v instanceof String s) || !AMOUNT.matcher(s).matches()) {
            throw new ApiError(400, "amount must be a positive decimal string with at most 6 decimals");
        }
        BigDecimal amount = new BigDecimal(s);
        if (amount.signum() <= 0) throw new ApiError(400, "amount must be positive");
        return amount;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> body(HttpExchange ex) throws IOException {
        InputStream in = ex.getRequestBody();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) != -1) {
            if (buf.size() + n > MAX_BODY_BYTES) throw new ApiError(400, "body too large");
            buf.write(chunk, 0, n);
        }
        Object parsed;
        try {
            parsed = Json.parse(buf.toString(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            throw new ApiError(400, "invalid JSON");
        }
        if (!(parsed instanceof Map)) throw new ApiError(400, "expected a JSON object");
        return (Map<String, Object>) parsed;
    }

    private static String queryParam(HttpExchange ex, String key) {
        String query = ex.getRequestURI().getRawQuery();
        if (query == null) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            if (k.equals(key)) {
                return eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static void send(HttpExchange ex, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(body);
        }
    }
}
