/**
 * Core module: lumi_cmd
 * Provides the !lumi command — system status, module listing, task info,
 * and runtime log-level control.
 *
 * Registered via registerLumiCmd() rather than BotModule.register() because
 * it needs moduleInfo (available only after all modules have loaded) and
 * startedAt (process start timestamp).
 */

import { ModuleRegistry, ModuleInfo } from "../../registry";
import { logger, LogLevel } from "../../logger";
import { reloadEnv, envBool, BotConfig, isAdmin } from "../../config";
import type { PendingSas } from "../../lumi";

const ADMIN_ONLY = "⛔ This command requires admin privileges.";

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)}GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function registerLumiCmd(
  registry: ModuleRegistry,
  moduleInfo: ModuleInfo[],
  startedAt: number,
  pendingSas: Map<string, PendingSas>,
  config: BotConfig,
): void {
  registry.register({
    name: "lumi",
    module: "core",
    help: "Bot system info and module status",
    usage: "[modules|tasks|log|reload|verify [confirm|cancel <txnId>]]",
    description:
      "Without arguments shows a status overview with memory, E2EE, and room stats. " +
      "`!lumi modules` lists loaded modules. " +
      "`!lumi tasks` lists scheduled tasks. " +
      "`!lumi log` shows or changes runtime log levels. " +
      "`!lumi reload` re-reads .env (requires LUMI_ALLOW_ENV_RELOAD=true). " +
      "`!lumi verify` shows E2EE device fingerprint and cross-signing status. " +
      "`!lumi verify confirm <txnId>` confirms a pending SAS verification. " +
      "`!lumi verify cancel <txnId>` cancels a pending SAS verification.",
    handler: async (ctx) => {
      const sub = ctx.args[0]?.toLowerCase();
      const VALID: LogLevel[] = ["debug", "info", "warn", "error", "off"];

      if (sub === "verify" && (ctx.args[1] === "confirm" || ctx.args[1] === "cancel")) {
        if (!isAdmin(ctx.event.getSender(), config)) return ADMIN_ONLY;
        const action = ctx.args[1];
        const txnId = ctx.args[2];
        if (!txnId) return `Usage: \`!lumi verify ${action} <txnId>\``;
        const entry = pendingSas.get(txnId);
        if (!entry) return `No pending verification with ID \`${txnId}\`.`;
        clearTimeout(entry.timer);
        pendingSas.delete(txnId);
        if (action === "confirm") {
          await entry.sas.confirm();
          return `Verification confirmed for ${entry.request.otherUserId}.`;
        } else {
          entry.sas.cancel();
          return `Verification cancelled for ${entry.request.otherUserId}.`;
        }
      }

      if (sub === "verify") {
        const crypto = ctx.client.getCrypto();
        if (!crypto) return "E2EE is not enabled.";

        const lines: string[] = ["**E2EE device & cross-signing status**\n"];

        // Device identity keys
        try {
          const keys = await crypto.getOwnDeviceKeys();
          lines.push(`• Device ID: \`${ctx.client.getDeviceId() ?? "unknown"}\``);
          lines.push(`• Ed25519 fingerprint:`);
          lines.push(`  \`${keys.ed25519.match(/.{1,4}/g)?.join(" ") ?? keys.ed25519}\``);
          lines.push(`• Curve25519: \`${keys.curve25519.slice(0, 16)}…\``);
        } catch {
          lines.push("• Could not retrieve device keys.");
        }

        // Cross-signing status
        const xsStatus = await crypto.getCrossSigningStatus();
        lines.push(`\n**Cross-signing**`);
        lines.push(`• Public keys on device: ${xsStatus.publicKeysOnDevice ? "yes" : "no"}`);
        lines.push(`• Private keys in secret storage: ${xsStatus.privateKeysInSecretStorage ? "yes" : "no"}`);
        lines.push(`• Private keys cached locally: ${xsStatus.privateKeysCachedLocally?.masterKey ? "yes" : "no"}`);

        const xsReady = await crypto.isCrossSigningReady();
        lines.push(`• Ready: ${xsReady ? "yes" : "no"}`);

        return lines.join("\n");
      }

      if (sub === "reload") {
        if (!isAdmin(ctx.event.getSender(), config)) return ADMIN_ONLY;
        if (!envBool("LUMI_ALLOW_ENV_RELOAD")) {
          return "Env reload is disabled. Set `LUMI_ALLOW_ENV_RELOAD=true` in .env to enable it.";
        }
        const { changed, added } = reloadEnv();
        const lines: string[] = ["**.env reloaded.**"];
        if (changed.length) lines.push(`Changed: ${changed.join(", ")}`);
        if (added.length) lines.push(`Added: ${added.join(", ")}`);
        if (!changed.length && !added.length) lines.push("No changes detected.");
        lines.push("_Note: MATRIX_\\* credentials and values captured at startup require a restart._");
        return lines.join("\n");
      }

      if (sub === "log") {
        // !lumi log — show current levels
        if (ctx.args.length === 1) {
          const { global, overrides } = logger.getLevels();
          const lines = [`**Log levels:**\n• global: \`${global}\``];
          for (const [mod, lvl] of Object.entries(overrides)) {
            lines.push(`• ${mod}: \`${lvl}\``);
          }
          lines.push(`\nKnown modules: ${logger.knownModules().sort().join(", ")}`);
          lines.push(`Valid levels: ${VALID.join(", ")}`);
          return lines.join("\n");
        }

        // Changing levels (any arg past "log") is an admin-only mutation
        if (!isAdmin(ctx.event.getSender(), config)) return ADMIN_ONLY;

        // !lumi log <level>  — set global
        if (
          ctx.args.length === 2 &&
          VALID.includes(ctx.args[1]!.toLowerCase() as LogLevel)
        ) {
          const level = ctx.args[1]!.toLowerCase() as LogLevel;
          logger.setLevel(level);
          return `Global log level set to \`${level}\`.`;
        }

        // !lumi log <module> <level|reset>
        if (ctx.args.length === 3) {
          const mod = ctx.args[1]!.toLowerCase();
          const lvlArg = ctx.args[2]!.toLowerCase();
          if (lvlArg === "reset") {
            logger.setLevel(logger.getLevels().global, mod);
            return `Log level for \`${mod}\` reset to global (\`${logger.getLevels().global}\`).`;
          }
          if (VALID.includes(lvlArg as LogLevel)) {
            logger.setLevel(lvlArg as LogLevel, mod);
            return `Log level for \`${mod}\` set to \`${lvlArg}\`.`;
          }
        }

        return `Usage: \`!lumi log [<level> | <module> <level|reset>]\`\nLevels: ${VALID.join(", ")}`;
      }

      if (sub === "modules") {
        if (moduleInfo.length === 0) return "No modules loaded.";
        const lines = [`**Loaded modules (${moduleInfo.length}):**\n`];
        for (const m of moduleInfo) {
          const parts: string[] = [];
          if (m.commands.length)
            parts.push(`commands: ${m.commands.map((c) => `\`!${c}\``).join(", ")}`);
          if (m.tasks.length) parts.push(`tasks: ${m.tasks.join(", ")}`);
          if (m.replyHandlers.length)
            parts.push(`reply handlers: ${m.replyHandlers.join(", ")}`);
          lines.push(`• \`${m.file}\` — ${parts.join(" | ") || "no registrations"}`);
        }
        return lines.join("\n");
      }

      if (sub === "tasks") {
        const tasks = registry.taskInfo();
        if (tasks.length === 0) return "No scheduled tasks running.";
        const lines = [`**Scheduled tasks (${tasks.length}):**\n`];
        for (const t of tasks) {
          const interval =
            t.intervalSecs >= 3600
              ? `${t.intervalSecs / 3600}h`
              : t.intervalSecs >= 60
              ? `${t.intervalSecs / 60}m`
              : `${t.intervalSecs}s`;
          lines.push(
            `• \`${t.name}\` — every ${interval} → ${t.roomCount} room${t.roomCount === 1 ? "" : "s"}`
          );
        }
        return lines.join("\n");
      }

      // Default: status overview
      const uptime = formatUptime(Date.now() - startedAt);
      const tasks = registry.taskInfo();
      const replies = registry.replyHandlerNames();
      const mem = process.memoryUsage();
      const rooms = ctx.client.getRooms();

      // E2EE / device info
      const crypto = ctx.client.getCrypto();
      const deviceId = ctx.client.getDeviceId();
      const e2eeLines: string[] = [];
      if (crypto) {
        const [roomEncrypted, xsReady, xsStatus, keys] = await Promise.all([
          crypto.isEncryptionEnabledInRoom(ctx.roomId),
          crypto.isCrossSigningReady(),
          crypto.getCrossSigningStatus(),
          crypto.getOwnDeviceKeys().catch(() => null),
        ]);
        e2eeLines.push(`• Status: enabled`);
        e2eeLines.push(`• Device: \`${deviceId ?? "unknown"}\``);
        if (keys) {
          const fp = keys.ed25519.match(/.{1,4}/g)?.join(" ") ?? keys.ed25519;
          e2eeLines.push(`• Fingerprint: \`${fp}\``);
        }
        e2eeLines.push(`• SDK: ${crypto.getVersion()}`);
        e2eeLines.push(`• Cross-signing: ${xsReady ? "ready" : "not ready"}`);
        e2eeLines.push(`• Public keys on device: ${xsStatus.publicKeysOnDevice ? "yes" : "no"}`);
        e2eeLines.push(`• Private keys in secret storage: ${xsStatus.privateKeysInSecretStorage ? "yes" : "no"}`);
        e2eeLines.push(`• Private keys cached locally: ${xsStatus.privateKeysCachedLocally?.masterKey ? "yes" : "no"}`);
        e2eeLines.push(`• This room: ${roomEncrypted ? "encrypted" : "plaintext"}`);
      } else {
        e2eeLines.push(`• Status: disabled`);
        if (deviceId) e2eeLines.push(`• Device: \`${deviceId}\``);
      }

      const aclActive = !!(config.allowedUsers?.length || config.allowedRooms?.length || config.adminUsers.length);
      const aclLines: string[] = [];
      if (aclActive) {
        aclLines.push(`• Allowed users: ${config.allowedUsers?.length ? config.allowedUsers.join(", ") : "all"}`);
        aclLines.push(`• Allowed rooms: ${config.allowedRooms?.length ? config.allowedRooms.join(", ") : "all"}`);
        const admins = config.adminUsers.length
          ? config.adminUsers.join(", ")
          : config.allowedUsers?.length
          ? "allowlisted users"
          : "none (privileged commands disabled)";
        aclLines.push(`• Admins: ${admins}`);
      }

      return [
        `**Lumi status**`,
        `• Uptime: ${uptime}`,
        `• Node: ${process.version}`,
        `• Memory: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)} heap, ${formatBytes(mem.rss)} RSS`,
        `• Rooms: ${rooms.length}`,
        `• Modules: ${moduleInfo.length}`,
        `• Commands: ${registry.commandNames().length}`,
        `• Scheduled tasks: ${tasks.length}`,
        `• Reply handlers: ${replies.length}`,
        `• ACL: ${aclActive ? "active" : "disabled"}`,
        ...(aclActive ? [`\n**ACL**`, ...aclLines] : []),
        `\n**E2EE**`,
        ...e2eeLines,
        `\nUse \`!lumi modules\`, \`!lumi tasks\`, or \`!lumi verify\` for details.`,
      ].join("\n");
    },
  });
}
