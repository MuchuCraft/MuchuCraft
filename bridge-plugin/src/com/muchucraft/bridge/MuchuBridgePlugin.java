package com.muchucraft.bridge;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * MuchuBridge: exposes the Vault economy over localhost HTTP so the MuchuCraft
 * gateway can read balances and execute debits/credits (1:1 MUCHU token economy).
 * Binds 127.0.0.1 only; every request requires "Authorization: Bearer BRIDGE_TOKEN".
 */
public final class MuchuBridgePlugin extends JavaPlugin {
    private HttpServer http;
    private ExecutorService pool;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        int port = getConfig().getInt("port", 8091);
        String token = getConfig().getString("token", "");
        if (token == null || token.isBlank()) {
            getLogger().severe("No bridge token in plugins/MuchuBridge/config.yml - refusing to start (run start-all.sh to template it from .env).");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        try {
            http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        } catch (IOException e) {
            getLogger().severe("Could not bind 127.0.0.1:" + port + ": " + e.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        pool = Executors.newFixedThreadPool(4, r -> {
            Thread t = new Thread(r, "MuchuBridge-http");
            t.setDaemon(true);
            return t;
        });
        http.setExecutor(pool);
        http.createContext("/", new BridgeHandler(this, token.getBytes(StandardCharsets.UTF_8)));
        http.start();
        getLogger().info("Bridge listening on 127.0.0.1:" + port);
    }

    @Override
    public void onDisable() {
        if (http != null) {
            http.stop(0);
            http = null;
        }
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
    }
}
