package com.muchucraft.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;

/**
 * Holds the deposit info the gateway pushes via POST /deposit-info and answers
 * the in-game /deposit command with it (SPEC-PHASE3 §1). Persisted to
 * plugins/MuchuBridge/deposit-info.json so a server restart keeps /deposit
 * working even before the gateway re-pushes (it only pushes when IT boots).
 * pageUrl (optional, may be absent in older persisted files) powers the
 * clickable "open the deposit page" line — the web page with QR & details.
 */
final class DepositInfo implements CommandExecutor {
    private final MuchuBridgePlugin plugin;
    private volatile Info info; // null until first push/load

    private record Info(String address, String minimum, String gateThreshold, String pageUrl, String withdrawUrl) {}

    DepositInfo(MuchuBridgePlugin plugin) {
        this.plugin = plugin;
    }

    private Path file() {
        return plugin.getDataFolder().toPath().resolve("deposit-info.json");
    }

    /** Restore a previously pushed deposit-info from disk (best effort). */
    void load() {
        try {
            Path f = file();
            if (!Files.exists(f)) return;
            Object parsed = Json.parse(Files.readString(f, StandardCharsets.UTF_8));
            if (parsed instanceof Map<?, ?> m
                    && m.get("address") instanceof String address
                    && m.get("minimum") instanceof String minimum
                    && m.get("gateThreshold") instanceof String gateThreshold) {
                String pageUrl = m.get("pageUrl") instanceof String s ? s : null; // absent pre-pageUrl
                String withdrawUrl = m.get("withdrawUrl") instanceof String w ? w : null;
                info = new Info(address, minimum, gateThreshold, pageUrl, withdrawUrl);
                plugin.getLogger().info("deposit-info restored from disk (address " + address + ")");
            }
        } catch (Exception e) {
            plugin.getLogger().warning("could not restore deposit-info.json: " + e.getMessage());
        }
    }

    /** Store a validated push from the gateway and persist it (URLs may be null). */
    void set(String address, String minimum, String gateThreshold, String pageUrl, String withdrawUrl) {
        info = new Info(address, minimum, gateThreshold, pageUrl, withdrawUrl);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("address", address);
        out.put("minimum", minimum);
        out.put("gateThreshold", gateThreshold);
        if (pageUrl != null) out.put("pageUrl", pageUrl);
        if (withdrawUrl != null) out.put("withdrawUrl", withdrawUrl);
        try {
            Files.createDirectories(plugin.getDataFolder().toPath());
            Files.writeString(file(), Json.write(out), StandardCharsets.UTF_8);
        } catch (IOException e) {
            plugin.getLogger().warning("could not persist deposit-info.json: " + e.getMessage());
        }
        plugin.getLogger().info("deposit-info set: address=" + address
                + " minimum=" + minimum + " gateThreshold=" + gateThreshold
                + (pageUrl != null ? " pageUrl=" + pageUrl : "")
                + (withdrawUrl != null ? " withdrawUrl=" + withdrawUrl : ""));
    }

    private static final Component PREFIX = Component.text("[MuchuCraft] ", NamedTextColor.AQUA);

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        Info current = info;
        boolean isWithdraw = command.getName().equalsIgnoreCase("withdraw");
        if (current == null) {
            sender.sendMessage(PREFIX.append(Component.text(
                    (isWithdraw ? "Withdrawals" : "Deposits") + " are not configured yet — try again in a minute.",
                    NamedTextColor.GRAY)));
            return true;
        }
        if (isWithdraw) {
            sender.sendMessage(PREFIX.append(Component.text(
                    "Withdraw your in-game MUCHU to your bound wallet:", NamedTextColor.GRAY)));
            if (current.withdrawUrl() != null) {
                sender.sendMessage(Component.text("Open the withdraw page →", NamedTextColor.LIGHT_PURPLE)
                        .decorate(TextDecoration.UNDERLINED)
                        .clickEvent(ClickEvent.openUrl(current.withdrawUrl()))
                        .hoverEvent(Component.text(current.withdrawUrl(), NamedTextColor.GRAY)));
            } else {
                sender.sendMessage(Component.text(
                        "Open the wallet page where you signed in and use the Withdraw card.", NamedTextColor.GRAY));
            }
            return true;
        }
        sender.sendMessage(PREFIX.append(Component.text(
                "Send MUCHU from your bound wallet to the treasury address:", NamedTextColor.GRAY)));
        sender.sendMessage(Component.text(current.address(), NamedTextColor.GREEN));
        sender.sendMessage(Component.text("Minimum ", NamedTextColor.GRAY)
                .append(Component.text(current.minimum() + " MUCHU", NamedTextColor.WHITE))
                .append(Component.text(". Send only from your bound wallet.", NamedTextColor.GRAY)));
        if (current.pageUrl() != null) {
            sender.sendMessage(Component.text("Open the deposit page — QR & details", NamedTextColor.LIGHT_PURPLE)
                    .decorate(TextDecoration.UNDERLINED)
                    .clickEvent(ClickEvent.openUrl(current.pageUrl()))
                    .hoverEvent(Component.text(current.pageUrl(), NamedTextColor.GRAY)));
        }
        return true;
    }
}
