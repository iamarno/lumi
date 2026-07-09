/**
 * Core module: sysinfo
 * Reports system and process resource usage.
 */

import * as os from "os";
import { BotModule, ModuleRegistry, CommandContext } from "../../registry";
import { BotConfig } from "../../config";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function cmdSysinfo(_ctx: CommandContext): Promise<string> {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  const cpus = os.cpus();

  return [
    `**System**`,
    `• Host: \`${os.hostname()}\` (${os.type()} ${os.arch()})`,
    `• CPU: ${cpus[0]?.model ?? "unknown"} ×${cpus.length}`,
    `• Load: ${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)} (1/5/15 min)`,
    `• Memory: ${formatBytes(usedMem)} used / ${formatBytes(totalMem)} total`,
    `• Uptime: ${formatUptime(os.uptime())}`,
    ``,
    `**Lumi (Node ${process.version})**`,
    `• Uptime: ${formatUptime(process.uptime())}`,
    `• Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
    `• RSS: ${formatBytes(mem.rss)}`,
  ].join("\n");
}

// ── Module ────────────────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.register({
      name: "sysinfo",
      module: "core",
      help: "Show system and process resource usage",
      description: "Reports hostname, CPU, load averages, memory, and uptime for both the host OS and the Node.js process.",
      handler: cmdSysinfo,
    });
  },
};

module.exports = mod;
