/**
 * Public API surface of the lumi core framework.
 *
 * Feature modules (repo: lumi_modules) import ONLY from this barrel:
 *   import { BotModule, ModuleRegistry, env, logger, ModuleStore } from "lumi";
 *
 * Anything not exported here is internal and may change without a major bump.
 */

export {
  ModuleRegistry,
  renderHtml,
  errMsg,
  type BotModule,
  type CommandDef,
  type CommandContext,
  type CommandHandler,
  type ScheduledTaskDef,
  type ReplyHandlerDef,
  type StartHook,
  type ModuleInfo,
} from "./registry";
export { type BotConfig, env, envInt, envList, envBool } from "./config";
export { logger, type ModuleLogger, type LogLevel } from "./logger";
export { ModuleStore } from "./storage";
