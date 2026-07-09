import * as fs from "fs";
import * as path from "path";

/**
 * Simple key/value store backed by a JSON file per module.
 * Files are written to $LUMI_STATE_DIR/<moduleName>.json
 *
 * Usage:
 *   const store = new ModuleStore('plants');
 *   store.set('monstera', { lastWatered: new Date().toISOString() });
 *   const s = store.get<PlantState>('monstera', { lastWatered: null });
 */
export class ModuleStore {
  private filePath: string;
  private data: Record<string, unknown>;

  constructor(moduleName: string) {
    const dir = process.env.LUMI_STATE_DIR ?? process.cwd();
    this.filePath = path.join(dir, `${moduleName}.json`);
    this.data = this.load();
  }

  private load(): Record<string, unknown> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return {};
    }
  }

  get<T>(key: string, fallback: T): T {
    return key in this.data ? (this.data[key] as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  delete(key: string): void {
    delete this.data[key];
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }
}
