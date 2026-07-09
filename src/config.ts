import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

// Load .env if present
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

export function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export function envInt(key: string, fallback = 0): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function envList(key: string): string[] {
  const val = env(key);
  return val ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export function envBool(key: string, fallback = false): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === "true" || val === "1";
}

export interface BotConfig {
  // Matrix
  homeserver: string;
  userId: string;
  accessToken: string;
  // E2EE
  e2eeEnabled: boolean;      // MATRIX_E2EE (default: false)
  deviceId: string;           // MATRIX_DEVICE_ID (optional: auto-detected from whoami)
  password?: string;          // MATRIX_PASSWORD (optional: used for cross-signing UIA)
  cryptoPassword: string;     // MATRIX_CRYPTO_PASSWORD (default: "")
  cryptoSaveInterval: number; // MATRIX_CRYPTO_SAVE_INTERVAL in seconds (default: 60)
  // Prometheus
  prometheusUrl: string;
  // Home Assistant
  hassUrl: string;
  hassToken: string;
  // Grafana
  grafanaUrl: string;
  grafanaToken: string;
  // ACL
  allowedUsers?: string[];  // LUMI_ALLOWED_USERS (empty/absent = allow all)
  allowedRooms?: string[];  // LUMI_ALLOWED_ROOMS (empty/absent = allow all)
  // HTTP fetch
  httpAllowedDomains: string[]; // empty = allow all
  // Weather (wttr.in — no key needed)
  weatherEnabled: boolean;
  // Admin
  adminRoom?: string; // LUMI_ADMIN_ROOM (optional: room ID for admin notifications, blank = log only)
  // Logging
  logLevel: string;
}

export function reloadEnv(): { changed: string[]; added: string[] } {
  if (!fs.existsSync(envPath)) return { changed: [], added: [] };
  const before = { ...process.env };
  dotenv.config({ override: true, path: envPath });
  const changed: string[] = [];
  const added: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (!(key in before)) {
      added.push(key);
    } else if (process.env[key] !== before[key]) {
      changed.push(key);
    }
  }
  return { changed, added };
}

export function loadConfig(): BotConfig {
  const homeserver = env("MATRIX_HOMESERVER", "https://matrix.org");
  const userId = env("MATRIX_USER_ID");
  const accessToken = env("MATRIX_ACCESS_TOKEN");

  if (!userId || !accessToken) {
    console.error(
      "❌  MATRIX_USER_ID and MATRIX_ACCESS_TOKEN must be set in .env"
    );
    process.exit(1);
  }

  const e2eeEnabled = envBool("MATRIX_E2EE", false);
  const deviceId = env("MATRIX_DEVICE_ID", ""); // optional: auto-detected from whoami if blank

  return {
    homeserver,
    userId,
    accessToken,
    e2eeEnabled,
    deviceId,
    password: env("MATRIX_PASSWORD", ""),
    cryptoPassword: env("MATRIX_CRYPTO_PASSWORD", ""),
    cryptoSaveInterval: envInt("MATRIX_CRYPTO_SAVE_INTERVAL", 60),
    prometheusUrl: env("PROMETHEUS_URL", "http://localhost:9090"),
    hassUrl: env("HASS_URL", "http://homeassistant.local:8123"),
    hassToken: env("HASS_TOKEN", ""),
    grafanaUrl: env("GRAFANA_URL", ""),
    grafanaToken: env("GRAFANA_TOKEN", ""),
    allowedUsers: envList("LUMI_ALLOWED_USERS"),
    allowedRooms: envList("LUMI_ALLOWED_ROOMS"),
    httpAllowedDomains: envList("HTTP_ALLOWED_DOMAINS"),
    weatherEnabled: envBool("WEATHER_ENABLED", true),
    adminRoom: env("LUMI_ADMIN_ROOM", ""),
    logLevel: env("LOG_LEVEL", "info"),
  };
}
