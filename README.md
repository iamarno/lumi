# 🌟 Lumi

[![CI](https://github.com/iamarno/lumi/actions/workflows/ci.yml/badge.svg)](https://github.com/iamarno/lumi/actions/workflows/ci.yml)

A friendly, modular Matrix bot built with **Node.js + TypeScript** and [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk).

This repo is the **core framework and deployable app**: the Matrix client, E2EE, module registry, scheduler, logging, metrics, and the built-in core modules (`!help`, `!lumi`, `!ping` & friends, `!sysinfo`). It runs standalone with zero feature modules.

**Feature modules** (weather, grafana, home assistant, poker, …) live in the separate [`lumi_modules`](https://github.com/iamarno/lumi_modules) repo and are loaded at runtime from `LUMI_MODULES_DIR` — an optional add-on, not a build-time dependency.

## 🚀 Quick Start

```bash
npm install
cp .env.example .env
# Edit .env — set MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN
npm run dev                      # development (ts-node)
npm run build && npm start       # production
```

This starts a core-only bot. To add feature modules, point `LUMI_MODULES_DIR` at a directory of compiled module files (see [Feature modules](#-feature-modules)).

### 🔑 Getting a Matrix access token

1. Log in to Element (or any Matrix client) with your bot account
2. Go to **Settings → Help & About → Access Token**
3. Copy the token into `MATRIX_ACCESS_TOKEN` in `.env`

Or via curl:
```bash
curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
  -d '{"type":"m.login.password","user":"mybot","password":"secret"}'
```

---

## 🦭 Container

### 🔨 Building locally

```bash
docker build -t lumi .
docker run -v lumi-data:/data --env-file .env lumi
```

### Podman

[Podman](https://podman.io/) runs the same OCI images without a background daemon and, by default, as an unprivileged user — a good fit for self-hosting Lumi, since a container breakout lands as your user rather than root. The commands mirror Docker's (alias `docker=podman` if you like), and `podman generate systemd` turns the container into a user service that starts on login (see below).

```bash
podman build -t lumi .
podman run -v lumi-data:/data --env-file .env lumi
```

To run Lumi as a systemd user service (auto-starts on login, no root required):

```bash
podman run -d --name lumi \
  -v lumi-data:/data \
  --env-file .env \
  ghcr.io/iamarno/lumi:latest

# Generate a systemd unit and enable it
podman generate systemd --name lumi --files --new
mkdir -p ~/.config/systemd/user
mv container-lumi.service ~/.config/systemd/user/
systemctl --user enable --now container-lumi.service
```

### 📦 docker-compose

```bash
cp .env.example .env   # fill in your credentials

# Production (uses pre-built image from GHCR)
docker compose up -d

# Development (mounts source, runs ts-node)
docker compose --profile dev up bot-dev
```

The `/data` volume is used by modules that persist state. The Matrix sync state is held in memory and rebuilt on each restart (using `initialSyncLimit: 0` so no history is replayed).

When `MATRIX_E2EE=true`, the crypto key store is saved to `$LUMI_STATE_DIR/crypto-store.json` (default: every 60 s and on graceful shutdown). **The `/data` volume must be mounted** for keys to survive container restarts — without it the bot will appear as a new device on each restart. Docker sends `SIGTERM` before `SIGKILL`, so keys are saved during a normal `docker stop` or `docker compose down`.

#### Setting up E2EE

Minimal `.env` additions:

```env
MATRIX_E2EE=true
MATRIX_CRYPTO_PASSWORD=change-me         # encrypts the local key store AND server-side secret storage (SSSS)
MATRIX_PASSWORD=your-account-password   # used once for UIA key upload; can be removed after first start
# MATRIX_DEVICE_ID=                      # auto-detected; set explicitly if needed
```

Both `MATRIX_CRYPTO_PASSWORD` and `MATRIX_PASSWORD` are required for cross-signing. `MATRIX_CRYPTO_PASSWORD` doubles as the SSSS passphrase: lumi uses it to derive the encryption key for server-side secret storage so cross-signing private keys survive restarts. `MATRIX_PASSWORD` is only needed for the initial User-Interactive Auth upload of cross-signing public keys.

On first start, lumi:
1. Auto-detects its device ID via `/_matrix/client/v3/account/whoami` and logs it.
2. Checks whether cross-signing is already ready (`isCrossSigningReady()`). If not:
   - Resets SSSS with a `MATRIX_CRYPTO_PASSWORD`-derived key (`bootstrapSecretStorage`).
   - Uploads new cross-signing public keys via UIA (`bootstrapCrossSigning`).
3. On all subsequent restarts, the `getSecretStorageKey` callback derives the SSSS key from `MATRIX_CRYPTO_PASSWORD` automatically — cross-signing is ready immediately with no UIA needed. `MATRIX_PASSWORD` can be removed from `.env` at this point.
4. Other room members will see lumi's new device and begin sharing session keys — the first message after that will be readable. **Old messages sent before lumi joined with E2EE will remain undecryptable** (normal E2EE behaviour).

If the on-disk crypto store belongs to a different session (e.g. after regenerating an access token), lumi detects the mismatch, discards the stale store, and re-registers as a new device automatically.

Use `!lumi verify` to inspect the current device fingerprint and cross-signing status.

#### Verifying lumi's device in Element

Element requires interactive SAS (emoji) verification to mark a device as verified. Lumi handles this automatically:

1. Invite lumi to a private room and set `LUMI_ADMIN_ROOM` to that room's ID (see [Configuration](#️-configuration-env)).
2. In Element, open lumi's profile → **Security** → click **Verify** on lumi's device.
3. Lumi posts the verification emojis to the admin room along with a transaction ID.
4. Compare the emojis with what Element shows, then run:
   - `!lumi verify confirm <txnId>` — emojis match, confirm
   - `!lumi verify cancel <txnId>` — emojis don't match, cancel
5. Element marks lumi's device as verified.

Pending verifications expire automatically after 5 minutes. If `LUMI_ADMIN_ROOM` is not set, lumi still accepts and waits — the transaction ID is logged but no Matrix message is sent.

## ⚙️ CI/CD (GitHub Actions)

Two workflows ship in `.github/workflows/`:

### 🔁 `ci.yml` — main pipeline

Triggered on every push to `main` and on version tags (`v*.*.*`).

| Step | What it does |
|---|---|
| **Lint & typecheck** | `tsc --noEmit` — fails fast on type errors |
| **Test** | Jest suite with JUnit reporting |
| **Build & push** | Multi-arch Docker build (`amd64` + `arm64`), pushed to GHCR |
| **Image signing** | Keyless signing with [cosign](https://docs.sigstore.dev/) via Sigstore |
| **SBOM** | SPDX SBOM generated with Syft and attested with cosign |

**Release tagging** — push a semver tag to get a proper release image:
```bash
git tag v2.0.0 && git push origin v2.0.0
# Produces: :2.0.0  :2.0  :2  :latest
```

### 🛡️ `dependency-review.yml`

Runs on pull requests. Blocks merges that introduce HIGH or CRITICAL
vulnerabilities in npm dependencies.

### 🤖 Renovate

Configured in `renovate.json`: weekly grouped PRs for npm (minor/patch) and GitHub Actions updates.

### 🔐 Required repository setup

No secrets are required — the pipeline uses `GITHUB_TOKEN` (automatically provided)
to push to GHCR. Make sure **GitHub Packages** is enabled for your repository.

---

## 🛠️ Configuration (`.env`)

Core framework variables. Feature-module variables (`GRAFANA_*`, `HASS_*`, `SENTINEL_*`, …) are documented in the [`lumi_modules`](https://github.com/iamarno/lumi_modules) README.

| Variable | Description | Default |
|---|---|---|
| `MATRIX_HOMESERVER` | Your Matrix server URL | `https://matrix.org` |
| `MATRIX_USER_ID` | Bot's full Matrix ID | _(required)_ |
| `MATRIX_ACCESS_TOKEN` | Bot's access token | _(required)_ |
| `MATRIX_E2EE` | Enable end-to-end encryption | `false` |
| `MATRIX_DEVICE_ID` | Device ID for the bot's Matrix session. **Optional** — if blank, auto-detected from the homeserver at startup via `whoami`. | _(auto-detected)_ |
| `MATRIX_PASSWORD` | Account password. **Optional** — used only to bootstrap cross-signing on first start (UIA). See [Setting up E2EE](#setting-up-e2ee). | _(blank = no cross-signing)_ |
| `MATRIX_CRYPTO_PASSWORD` | Passphrase to encrypt the on-disk crypto store **and** derive the server-side secret storage (SSSS) key. | _(blank = unencrypted, no cross-signing)_ |
| `MATRIX_CRYPTO_SAVE_INTERVAL` | How often (seconds) to persist the crypto store to disk | `60` |
| `LUMI_MODULES_DIR` | Comma-separated directories of compiled feature modules to load at startup (see [Feature modules](#-feature-modules)) | _(blank = core-only)_ |
| `LUMI_STATE_DIR` | Directory for module state files | `process.cwd()` |
| `LUMI_ADMIN_ROOM` | Room ID for admin notifications (e.g. SAS verification prompts). Lumi must be a member. | _(blank = log only)_ |
| `LUMI_ALLOWED_USERS` | Comma-separated Matrix user IDs that lumi will respond to. When set, messages from any other user are silently ignored. | _(blank = allow all)_ |
| `LUMI_ALLOWED_ROOMS` | Comma-separated room IDs that lumi will respond in and join. When set, invites from other rooms are declined and messages in other rooms are ignored. | _(blank = allow all)_ |
| `LUMI_ALLOW_ENV_RELOAD` | Enable the `!lumi reload` command (disabled by default for safety) | `false` |
| `METRICS_PORT` | Port for the Prometheus `/metrics` endpoint | _(blank = disabled)_ |
| `LOG_LEVEL` | Log verbosity | `info` |

---

## 💬 Commands (core)

Feature-module commands are documented in the [`lumi_modules`](https://github.com/iamarno/lumi_modules) README.

### 🧰 Built-in
| Command | Description |
|---|---|
| `!help` | List all commands |
| `!ping` | Liveness check |
| `!uptime` | Bot uptime |
| `!time` | Current UTC time |
| `!echo <text>` | Echo back text |
| `!roll [NdM]` | Roll dice (e.g. `!roll 2d6`) |
| `!flip` | Flip a coin |

### 🤖 Lumi system
| Command | Description |
|---|---|
| `!lumi` | Status overview: uptime, Node version, memory, rooms, module/command/task counts, full E2EE + cross-signing status |
| `!lumi verify` | Show device ID, Ed25519 fingerprint, and cross-signing status |
| `!lumi verify confirm <txnId>` | Confirm a pending SAS verification (emojis match) |
| `!lumi verify cancel <txnId>` | Cancel a pending SAS verification |
| `!lumi modules` | List loaded module files and what each registered |
| `!lumi tasks` | List all scheduled tasks with their intervals and room counts |
| `!lumi log` | Show current log levels and known module names |
| `!lumi log <level>` | Set global log level (`debug`, `info`, `warn`, `error`, `off`) |
| `!lumi log <module> <level>` | Override log level for a specific module |
| `!lumi log <module> reset` | Clear per-module override, revert to global level |
| `!lumi reload` | Re-read `.env` and update `process.env` (requires `LUMI_ALLOW_ENV_RELOAD=true`; inert in Kubernetes where config comes from the environment, not a `.env` file) |

### 🖥️ System
| Command | Description |
|---|---|
| `!sysinfo` | Host CPU, memory, load averages, system + bot uptime, heap usage |

---

## 🧩 Feature modules

Feature modules are compiled JavaScript files that export a `register(registry, config)` function. At startup, lumi scans every directory listed in `LUMI_MODULES_DIR` (comma-separated) and loads each `.js` file that doesn't start with `_`. Unset means core-only.

```env
LUMI_MODULES_DIR=/app/modules
```

The canonical module collection is the [`lumi_modules`](https://github.com/iamarno/lumi_modules) repo, which ships as a carrier image for the Kubernetes init-container pattern (see [Deployment](#-deployment-kubernetes)). For local development:

```bash
# in lumi_modules:
npm install && npm run build
# in lumi:
LUMI_MODULES_DIR=../lumi_modules/dist npm run dev
```

### Public API

Modules import the framework from the `lumi` package (this repo — resolved via the image's self-symlink at runtime, or a `file:`/git dependency at dev time):

```typescript
import { BotModule, ModuleRegistry, CommandContext, renderHtml, errMsg } from "lumi";
import { BotConfig, env, envInt, envList, envBool } from "lumi";
import { logger, ModuleStore } from "lumi";
```

| Export | Purpose |
|---|---|
| `ModuleRegistry` | `register()` commands, `schedule()` tasks, `registerReply()` conversational handlers, `onStart()` hooks, `registerModule()` for `!help` grouping |
| `BotModule`, `CommandDef`, `CommandContext`, `ScheduledTaskDef`, `ReplyHandlerDef`, `StartHook`, `ModuleInfo` | The module contract types |
| `BotConfig` | Parsed bot configuration passed to `register()` |
| `env`, `envInt`, `envList`, `envBool` | `.env` / environment helpers |
| `logger` | Per-module leveled logger (`logger.getLogger("mymodule")`) |
| `ModuleStore` | Per-module persistent JSON storage under `$LUMI_STATE_DIR` |
| `renderHtml`, `errMsg` | Markdown-ish → Matrix HTML, error formatting |

Anything not exported from the barrel (`src/index.ts`) is internal and may change without a major version bump. The full module-authoring guide (with `_template.ts`) lives in the `lumi_modules` repo.

**npm note:** `lumi` is not published to the npm registry (the registry name belongs to an unrelated package). Always reference it as a git or `file:` dependency — never `npm install lumi`.

---

## 📈 Prometheus Exporter

Lumi can expose a `/metrics` endpoint for scraping by Prometheus. Enable it by setting `METRICS_PORT` in `.env`:

```env
METRICS_PORT=9091
```

The endpoint is then available at `http://<host>:9091/metrics`. It is unauthenticated — restrict access at the network layer (the Helm chart's NetworkPolicy does this).

### 📊 Exposed metrics

| Metric | Type | Description |
|---|---|---|
| `lumi_messages_received_total` | Counter | Matrix text messages received (excluding the bot's own) |
| `lumi_messages_sent_total` | Counter | Messages sent by the bot |
| `lumi_commands_received_total{command}` | Counter | Command invocations, labelled by command name |
| `lumi_unknown_commands_total` | Counter | Unrecognised commands received |
| `nodejs_heap_*`, `process_cpu_*`, … | Various | Built-in Node.js runtime metrics via `prom-client` |

### 🔧 Example Prometheus scrape config

```yaml
scrape_configs:
  - job_name: lumi
    static_configs:
      - targets: ['lumi:9091']
```

---

## ⏰ Scheduled Tasks

Any module can post messages to Matrix rooms automatically at a configured interval by calling `registry.schedule()` during `register()`:

```typescript
registry.schedule({
  name: "mymodule:auto",
  intervalSecs: 3600,
  rooms: envList("MYMODULE_ROOMS"),
  handler: async () => "⏰ Scheduled message!",  // return null to skip a tick
});
```

The scheduler arms all tasks after the Matrix client starts and posts each result to the configured rooms. `!lumi tasks` lists armed tasks at runtime. Per-module scheduling env vars (weather auto-post, plant reminders, …) are documented in `lumi_modules`.

---

## ☸️ Deployment (Kubernetes)

The Helm chart in [`charts/lumi/`](charts/lumi/) deploys the core image with feature modules as an optional init container:

```bash
helm install lumi charts/lumi \
  --set modules.enabled=true \
  --set modules.image=ghcr.io/iamarno/lumi_modules:1 \
  --set externalSecrets.enabled=true
```

- `modules.enabled=false` (default) deploys a core-only bot.
- With `modules.enabled=true`, an init container copies the compiled modules from the `lumi_modules` carrier image into a shared volume mounted read-only at `LUMI_MODULES_DIR`.
- Secrets flow Vault → [External Secrets Operator](https://external-secrets.io/) → K8s `Secret` → `envFrom`. Rotation requires a pod restart. A plain `Secret` fallback is available for clusters without ESO.
- Single replica, `Recreate` strategy (one Matrix session), RWO PVC for `/data`, hardened pod security context, NetworkPolicy.

See the chart's [values.yaml](charts/lumi/values.yaml) and [README](charts/lumi/README.md) for all options, and `README_CISO.md` for the security posture (including the module trust model).

---

## 🗂️ Project Structure

```
src/
├── index.ts            — Public API barrel (what feature modules import from "lumi")
├── lumi.ts             — App entry: Matrix client, message handler, startup
├── config.ts           — Config + env helpers (env, envInt, envList, envBool)
├── crypto-store.ts     — Persist/restore the Rust E2EE key store to JSON on disk
├── logger.ts           — Structured logger with per-module level control
├── metrics.ts          — Prometheus counters + HTTP exporter server
├── registry.ts         — ModuleRegistry, module loader, scheduler, renderHtml, errMsg
├── storage.ts          — ModuleStore: per-module persistent JSON storage
└── modules/
    └── core/           — Built-in modules (always loaded)
        ├── help.ts     — !help
        ├── lumi_cmd.ts — !lumi status / verify / modules / tasks / log / reload
        ├── static.ts   — !ping !uptime !echo !roll !time !flip
        └── sysinfo.ts  — !sysinfo
charts/lumi/            — Helm chart (core + optional modules init container)
```

Feature modules live in [`lumi_modules`](https://github.com/iamarno/lumi_modules).
