/**
 * Core module: static
 * Self-contained utility commands with no external dependencies.
 */

import { BotModule, ModuleRegistry } from "../../registry";
import { BotConfig } from "../../config";

const startTime = Date.now();

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.register({
      name: "ping",
      module: "core",
      help: "Check if the bot is alive",
      handler: async () => "🏓 Pong!",
    });

    registry.register({
      name: "uptime",
      module: "core",
      help: "Show bot uptime",
      handler: async () => {
        const ms = Date.now() - startTime;
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return `⏱️ Bot uptime: **${h}h ${m}m ${sec}s**`;
      },
    });

    registry.register({
      name: "echo",
      module: "core",
      help: "Echo back your message",
      usage: "<text>",
      handler: async ({ args }) => {
        if (!args.length) return "Usage: `!echo <text>`";
        return args.join(" ");
      },
    });

    registry.register({
      name: "roll",
      module: "core",
      help: "Roll dice",
      usage: "[NdM]",
      description: "Defaults to 1d6. Examples: `!roll`, `!roll d20`, `!roll 3d6`.",
      handler: async ({ args }) => {
        const notation = args[0] ?? "1d6";
        const match = notation.toLowerCase().match(/^(\d+)?d(\d+)$/);
        if (!match) return "❌ Usage: `!roll [NdM]` e.g. `!roll 2d6`";

        const n = Math.min(parseInt(match[1] ?? "1", 10), 100);
        const m = Math.min(parseInt(match[2]!, 10), 10000);
        if (m < 2) return "❌ Dice must have at least 2 sides.";

        const rolls = Array.from({ length: n }, () =>
          Math.floor(Math.random() * m) + 1
        );
        const total = rolls.reduce((a, b) => a + b, 0);

        return n === 1
          ? `🎲 Rolled **${total}** (d${m})`
          : `🎲 Rolled **${total}** (${rolls.join(", ")}) on ${n}d${m}`;
      },
    });

    registry.register({
      name: "time",
      module: "core",
      help: "Show current UTC time",
      handler: async () => {
        const now = new Date().toUTCString().replace(" GMT", " UTC");
        return `🕐 Current UTC time: **${now}**`;
      },
    });

    registry.register({
      name: "flip",
      module: "core",
      help: "Flip a coin",
      handler: async () =>
        Math.random() > 0.5
          ? "Coin flip: **Heads 🪙**"
          : "Coin flip: **Tails 🪙**",
    });
  },
};

module.exports = mod;
