#!/usr/bin/env node
import {
  createClient,
  MemoryStore,
  MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  Room,
  ClientEvent,
  RoomEvent,
  EventType,
  MsgType,
  KnownMembership,
  SyncState,
  AuthType,
  MatrixError,
} from "matrix-js-sdk";
import { loadConfig, BotConfig, envList, isAdmin } from "./config";
import { ModuleRegistry, ModuleInfo, loadModules, errMsg, renderHtml } from "./registry";
import { loadCryptoStore, saveCryptoStore } from "./crypto-store";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from "fake-indexeddb";
import { registerLumiCmd } from "./modules/core/lumi_cmd";
import {
  messagesReceived,
  messagesSent,
  commandsReceived,
  unknownCommands,
  startMetricsServer,
} from "./metrics";
import { logger, LogLevel } from "./logger";
import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import { VerifierEvent } from "matrix-js-sdk/lib/crypto-api/verification";
import type { VerificationRequest, ShowSasCallbacks } from "matrix-js-sdk/lib/crypto-api/verification";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";

export type PendingSas = {
  sas: ShowSasCallbacks;
  request: VerificationRequest;
  timer: ReturnType<typeof setTimeout>;
};

const log = logger.getLogger('lumi');

const PREFIX = "!";

const BANNER = `
  ██╗     ██╗   ██╗███╗   ███╗██╗
  ██║     ██║   ██║████╗ ████║██║
  ██║     ██║   ██║██╔████╔██║██║
  ██║     ╚██╗ ██╔╝██║╚██╔╝██║██║
  ███████╗ ╚████╔╝ ██║ ╚═╝ ██║██║
  ╚══════╝  ╚═══╝  ╚═╝     ╚═╝╚═╝

  friendly modular Matrix bot
  ──────────────────────────────
`;

// ── Message handler ───────────────────────────────────────────────────────────
// Extracted as a named function so it can be deferred for encrypted events
// (RoomEvent.Timeline fires before decryption; we re-invoke via MatrixEventEvent.Decrypted).

async function handleMessage(
  client: MatrixClient,
  registry: ModuleRegistry,
  userId: string,
  config: BotConfig,
  event: MatrixEvent,
  room: Room | undefined,
  toStartOfTimeline: boolean | undefined,
): Promise<void> {
  if (toStartOfTimeline) return; // skip history replayed on startup

  // Encrypted event not yet decrypted — defer until the SDK finishes.
  if (event.isEncrypted() && !event.getClearContent()) {
    event.once(MatrixEventEvent.Decrypted, () => {
      handleMessage(client, registry, userId, config, event, room, toStartOfTimeline)
        .catch((err) => log.error("error handling decrypted event:", errMsg(err)));
    });
    return;
  }

  if (event.getType() !== EventType.RoomMessage) return;

  const content = event.getContent();
  if (content.msgtype !== MsgType.Text || typeof content.body !== "string") return;
  if (event.getSender() === userId) return;

  const roomId = room!.roomId;
  const sender = event.getSender()!;

  // ACL: silently ignore messages from non-allowlisted senders / rooms.
  // Admins always pass the user allowlist (never lock an admin out); the room
  // allowlist still applies to everyone.
  if (
    config.allowedUsers?.length &&
    !config.allowedUsers.includes(sender) &&
    !isAdmin(sender, config)
  ) {
    log.debug(`ACL: ignoring message from ${sender} in ${roomId}`);
    return;
  }
  if (config.allowedRooms?.length && !config.allowedRooms.includes(roomId)) {
    log.debug(`ACL: ignoring message in non-allowlisted room ${roomId}`);
    return;
  }

  messagesReceived.inc();

  const body = content.body.trim();

  // ── Conversational reply handlers (non-command messages) ──────────────────
  if (!body.startsWith(PREFIX)) {
    const replyDef = registry.matchReply(roomId, body);
    if (!replyDef) return;
    // Admin-only reply handlers: silently ignore non-admins (like the ACL)
    if (replyDef.admin && !isAdmin(sender, config)) {
      log.debug(`admin: ignoring reply handler ${replyDef.name} from non-admin ${sender}`);
      return;
    }
    try {
      const reply = await replyDef.handler({ client, roomId, event, args: body.split(/\s+/) });
      if (reply === null) return;
      messagesSent.inc();
      await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: reply,
        format: "org.matrix.custom.html",
        formatted_body: renderHtml(reply),
      });
    } catch (err) {
      log.error(`error in reply handler ${replyDef.name}:`, err);
    }
    return;
  }

  const parts = body.slice(PREFIX.length).split(/\s+/);
  const commandName = parts[0]!.toLowerCase();
  const args = parts.slice(1);

  const def = registry.get(commandName);

  let reply: string | null;
  if (!def) {
    unknownCommands.inc();
    reply = `❓ Unknown command \`!${commandName}\`. Try \`!help\`.`;
  } else if (def.admin && !isAdmin(sender, config)) {
    commandsReceived.inc({ command: commandName });
    reply = "⛔ This command requires admin privileges.";
  } else {
    commandsReceived.inc({ command: commandName });
    try {
      reply = await def.handler({ client, roomId, event, args });
    } catch (err) {
      log.error(`error in !${commandName}:`, err);
      reply = `❌ Error executing \`!${commandName}\`: ${errMsg(err)}`;
    }
  }

  if (reply === null) return;
  messagesSent.inc();
  try {
    await client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      body: reply,
      format: "org.matrix.custom.html",
      formatted_body: renderHtml(reply),
    });
  } catch (err) {
    log.error(`error sending reply to !${commandName}:`, errMsg(err));
  }
}

async function main() {
  process.stdout.write(BANNER);
  const startedAt = Date.now();
  const config = loadConfig();
  logger.setLevel(config.logLevel as LogLevel);

  // ── Pending SAS verification map ─────────────────────────────────────────
  const pendingSas = new Map<string, PendingSas>();

  // ── E2EE (optional) ───────────────────────────────────────────────────────
  let cryptoStoreIdb: IDBFactory | undefined;
  let cryptoStorePath: string | undefined;

  if (config.e2eeEnabled) {
    const stateDir = process.env.LUMI_STATE_DIR ?? process.cwd();
    cryptoStorePath = path.join(stateDir, "crypto-store.json");
    cryptoStoreIdb = await loadCryptoStore(cryptoStorePath);
    // Set before initRustCrypto — the WASM module uses globalThis.indexedDB as the IDB backend
    // and checks all IDB constructors via instanceof, so every class must also be on globalThis.
    // This is process-scoped; lumi runs a single Matrix client so there is no conflict.
    const g = globalThis as unknown as Record<string, unknown>;
    g.indexedDB          = cryptoStoreIdb;
    g.IDBFactory         = IDBFactory;
    g.IDBDatabase        = IDBDatabase;
    g.IDBObjectStore     = IDBObjectStore;
    g.IDBIndex           = IDBIndex;
    g.IDBKeyRange        = IDBKeyRange;
    g.IDBTransaction     = IDBTransaction;
    g.IDBRequest         = IDBRequest;
    g.IDBOpenDBRequest   = IDBOpenDBRequest;
    g.IDBCursor          = IDBCursor;
    g.IDBCursorWithValue = IDBCursorWithValue;
    g.IDBVersionChangeEvent = IDBVersionChangeEvent;
  }

  // ── Resolve device ID ─────────────────────────────────────────────────────
  // When E2EE is enabled, the device_id MUST match the access token's session or
  // the homeserver rejects key uploads. Auto-detect via whoami if not configured.
  let resolvedDeviceId = config.deviceId;
  if (config.e2eeEnabled && !resolvedDeviceId) {
    const resp = await fetch(
      `${config.homeserver}/_matrix/client/v3/account/whoami`,
      { headers: { Authorization: `Bearer ${config.accessToken}` } }
    );
    if (!resp.ok) throw new Error(`whoami failed: ${resp.status} ${resp.statusText}`);
    const who = await resp.json() as { device_id?: string };
    if (!who.device_id) throw new Error("whoami did not return a device_id");
    resolvedDeviceId = who.device_id;
    log.info(`E2EE: auto-detected device_id: ${resolvedDeviceId}`);
  }

  // ── SSSS key callback ─────────────────────────────────────────────────────
  // The Rust SDK calls getSecretStorageKey whenever it needs to encrypt or
  // decrypt server-side secret storage (SSSS). We derive the raw key from
  // MATRIX_CRYPTO_PASSWORD using the salt/iterations stored in the key metadata.
  const ssssKeyCache = new Map<string, Uint8Array<ArrayBuffer>>();
  const cryptoCallbacks: CryptoCallbacks | undefined = config.cryptoPassword
    ? {
        getSecretStorageKey: async ({ keys }) => {
          for (const [keyId, keyInfo] of Object.entries(keys) as [string, SecretStorageKeyDescription][]) {
            if (ssssKeyCache.has(keyId)) return [keyId, ssssKeyCache.get(keyId)!];
            const pp = keyInfo.passphrase;
            if (pp?.algorithm === "m.pbkdf2") {
              const raw = await deriveRecoveryKeyFromPassphrase(
                config.cryptoPassword, pp.salt, pp.iterations
              );
              ssssKeyCache.set(keyId, raw);
              return [keyId, raw];
            }
          }
          return null;
        },
        cacheSecretStorageKey: (keyId, _info, key) => {
          ssssKeyCache.set(keyId, key);
        },
      }
    : undefined;

  // ── Matrix client ─────────────────────────────────────────────────────────
  const client = createClient({
    baseUrl: config.homeserver,
    accessToken: config.accessToken,
    userId: config.userId,
    ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
    store: new MemoryStore(),
    ...(cryptoCallbacks ? { cryptoCallbacks } : {}),
  });

  if (config.e2eeEnabled) {
    const cryptoOpts = {
      useIndexedDB: true,
      ...(config.cryptoPassword ? { storagePassword: config.cryptoPassword } : {}),
    };
    try {
      await client.initRustCrypto(cryptoOpts);
    } catch (err) {
      if (errMsg(err).includes("account in the store doesn't match")) {
        log.warn("E2EE: crypto store belongs to a different session — discarding and starting fresh");
        for (const p of [cryptoStorePath!, `${cryptoStorePath}.bak`, `${cryptoStorePath}.tmp`]) {
          try { fs.unlinkSync(p); } catch { /* file may not exist */ }
        }
        const freshIdb = new IDBFactory();
        const g = globalThis as unknown as Record<string, unknown>;
        g.indexedDB = freshIdb;
        cryptoStoreIdb = freshIdb;
        await client.initRustCrypto(cryptoOpts);
      } else {
        throw err;
      }
    }
    const crypto = client.getCrypto();
    if (crypto) crypto.globalBlacklistUnverifiedDevices = false;
    log.info(`E2EE ready: ${client.getCrypto()?.getVersion() ?? "unknown"}`);

    // ── SAS verification requests ────────────────────────────────────────────
    // Accept incoming verification requests and start SAS. Post emojis to the
    // admin room (if configured) and wait for `!lumi verify confirm <txnId>`.
    // Auto-cancel after 5 minutes if not confirmed.
    const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
    client.on(CryptoEvent.VerificationRequestReceived, (request: VerificationRequest) => {
      log.info(`verification request from ${request.otherUserId} (device: ${request.otherDeviceId ?? "unknown"})`);
      request.accept().then(async () => {
        const verifier = await request.startVerification("m.sas.v1");
        verifier.once(VerifierEvent.ShowSas, async (sas) => {
          const txnId = request.transactionId ?? "(unknown)";
          const emojiLine = sas.sas.emoji?.map(([e, n]) => `${e} ${n}`).join("  ")
            ?? sas.sas.decimal?.join(" - ")
            ?? "(no sas data)";
          log.info(`SAS [${txnId}] with ${request.otherUserId}: ${emojiLine}`);

          const timer = setTimeout(() => {
            if (pendingSas.has(txnId)) {
              pendingSas.delete(txnId);
              sas.cancel();
              log.warn(`verification [${txnId}] timed out`);
            }
          }, VERIFY_TIMEOUT_MS);
          timer.unref();
          pendingSas.set(txnId, { sas, request, timer });

          if (config.adminRoom) {
            const prompt = [
              `**Verification request from ${request.otherUserId}** (device: \`${request.otherDeviceId ?? "unknown"}\`)`,
              `Transaction: \`${txnId}\``,
              ``,
              `**Emojis:** ${emojiLine}`,
              ``,
              `Compare these emojis with what's shown in Element, then:`,
              `• \`!lumi verify confirm ${txnId}\` — they match, confirm`,
              `• \`!lumi verify cancel ${txnId}\` — they don't match, cancel`,
              ``,
              `_(Request expires in 5 minutes)_`,
            ].join("\n");
            await client.sendMessage(config.adminRoom, {
              msgtype: MsgType.Text,
              body: prompt,
              format: "org.matrix.custom.html",
              formatted_body: renderHtml(prompt),
            });
          }
        });
        verifier.once(VerifierEvent.Cancel, (err) => {
          log.warn(`verification cancelled by ${request.otherUserId}: ${errMsg(err)}`);
          const txnId = request.transactionId;
          if (txnId) {
            const entry = pendingSas.get(txnId);
            if (entry) {
              clearTimeout(entry.timer);
              pendingSas.delete(txnId);
            }
          }
        });
      }).catch((err) => {
        log.error(`verification accept failed: ${errMsg(err)}`);
      });
    });
  }

  // Auto-join rooms when invited (skipped if room is not on the allowlist)
  client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
    if (membership === KnownMembership.Invite) {
      if (config.allowedRooms?.length && !config.allowedRooms.includes(room.roomId)) {
        log.info(`ACL: ignoring invite to non-allowlisted room ${room.roomId}`);
        return;
      }
      client.joinRoom(room.roomId).catch((err: unknown) =>
        log.error(`failed to join ${room.roomId}:`, errMsg(err))
      );
    }
  });

  // ── Module registry ───────────────────────────────────────────────────────
  const registry = new ModuleRegistry();

  // Load core modules first (always available, no env config required)
  const coreInfo = await loadModules(
    registry,
    config,
    path.join(__dirname, "modules", "core")
  );

  // Load feature modules from external dirs (comma-separated LUMI_MODULES_DIR).
  // Unset ⇒ core-only. Feature modules live in the lumi_modules repo.
  const featureInfo: ModuleInfo[] = [];
  for (const dir of envList("LUMI_MODULES_DIR")) {
    featureInfo.push(...(await loadModules(registry, config, path.resolve(dir))));
  }

  const moduleInfo: ModuleInfo[] = [...coreInfo, ...featureInfo];

  // Register !lumi last so it has access to the complete module list
  registerLumiCmd(registry, moduleInfo, startedAt, pendingSas, config);

  const userId = client.getUserId()!;
  client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) =>
    handleMessage(client, registry, userId, config, event, room, toStartOfTimeline)
  );

  // ── Start ─────────────────────────────────────────────────────────────────
  log.info(`starting as ${config.userId} on ${config.homeserver}`);
  log.info(`commands: ${registry.commandNames().join(", ")}`);

  // ── Crypto store persistence ───────────────────────────────────────────────
  if (config.e2eeEnabled && cryptoStoreIdb && cryptoStorePath) {
    let isSaving = false;
    const doSave = () => {
      if (isSaving) return Promise.resolve();
      isSaving = true;
      return saveCryptoStore(cryptoStoreIdb!, cryptoStorePath!)
        .catch((err: unknown) => log.error("failed to save crypto store:", errMsg(err)))
        .finally(() => { isSaving = false; });
    };

    // Register signal handlers before sync so a SIGTERM during startup is handled.
    // doSave().finally(exit) keeps the process alive until the write completes —
    // Docker's 10 s SIGTERM grace window is sufficient.
    process.once("SIGTERM", () => doSave().finally(() => process.exit(0)));
    process.once("SIGINT",  () => doSave().finally(() => process.exit(0)));

    // Wait for initial sync before starting the scheduler and periodic saves
    await new Promise<void>((resolve) => {
      client.once(ClientEvent.Sync, (state: SyncState) => {
        if (state === SyncState.Prepared) resolve();
      });
      client.startClient({ initialSyncLimit: 0 });
    });

    // ── Cross-signing + SSSS bootstrap ───────────────────────────────────────
    // Must run after startClient so account data is synced and consistent.
    // Requires MATRIX_CRYPTO_PASSWORD (SSSS key) + MATRIX_PASSWORD (UIA upload).
    // isCrossSigningReady() returns true on subsequent restarts once the SSSS
    // key matches our passphrase — the entire block is then skipped.
    const crypto = client.getCrypto();
    if (crypto && config.cryptoPassword && config.password) {
      try {
        const xsReady = await crypto.isCrossSigningReady();
        if (!xsReady) {
          log.info("E2EE: setting up secret storage and cross-signing...");

          // Step 1: set up SSSS with a passphrase-derived key.
          // Prefer reusing an existing accessible SSSS so we don't destroy
          // private keys already stored there. Only reset if the existing key
          // is not accessible via our passphrase (e.g. it was created with a
          // random key before MATRIX_CRYPTO_PASSWORD was configured).
          const makeSecretStorageKey = async () => {
            const salt = randomBytes(32).toString("base64");
            const iterations = 500_000;
            const privateKey = await deriveRecoveryKeyFromPassphrase(
              config.cryptoPassword, salt, iterations
            );
            return {
              keyInfo: { passphrase: { algorithm: "m.pbkdf2" as const, iterations, salt } },
              privateKey,
            };
          };

          let ssssReset = false;
          try {
            await crypto.bootstrapSecretStorage({ createSecretStorageKey: makeSecretStorageKey });
          } catch {
            log.info("E2EE: existing SSSS not accessible — resetting with passphrase-derived key");
            ssssReset = true;
            await crypto.bootstrapSecretStorage({
              setupNewSecretStorage: true,
              createSecretStorageKey: makeSecretStorageKey,
            });
          }

          // Step 2: upload cross-signing public keys via UIA (two-step flow:
          // null → extract session from 401 → retry with password + session).
          // If SSSS was reset or private keys are missing, force-regenerate the
          // cross-signing keys so they can be stored in the new SSSS.
          const xsStatusBefore = await crypto.getCrossSigningStatus();
          const needNewKeys = ssssReset || !xsStatusBefore.privateKeysInSecretStorage;
          await crypto.bootstrapCrossSigning({
            ...(needNewKeys ? { setupNewCrossSigning: true } : {}),
            authUploadDeviceSigningKeys: async (makeRequest) => {
              let session = "";
              try {
                await makeRequest(null);
                return;
              } catch (err) {
                if (err instanceof MatrixError && err.httpStatus === 401 && err.data?.session) {
                  session = err.data.session as string;
                } else {
                  throw err;
                }
              }
              await makeRequest({
                type: AuthType.Password,
                identifier: { type: "m.id.user", user: config.userId },
                password: config.password!,
                session,
              });
            },
          });

          const s = await crypto.getCrossSigningStatus();
          log.info(
            `E2EE: cross-signing ready — publicKeysOnDevice=${s.publicKeysOnDevice}` +
            ` privateKeysInSecretStorage=${s.privateKeysInSecretStorage}`
          );
        } else {
          log.info("E2EE: cross-signing already ready");
        }
      } catch (err) {
        log.error("E2EE: cross-signing setup failed:", errMsg(err));
      }
    } else if (crypto && !config.cryptoPassword) {
      log.info("E2EE: set MATRIX_CRYPTO_PASSWORD to enable cross-signing via secret storage");
    } else if (crypto && !config.password) {
      log.info("E2EE: set MATRIX_PASSWORD to enable cross-signing bootstrap");
    }

    // Periodic save starts only after initial sync to avoid saving a partial state
    setInterval(doSave, config.cryptoSaveInterval * 1000).unref();
  } else {
    // No E2EE — just start the client
    await new Promise<void>((resolve) => {
      client.once(ClientEvent.Sync, (state: SyncState) => {
        if (state === SyncState.Prepared) resolve();
      });
      client.startClient({ initialSyncLimit: 0 });
    });
  }

  log.info("sync loop running");
  registry.startScheduler(client);
  startMetricsServer();
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
