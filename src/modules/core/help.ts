/**
 * Core module: help
 * Provides !help — two-level command guide.
 *   !help           → lists all modules with descriptions
 *   !help <module>  → lists commands for that module with usage and details
 */

import { BotModule, ModuleRegistry } from "../../registry";
import { BotConfig } from "../../config";

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.registerModule("core", "Built-in commands always available");

    registry.register({
      name: "help",
      module: "core",
      help: "List available modules and commands",
      usage: "[module]",
      description:
        "Without arguments lists all modules with a short description. " +
        "Pass a module name to see its commands, usage, and details.",
      handler: async ({ args }) => registry.moduleHelp(args[0]?.toLowerCase()),
    });
  },
};

module.exports = mod;
