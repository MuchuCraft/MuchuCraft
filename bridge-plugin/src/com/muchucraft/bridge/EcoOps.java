package com.muchucraft.bridge;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import net.milkbowl.vault.economy.Economy;
import net.milkbowl.vault.economy.EconomyResponse;
import org.bukkit.OfflinePlayer;
import org.bukkit.plugin.RegisteredServiceProvider;

/**
 * All Vault economy access. Every operation hops to the main thread via
 * callSyncMethod, so each op (e.g. has()+withdrawPlayer) is atomic with respect
 * to every other economy mutation. Amounts are BigDecimal at our boundary;
 * Vault's API itself is double-based, so the conversion happens exactly here.
 */
final class EcoOps {
    private static final long SYNC_TIMEOUT_SECONDS = 10;
    private final MuchuBridgePlugin plugin;

    EcoOps(MuchuBridgePlugin plugin) {
        this.plugin = plugin;
    }

    String providerName() {
        return sync(() -> eco().getName());
    }

    BigDecimal balance(String name) {
        return sync(() -> BigDecimal.valueOf(eco().getBalance(player(name))));
    }

    /** Atomic has()+withdrawPlayer on the main thread. Returns the new balance. */
    BigDecimal debit(String name, BigDecimal amount) {
        return sync(() -> {
            Economy eco = eco();
            OfflinePlayer p = player(name);
            double amt = amount.doubleValue();
            if (!eco.has(p, amt)) throw new ApiError(409, "insufficient");
            EconomyResponse r = eco.withdrawPlayer(p, amt);
            if (!r.transactionSuccess()) throw new ApiError(500, "economy error: " + r.errorMessage);
            return BigDecimal.valueOf(eco.getBalance(p));
        });
    }

    /** depositPlayer on the main thread. Returns the new balance. */
    BigDecimal credit(String name, BigDecimal amount) {
        return sync(() -> {
            Economy eco = eco();
            OfflinePlayer p = player(name);
            EconomyResponse r = eco.depositPlayer(p, amount.doubleValue());
            if (!r.transactionSuccess()) throw new ApiError(500, "economy error: " + r.errorMessage);
            return BigDecimal.valueOf(eco.getBalance(p));
        });
    }

    /** Balances for every known player in the list (unknowns skipped), one main-thread hop. */
    Map<String, BigDecimal> balances(List<String> names) {
        return sync(() -> {
            Economy eco = eco();
            Map<String, BigDecimal> out = new LinkedHashMap<>();
            for (String name : names) {
                OfflinePlayer p = plugin.getServer().getOfflinePlayerIfCached(name);
                if (p == null) continue;
                out.put(name, BigDecimal.valueOf(eco.getBalance(p)));
            }
            return out;
        });
    }

    // ---- main-thread helpers (only call from inside sync()) ----

    private Economy eco() {
        RegisteredServiceProvider<Economy> reg =
                plugin.getServer().getServicesManager().getRegistration(Economy.class);
        if (reg == null) throw new ApiError(503, "economy unavailable");
        return reg.getProvider();
    }

    private OfflinePlayer player(String name) {
        OfflinePlayer p = plugin.getServer().getOfflinePlayerIfCached(name);
        if (p == null) throw new ApiError(404, "unknown player");
        return p;
    }

    private <T> T sync(Callable<T> job) {
        Future<T> future = plugin.getServer().getScheduler().callSyncMethod(plugin, job);
        try {
            return future.get(SYNC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            future.cancel(false);
            throw new ApiError(503, "server busy");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiError(503, "interrupted");
        } catch (ExecutionException e) {
            if (e.getCause() instanceof ApiError apiError) throw apiError;
            throw new RuntimeException(e.getCause());
        }
    }
}
