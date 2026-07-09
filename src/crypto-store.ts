import * as fs from "fs";
import { IDBFactory } from "fake-indexeddb";
import { logger } from "./logger";
import { errMsg } from "./registry";

const log = logger.getLogger("crypto-store");

// ── Types ─────────────────────────────────────────────────────────────────────

type IndexSnapshot = {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
};

type StoreSnapshot = {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSnapshot[];
  records: Array<{ key: IDBValidKey; value: unknown }>;
};

type DbSnapshot = {
  version: number;
  stores: Record<string, StoreSnapshot>;
};

// ── Binary serialisation ───────────────────────────────────────────────────────
// The WASM crypto module stores Uint8Array values in IndexedDB.
// JSON can't represent those natively, so we tag and base64-encode them.

function replaceBinary(v: unknown): unknown {
  if (v instanceof Uint8Array)
    return { __t: "u8", d: Buffer.from(v).toString("base64") };
  if (v instanceof ArrayBuffer)
    return { __t: "ab", d: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map(replaceBinary);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        replaceBinary(val),
      ])
    );
  return v;
}

function reviveBinary(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "__t" in (v as object)) {
    const tagged = v as { __t: string; d: string };
    if (tagged.__t === "u8") return new Uint8Array(Buffer.from(tagged.d, "base64"));
    if (tagged.__t === "ab") return Buffer.from(tagged.d, "base64").buffer;
  }
  if (Array.isArray(v)) return v.map(reviveBinary);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        reviveBinary(val),
      ])
    );
  return v;
}

// ── IDB helpers ───────────────────────────────────────────────────────────────

function idbOpen(
  idb: IDBFactory,
  name: string,
  version: number,
  upgrade?: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbCursorAll(
  store: IDBObjectStore
): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const records: Array<{ key: IDBValidKey; value: unknown }> = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        records.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      } else {
        resolve(records);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

function idbPutAll(
  store: IDBObjectStore,
  snap: StoreSnapshot
): Promise<void> {
  return new Promise((resolve, reject) => {
    for (const { key, value } of snap.records) {
      const v = reviveBinary(value);
      // Use explicit key only for out-of-line key stores (keyPath === null)
      if (snap.keyPath === null) {
        store.put(v, key);
      } else {
        store.put(v);
      }
    }
    // oncomplete fires after all puts are committed
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
    store.transaction.onabort = () => reject(store.transaction.error);
  });
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

async function snapshotDB(
  idb: IDBFactory,
  name: string,
  version: number
): Promise<DbSnapshot> {
  const db = await idbOpen(idb, name, version);
  const stores: Record<string, StoreSnapshot> = {};

  for (const storeName of Array.from(db.objectStoreNames)) {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);

    const indexes: IndexSnapshot[] = Array.from(store.indexNames).map((n) => {
      const idx = store.index(n);
      return {
        name: n,
        keyPath: idx.keyPath,
        unique: idx.unique,
        multiEntry: idx.multiEntry,
      };
    });

    const records = await idbCursorAll(store);
    stores[storeName] = {
      keyPath: store.keyPath as string | string[] | null,
      autoIncrement: store.autoIncrement,
      indexes,
      records: records.map(({ key, value }) => ({
        key,
        value: replaceBinary(value),
      })),
    };
  }

  db.close();
  return { version, stores };
}

// ── Restore ───────────────────────────────────────────────────────────────────

async function restoreDBs(
  idb: IDBFactory,
  data: Record<string, DbSnapshot>
): Promise<void> {
  for (const [dbName, snap] of Object.entries(data)) {
    const db = await idbOpen(idb, dbName, snap.version, (upgradeDb) => {
      for (const [storeName, storeSnap] of Object.entries(snap.stores)) {
        const os = upgradeDb.createObjectStore(storeName, {
          keyPath: storeSnap.keyPath ?? undefined,
          autoIncrement: storeSnap.autoIncrement,
        });
        for (const idx of storeSnap.indexes) {
          os.createIndex(idx.name, idx.keyPath, {
            unique: idx.unique,
            multiEntry: idx.multiEntry,
          });
        }
      }
    });

    for (const [storeName, storeSnap] of Object.entries(snap.stores)) {
      if (storeSnap.records.length === 0) continue;
      const tx = db.transaction(storeName, "readwrite");
      await idbPutAll(tx.objectStore(storeName), storeSnap);
    }

    db.close();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a fresh IDBFactory, restoring any previously saved databases from
 * `filePath` if the file exists. On error the store starts fresh (the bot will
 * appear as a new device once, then stabilise on the next save cycle).
 */
export async function loadCryptoStore(filePath: string): Promise<IDBFactory> {
  const idb = new IDBFactory();
  const bakPath = `${filePath}.bak`;
  for (const candidate of [filePath, bakPath]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<
        string,
        DbSnapshot
      >;
      await restoreDBs(idb, data);
      log.info(`crypto store restored from ${candidate}`);
      return idb;
    } catch (err) {
      log.warn(`crypto store restore failed for ${candidate}: ${errMsg(err)}`);
    }
  }
  log.info("crypto store starting fresh");
  return idb;
}

/**
 * Serialise all databases in `idb` to `filePath` as JSON.
 * Write is atomic: data goes to a .tmp file first, the previous file is
 * renamed to .bak, then the .tmp is renamed into place. A crash at any
 * point leaves either the old primary or the old backup intact.
 * Uses fs.writeFileSync / fs.renameSync so it is safe to call from a
 * synchronous 'exit' handler.
 */
export async function saveCryptoStore(
  idb: IDBFactory,
  filePath: string
): Promise<void> {
  const dbList = await idb.databases();
  const out: Record<string, DbSnapshot> = {};
  for (const { name, version } of dbList) {
    if (!name || version === undefined) continue;
    out[name] = await snapshotDB(idb, name, version);
  }
  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;
  fs.writeFileSync(tmpPath, JSON.stringify(out));
  if (fs.existsSync(filePath)) fs.renameSync(filePath, bakPath);
  fs.renameSync(tmpPath, filePath);
  log.debug(`crypto store saved to ${filePath}`);
}
