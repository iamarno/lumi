// ── Types ─────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
  off:   4,
};

// ── ModuleLogger ──────────────────────────────────────────────────────────────

export class ModuleLogger {
  constructor(
    private readonly name: string,
    private readonly registry: Logger
  ) {}

  private isEnabled(level: LogLevel): boolean {
    const override = this.registry['overrides'].get(this.name);
    const effective = override ?? this.registry['globalLevel'];
    return LEVELS[level] >= LEVELS[effective];
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.isEnabled('debug')) console.log(`[${this.name}] ${msg}`, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.isEnabled('info')) console.log(`[${this.name}] ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.isEnabled('warn')) console.warn(`[${this.name}] ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.isEnabled('error')) console.error(`[${this.name}] ${msg}`, ...args);
  }
}

// ── Logger singleton ──────────────────────────────────────────────────────────

class Logger {
  private globalLevel: LogLevel;
  private overrides = new Map<string, LogLevel>();
  private known = new Set<string>();

  constructor() {
    const envLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
    this.globalLevel = envLevel in LEVELS ? envLevel : 'info';
  }

  getLogger(name: string): ModuleLogger {
    this.known.add(name);
    return new ModuleLogger(name, this);
  }

  setLevel(level: LogLevel, module?: string): void {
    if (module === undefined) {
      this.globalLevel = level;
    } else {
      if (level === this.globalLevel) {
        this.overrides.delete(module);
      } else {
        this.overrides.set(module, level);
      }
    }
  }

  getLevels(): { global: LogLevel; overrides: Record<string, LogLevel> } {
    const overrides: Record<string, LogLevel> = {};
    for (const [mod, lvl] of this.overrides) {
      overrides[mod] = lvl;
    }
    return { global: this.globalLevel, overrides };
  }

  knownModules(): string[] {
    return [...this.known];
  }
}

export const logger = new Logger();
