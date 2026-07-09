import { MatrixClient, MatrixEvent, MsgType } from "matrix-js-sdk";
import { BotConfig } from "./config";
import { logger } from "./logger";

const log = logger.getLogger('registry');
const schedulerLog = logger.getLogger('scheduler');
const loaderLog = logger.getLogger('loader');

// ── Types ────────────────────────────────────────────────────────────────────

export type CommandContext = {
  client: MatrixClient;
  roomId: string;
  event: MatrixEvent;
  args: string[];
};

export type CommandHandler = (ctx: CommandContext) => Promise<string | null>;

export interface CommandDef {
  name: string;
  handler: CommandHandler;
  /** One-liner shown in module overview */
  help: string;
  /** Longer explanation shown in !help <module> */
  description?: string;
  usage?: string;
  /** Module group this command belongs to (used by !help for grouping) */
  module?: string;
}

export interface BotModule {
  /** Called once at startup to register commands */
  register(registry: ModuleRegistry, config: BotConfig): void;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface ScheduledTaskDef {
  /** Unique name for logging */
  name: string;
  /** How often to run, in seconds */
  intervalSecs: number;
  /** Matrix room IDs to post the result into */
  rooms: string[];
  /** Return a message to post, or null to skip this tick */
  handler: () => Promise<string | null>;
}

// ── Reply handlers (conversational, non-command messages) ────────────────────

export interface ReplyHandlerDef {
  name: string;
  /** Return true if this handler wants to claim the message */
  match: (roomId: string, body: string) => boolean;
  handler: CommandHandler;
}

export type StartHook = (client: MatrixClient) => Promise<void>;

export class ModuleRegistry {
  private commands = new Map<string, CommandDef>();
  private tasks: ScheduledTaskDef[] = [];
  private replyHandlers: ReplyHandlerDef[] = [];
  private startHooks: StartHook[] = [];
  private moduleDescriptions = new Map<string, string>();

  /** Register a module with a short description (shown in !help overview) */
  registerModule(name: string, description: string): void {
    this.moduleDescriptions.set(name, description);
  }

  register(def: CommandDef): void {
    this.commands.set(def.name.toLowerCase(), def);
    log.info(`registered command: !${def.name}`);
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name.toLowerCase());
  }

  registerReply(def: ReplyHandlerDef): void {
    this.replyHandlers.push(def);
    log.info(`registered reply handler: ${def.name}`);
  }

  matchReply(roomId: string, body: string): ReplyHandlerDef | undefined {
    return this.replyHandlers.find((h) => h.match(roomId, body));
  }

  /** Register a hook to run after client.start() — use for adaptive/event-driven loops */
  onStart(fn: StartHook): void {
    this.startHooks.push(fn);
  }

  schedule(def: ScheduledTaskDef): void {
    if (def.intervalSecs <= 0 || def.rooms.length === 0) return;
    this.tasks.push(def);
    log.info(`scheduled "${def.name}" every ${def.intervalSecs}s -> ${def.rooms.length} room(s)`);
  }

  startScheduler(client: MatrixClient): void {
    for (const task of this.tasks) {
      setInterval(async () => {
        try {
          const text = await task.handler();
          if (text === null) return;
          for (const roomId of task.rooms) {
            await client.sendMessage(roomId, {
              msgtype: MsgType.Text,
              body: text,
              format: "org.matrix.custom.html",
              formatted_body: renderHtml(text),
            });
          }
        } catch (err) {
          schedulerLog.error(`"${task.name}":`, errMsg(err));
        }
      }, task.intervalSecs * 1_000);
    }
    if (this.tasks.length > 0) {
      schedulerLog.info(`${this.tasks.length} task(s) armed`);
    }

    for (const hook of this.startHooks) {
      hook(client).catch((err) => log.error("onStart hook error:", errMsg(err)));
    }
  }

  /**
   * Two-level help.
   * No arg  → overview: lists modules with descriptions and their commands.
   * With arg → detail: lists commands for that module with usage + description.
   */
  moduleHelp(moduleName?: string): string {
    if (moduleName) {
      const desc = this.moduleDescriptions.get(moduleName);
      const cmds = [...this.commands.values()]
        .filter((c) => c.module === moduleName)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!desc && cmds.length === 0)
        return `Unknown module \`${moduleName}\`. Use \`!help\` to list modules.`;
      const lines: string[] = [];
      if (desc) lines.push(`**${moduleName}** — ${desc}\n`);
      for (const cmd of cmds) {
        const usage = cmd.usage ? ` ${cmd.usage}` : "";
        lines.push(`• \`!${cmd.name}${usage}\` — ${cmd.help}`);
        if (cmd.description) lines.push(`  _${cmd.description}_`);
      }
      return lines.join("\n");
    }

    // Overview: group commands by module
    const groups = new Map<string, CommandDef[]>();
    for (const cmd of this.commands.values()) {
      const mod = cmd.module ?? "general";
      if (!groups.has(mod)) groups.set(mod, []);
      groups.get(mod)!.push(cmd);
    }

    const lines = ["**Available modules:**\n"];
    const moduleNames = [...groups.keys()].sort((a, b) => {
      if (a === "core") return -1;
      if (b === "core") return 1;
      return a.localeCompare(b);
    });
    for (const mod of moduleNames) {
      const desc = this.moduleDescriptions.get(mod);
      const cmds = groups.get(mod)!.sort((a, b) => a.name.localeCompare(b.name));
      const cmdList = cmds.map((c) => `\`!${c.name}\``).join(", ");
      lines.push(`**${mod}**${desc ? ` — ${desc}` : ""}`);
      lines.push(`  ${cmdList}`);
    }
    lines.push("\nUse `!help <module>` for detailed command info.");
    return lines.join("\n");
  }

  commandNames(): string[] {
    return [...this.commands.keys()];
  }

  taskInfo(): Array<{ name: string; intervalSecs: number; roomCount: number }> {
    return this.tasks.map((t) => ({
      name: t.name,
      intervalSecs: t.intervalSecs,
      roomCount: t.rooms.length,
    }));
  }

  replyHandlerNames(): string[] {
    return this.replyHandlers.map((h) => h.name);
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function renderHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

// ── Module loader ─────────────────────────────────────────────────────────────

import * as path from "path";
import * as fs from "fs";

export interface ModuleInfo {
  file: string;
  commands: string[];
  tasks: string[];
  replyHandlers: string[];
}

export async function loadModules(
  registry: ModuleRegistry,
  config: BotConfig,
  modulesDir?: string
): Promise<ModuleInfo[]> {
  if (!modulesDir) modulesDir = path.join(__dirname, "modules");
  if (!fs.existsSync(modulesDir)) {
    loaderLog.warn(`modules dir not found: ${modulesDir}`);
    return [];
  }
  const files = fs
    .readdirSync(modulesDir)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts") && !f.startsWith("_"));

  const loaded: ModuleInfo[] = [];

  for (const file of files.sort()) {
    const modPath = path.join(modulesDir, file);
    try {
      const beforeCommands = new Set(registry.commandNames());
      const beforeTasks = new Set(registry.taskInfo().map((t) => t.name));
      const beforeReplies = new Set(registry.replyHandlerNames());

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod: BotModule = require(modPath);
      if (typeof mod.register === "function") {
        mod.register(registry, config);
        loaded.push({
          file,
          commands: registry.commandNames().filter((c) => !beforeCommands.has(c)),
          tasks: registry.taskInfo().map((t) => t.name).filter((n) => !beforeTasks.has(n)),
          replyHandlers: registry.replyHandlerNames().filter((n) => !beforeReplies.has(n)),
        });
        loaderLog.info(`loaded module: ${file}`);
      } else {
        loaderLog.warn(`${file} has no register() export, skipping`);
      }
    } catch (err) {
      loaderLog.error(`failed to load ${file}:`, err);
    }
  }

  return loaded;
}
