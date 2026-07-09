import * as http from "http";
import { Registry, Counter, collectDefaultMetrics } from "prom-client";
import { envInt } from "./config";

// ── Registry ──────────────────────────────────────────────────────────────────

const registry = new Registry();

// Built-in Node.js / process metrics (heap, GC, event loop lag, CPU, etc.)
collectDefaultMetrics({ register: registry });

// ── Lumi-specific counters ────────────────────────────────────────────────────

export const messagesReceived = new Counter({
  name: "lumi_messages_received_total",
  help: "Total Matrix text messages received (excluding own messages)",
  registers: [registry],
});

export const messagesSent = new Counter({
  name: "lumi_messages_sent_total",
  help: "Total Matrix messages sent by the bot",
  registers: [registry],
});

export const commandsReceived = new Counter({
  name: "lumi_commands_received_total",
  help: "Total commands dispatched",
  labelNames: ["command"] as const,
  registers: [registry],
});

export const unknownCommands = new Counter({
  name: "lumi_unknown_commands_total",
  help: "Total unrecognised commands received",
  registers: [registry],
});

// ── HTTP server ───────────────────────────────────────────────────────────────

export function startMetricsServer(): void {
  const port = envInt("METRICS_PORT", 0);
  if (port === 0) return;

  const server = http.createServer(async (_req, res) => {
    try {
      const body = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[metrics] Prometheus exporter on :${port}/metrics`);
  });
}
