# Split `lumi` into `lumi` (core) + `lumi_modules`, with optional-module K8s deployment

## Status (2026-07-10)

Implemented on branch `feature/split-core-modules` (+ local `lumi_modules` repo):
Parts A (barrel, exports, loader, removals, Dockerfile npm ci + self-symlink, CI npm ci,
README trim, CISO module-trust note), B (repo populated, imports rewritten, green:
13 suites / 276 tests), C (Helm chart, linted). Runtime resolution verified in-container.

Remaining manual steps:
1. Merge this branch; tag core `v2.0.0` and push the tag.
2. Create the `lumi_modules` GitHub repo; push; flip its `lumi` devDependency from
   `file:../lumi` to `github:iamarno/lumi#semver:^2.0.0` and commit the lockfile.
3. Tag `lumi_modules` `v1.0.0` (CI publishes the carrier image).
4. Configure Vault paths + ESO; `helm install` and run the K8s verification below.

## Context

Today `lumi` is a single repo: core framework (`src/*.ts` + `src/modules/core/`) and all
feature modules (`src/modules/*.ts`) compile into one `dist/` and ship as one Docker image.
Goals: (1) separate the stable **core framework** from the **feature modules** into two repos
with independent release cadence; (2) make **core the deployable app** with modules as an
**optional add-on**; (3) provide a **Kubernetes-friendly** deployment (single cluster, not HA)
that pulls secrets from a store like Vault. Keep it simple, safe, professional (KISS).

**Confirmed decisions:**
- **Coupling:** `lumi_modules` depends on core via a **git-tag npm dependency**
  (`"lumi": "github:<owner>/lumi#semver:^2.0.0"`). Modules keep clean imports:
  `import { BotModule, ModuleRegistry } from "lumi"`. Plugins are *typed against* the host at
  build time; the host *loads* them at runtime. Nothing published to a registry.
- **Deployable:** **`lumi` core is the app/image** and runs standalone with zero modules.
  Modules are optional, delivered separately, loaded from `LUMI_MODULES_DIR`.
- **Module delivery on K8s:** **init container** — the `lumi_modules` image copies its compiled
  modules (+ module-only deps) into a shared volume the core pod mounts at `LUMI_MODULES_DIR`.
  Omit the init container ⇒ core-only. Swap module sets without rebuilding core.
- **Secrets:** **External Secrets Operator** syncs a Vault secret → K8s `Secret` → `envFrom`.
  Core reads config from env as it does today (dotenv), so zero app churn.
- **Packaging:** a **Helm chart** in the core repo with a `modules.enabled` toggle.
- **Config fields:** feature fields stay in core's `BotConfig` for now (deferred cleanup).
- **Git history:** `lumi_modules` starts fresh (history stays in `lumi`).

## Runtime module resolution (the load-bearing detail)

A compiled module does `require("lumi")` (for value helpers `env`, `logger`, `ModuleStore`,
`renderHtml`, `errMsg`) and may `require("matrix-js-sdk")` / `require("axios")`. Since modules
are loaded from a mounted path inside the **core** container, resolution must work there:
- **`lumi`** → resolved to core itself via a **self-symlink** created in the core image
  (`ln -s /app /app/node_modules/lumi`), whose `exports`/`main` point at `dist/index.js`.
- **Host-provided deps** (`matrix-js-sdk`, `prom-client`, `dotenv`, `fake-indexeddb`) → resolved
  from core's `/app/node_modules`. Modules declare these as **peerDependencies** so they are not
  duplicated in the carried volume.
- **Module-only deps** (`axios`) → declared as regular `dependencies`; shipped in the modules
  volume's own `node_modules`.
- No `NODE_PATH` needed: Node's standard upward walk from `/app/modules/<mod>.js` checks
  `/app/modules/node_modules` (axios) and then `/app/node_modules` (lumi symlink,
  matrix-js-sdk) automatically.
- **Name-squatting caveat:** `lumi` is a *taken* name on the public npm registry (v0.1.0,
  someone else's package). We never fetch `lumi` from the registry — always the git URL — but
  this means: never run a bare `npm install lumi`, and do **not** list `lumi` in
  `peerDependencies` (npm ≥7 auto-resolves peers from the registry → dependency-confusion
  vector). See B2/D3.

## What moves vs stays

**Stays in `lumi` (core):** `src/{lumi,registry,config,logger,metrics,storage,crypto-store}.ts`;
`src/modules/core/{help,lumi_cmd,static,sysinfo}.ts`; tests `config/e2ee/registry/storage.test.ts`,
`modules/static.test.ts`, `__mocks__/matrix-js-sdk.ts`; `README_CISO.md`, `SECURITY.md`, core
README sections. **Core also builds the deployable bot image and owns the Helm chart.**

**Moves to `lumi_modules`:** the 12 feature modules `src/modules/{football,grafana,grafana_alerts,
homeassistant,http,plants,poker,prometheus,sentinel,sumo,water,weather}.ts` → `src/*.ts`;
`src/modules/_template.ts` → `src/_template.ts`; `src/grafana_render.ts` →
`src/lib/grafana_render.ts` (sole `axios` user); the 12 feature tests + `grafana_render.test.ts`
→ `tests/`; a **copy** of `tests/__mocks__/matrix-js-sdk.ts`; feature README sections + the
"Adding a Module" guide.

---

## Part A — `lumi` core repo (do first, in place)

### A1. Public API barrel — `src/index.ts` (new)
```ts
export {
  ModuleRegistry, renderHtml, errMsg,
  type BotModule, type CommandDef, type CommandContext, type CommandHandler,
  type ScheduledTaskDef, type ReplyHandlerDef, type StartHook, type ModuleInfo,
} from "./registry";
export { type BotConfig, env, envInt, envList, envBool } from "./config";
export { logger } from "./logger";
export { ModuleStore } from "./storage";
```
(Confirm `env*` are exported from `config.ts` and `ModuleStore` from `storage.ts`; add exports if not.)

### A2. `package.json`
- `"main": "dist/index.js"`, `"types": "./dist/index.d.ts"`.
- `"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`,
  `"bin": { "lumi": "./dist/lumi.js" }`, `"files": ["dist"]`.
- `"prepare": "npm run build"` (git-tag install builds core automatically).
- **Drop `axios`** from `dependencies` (leaves with `grafana_render.ts`).
- Version → `2.0.0`. Declarations already emit (`tsconfig` `declaration: true`).

### A3. Loader change — external feature-module dir
`src/registry.ts` `loadModules` (registry.ts:221) — guard a missing dir:
```ts
if (!modulesDir) modulesDir = path.join(__dirname, "modules");
if (!fs.existsSync(modulesDir)) { loaderLog.warn(`modules dir not found: ${modulesDir}`); return []; }
```
`src/lumi.ts` (lumi.ts:369-377) — core modules internal, features from configurable path list:
```ts
const coreInfo = await loadModules(registry, config, path.join(__dirname, "modules", "core"));
const featureInfo: ModuleInfo[] = [];
for (const dir of envList("LUMI_MODULES_DIR")) {
  featureInfo.push(...await loadModules(registry, config, path.resolve(dir)));
}
```
Import `envList` if needed. Unset `LUMI_MODULES_DIR` ⇒ core-only (safe standalone default).

### A4. Remove what moved
Delete the 12 feature modules, `_template.ts`, `grafana_render.ts`; delete their tests +
`grafana_render.test.ts` (keep `modules/static.test.ts`). Grep to confirm no core file still
imports `axios` or `grafana_render`. Keep `fake-indexeddb` (used by `crypto-store.ts`).

### A5. Core Dockerfile — the deployable bot image
Adapt the current 3-stage Dockerfile with two changes:
1. **Reproducible installs:** `COPY package.json package-lock.json ./` + `npm ci` (deps stage:
   `npm ci --omit=dev`) instead of the current `COPY package.json` + `npm install`. Today the
   lockfile never reaches the image build, so every build re-resolves dependency ranges — with
   git-tag deps in play this becomes a supply-chain hole. Also switch CI's `npm install` →
   `npm ci` (ci.yml:30).
2. **Self-symlink** so mounted modules resolve `require("lumi")` to core. Distroless has no
   shell, so create it in the `deps` stage right after `npm ci` — it rides along in the
   `COPY --from=deps /app/node_modules` (Docker COPY preserves symlinks):
```dockerfile
# deps stage:
RUN npm ci --omit=dev && ln -s /app /app/node_modules/lumi && mkdir -p /data
# runtime stage (unchanged shape):
ENV LUMI_STATE_DIR=/data
# LUMI_MODULES_DIR is set by the K8s pod (points at the mounted modules volume)
CMD ["dist/lumi.js"]
```

### A6. Core CI — `.github/workflows/ci.yml`
Keep the whole existing pipeline in core (it builds the deployable image): `lint-and-test`
(typecheck + test) → `build-and-push` (multi-arch buildx → GHCR, cosign sign, Syft SBOM) →
`release` on `v*` tags. Keep `dependency-review.yml`.

### A7. Core docs
Trim `README.md` to core: Quick Start, Configuration (core env: Matrix, E2EE, ACL
`LUMI_ALLOWED_*`, `LUMI_ADMIN_ROOM`, `LOG_LEVEL`, `LUMI_STATE_DIR`, `LUMI_MODULES_DIR`),
Prometheus/metrics, Scheduled Tasks, Project Structure, a **Public API** section (the
`src/index.ts` exports + `register(registry, config)` contract), and a **Deployment** section
pointing at the Helm chart. Keep `README_CISO.md`, `SECURITY.md`.

Tag core `v2.0.0` when green.

---

## Part B — `lumi_modules` repo (the optional-module carrier)

Layout:
```
lumi_modules/
  src/{football..weather}.ts  _template.ts  lib/grafana_render.ts
  tests/{12 feature}.test.ts  grafana_render.test.ts  __mocks__/matrix-js-sdk.ts
  package.json tsconfig.json tsconfig.test.json jest.config.js
  Dockerfile .dockerignore .gitignore renovate.json audit-ci.json
  .github/workflows/ci.yml  README.md
```

### B1. Import rewrites (mechanical)
- `from "../registry"|"../config"|"../logger"|"../storage"` → `from "lumi"`.
- `from "../grafana_render"` → `from "./lib/grafana_render"` (grafana.ts, grafana_alerts.ts).
- Tests: `from "../../src/registry"|"../../src/config"` → `from "lumi"`;
  `require("../../src/modules/<m>")` → `require("../src/<m>")`;
  `jest.mock("../../src/grafana_render", …)` → `jest.mock("../src/lib/grafana_render", …)`.

### B2. `package.json`
```jsonc
{
  "name": "lumi_modules",
  "version": "1.0.0",
  "scripts": { "build": "tsc", "typecheck": "tsc --noEmit", "test": "jest", "test:ci": "jest --ci" },
  "dependencies": { "axios": "^1.16.1" },                         // module-only runtime dep
  "peerDependencies": { "matrix-js-sdk": "^41.4.0" },             // host-provided at runtime
  "devDependencies": {                                            // build/test toolchain
    "lumi": "github:<owner>/lumi#semver:^2.0.0",
    "matrix-js-sdk": "^41.4.0",
    "typescript": "^6.0.3", "ts-node": "^10.9.2",
    "jest": "^30.0.0", "ts-jest": "^29.4.9", "@types/jest": "^30.0.0",
    "@types/node": "^25.6.0", "jest-junit": "^17.0.0", "audit-ci": "^7.1.0"
  }
}
```
`matrix-js-sdk` as peer (with a dev copy for build/test) keeps it out of the carried production
`node_modules`, so the modules volume ships only `axios` (+ its transitive deps).
**Deliberately NOT a peerDependency: `lumi`.** npm ≥7 auto-installs peers from the *registry*,
and `lumi` is a squatted name on npmjs (see the resolution section) — listing it as a peer is a
dependency-confusion vector. The host-provides-`lumi` contract is enforced by the runtime
symlink and documented in the README instead; the git-URL devDependency covers build/test.

### B3. Build/test config (copy from core, adjust)
`tsconfig.json` (same options, `outDir ./dist`, `rootDir ./src`, `include ["src/**/*"]`);
`tsconfig.test.json` (`extends`, `rootDir "."`, `noEmit`, `types ["jest","node"]`,
`include ["src/**/*","tests/**/*"]`); `jest.config.js` copied from core (ts-jest preset,
matrix-js-sdk `moduleNameMapper`, `roots ['<rootDir>/tests']`, coverage from `src/**/*.ts`).
ts-jest resolves `lumi` from `node_modules` (`.js` + `.d.ts`) — core isn't recompiled in the run.

### B4. Carrier Dockerfile (thin — produces the artifact copied by the init container)
```dockerfile
FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci                             # lockfile pins the lumi git dep to an exact commit
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build                      # -> /app/dist/*.js

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=peer      # prod node_modules = axios only (peers excluded)

FROM busybox:stable AS runtime         # minimal; used as an init container
WORKDIR /modules
COPY --from=builder /app/dist          ./
COPY --from=deps    /app/node_modules  ./node_modules
# no CMD needed; the K8s init container runs: cp -a /modules/. /shared/
```
The init container copies `/modules` (compiled `.js` + `node_modules/axios`) into the shared
volume the core pod mounts at `/app/modules`.

### B5. `lumi_modules` CI — `.github/workflows/ci.yml`
`lint-and-test` (typecheck + test; needs read access to the `lumi` repo for the git-tag
devDep — default `GITHUB_TOKEN` covers same-owner, else a PAT) → `build-and-push` (multi-arch
buildx of the carrier image → GHCR, cosign, SBOM) → `release` on `v*`. Add `dependency-review.yml`.

### B6. `lumi_modules` README
Per-module command reference, feature env vars (`GRAFANA_URL/TOKEN`, `HASS_URL/TOKEN`,
`PROMETHEUS_URL`, `HTTP_ALLOWED_DOMAINS`, `WEATHER_ENABLED`), the **"Adding a Module"** guide,
and how the carrier image plugs into the core Helm chart (`modules.image` / `modules.enabled`).

---

## Part C — Helm chart (`charts/lumi/` in the core repo)

Single-cluster, not HA. Templates:
- **Deployment** — `replicas: 1`, `strategy: Recreate` (one Matrix session / RWO PVC; never two
  pods). Main container = `lumi` image, `env: LUMI_STATE_DIR=/data`, and when modules enabled
  `LUMI_MODULES_DIR=/app/modules`; `envFrom: [{ secretRef: { name: <release>-env } }]`.
  Volume mounts: `state` (PVC) at `/data`, and when modules enabled an `emptyDir` `modules` at
  `/app/modules` — mounted **`readOnly: true` in the main container** (only the init container
  writes it), so module code can't be tampered with at runtime.
  ```yaml
  {{- if .Values.modules.enabled }}
  initContainers:
    - name: modules
      image: {{ .Values.modules.image }}
      command: ["sh","-c","cp -a /modules/. /shared/"]
      volumeMounts: [{ name: modules, mountPath: /shared }]
  {{- end }}
  ```
- **PVC** — RWO, `Values.persistence.size` (default e.g. 1Gi), for `/data` (sync token, crypto
  store, per-module JSON stores).
- **ExternalSecret** (gated by `Values.externalSecrets.enabled`) — pulls the Vault path into a
  K8s `Secret` named `<release>-env`, consumed via `envFrom`. Provide a plain `Secret` fallback
  template for clusters without ESO.
- **ServiceAccount** (automountServiceAccountToken: false — the bot needs no kube-API access),
  and optional **ServiceMonitor** for the Prometheus metrics port.
- **Pod hardening** (`securityContext`): `runAsNonRoot: true`, `runAsUser: 65532` (distroless
  nonroot), `readOnlyRootFilesystem: true` (only `/data` PVC + the `/app/modules` emptyDir +
  a `/tmp` emptyDir are writable), `allowPrivilegeEscalation: false`,
  `capabilities.drop: ["ALL"]`, `seccompProfile: RuntimeDefault`.
- **NetworkPolicy** (default-deny ingress, opt-in per port): ingress to `METRICS_PORT` only from
  the monitoring namespace, ingress to `GRAFANA_ALERTS_PORT` only from the Grafana source.
  **Egress — be honest about vanilla NetworkPolicy limits:** it matches IPs/selectors, not DNS
  names, so "egress only to the homeserver" isn't expressible portably. KISS egress policy:
  allow DNS + 443/80 to `0.0.0.0/0` **except** `169.254.169.254/32` (metadata endpoint) and,
  where the cluster layout allows, the RFC1918 blocks minus the in-cluster upstreams
  (Grafana/HASS/Prometheus) as explicit CIDR/selector exceptions. Note in the chart docs that
  FQDN egress needs a CNI extension (e.g. CiliumNetworkPolicy) if wanted later. This is the
  compensating control for the `http` module's SSRF gap (see Part D).
- **Services** only for the ports actually enabled (metrics / webhook); none by default.

`values.yaml` keys: `image.repository/tag`, `image.digest` (pin by digest, not just tag),
`modules.enabled` (default `false`), `modules.image`, `modules.digest`, `persistence.size`,
`persistence.storageClass` (encrypted-at-rest), `externalSecrets.{enabled,secretStoreRef,vaultPath}`,
`networkPolicy.enabled`, `metrics.enabled`, `resources`. Install:
```
helm install lumi charts/lumi \
  --set modules.enabled=true \
  --set modules.image=ghcr.io/<owner>/lumi_modules:1 \
  --set externalSecrets.enabled=true
```

---

## Part D — Security, secrets & communication

This split changes the trust surface, so it is treated as a first-class part of the plan.

### D1. Trust boundary — the split is organizational, not a security sandbox
Modules are `require()`d **into the core process** and run with full privileges: any module can
read every env secret (`MATRIX_ACCESS_TOKEN`, `MATRIX_CRYPTO_PASSWORD`, `MATRIX_PASSWORD`,
`HASS_TOKEN`, `GRAFANA_TOKEN`, `GRAFANA_ALERTS_SECRET`), the crypto store, the PVC, and the
network. Putting modules in a separate repo/image does **not** isolate them. Consequences:
- Treat authoring/reviewing a module as a **privileged** change; the `lumi_modules` repo needs
  the same branch protection and review bar as core.
- The init container executes attacker-controllable code if the carrier image is swapped, so
  **verify the carrier image signature in-cluster**: both images are cosign-signed already
  (Part A6/B5); add a Sigstore **policy-controller / Kyverno** admission policy that only admits
  `lumi` and `lumi_modules` images signed by the expected identity, and **pin images by digest**
  (`modules.digest`) not floating tags.
- Document this plainly in `README_CISO.md` (new "Module trust" note): the module boundary is a
  code-organization boundary, not a privilege boundary.

### D2. Secrets flow (ESO → Secret → envFrom)
- All secrets land in one K8s `Secret` (`<release>-env`) synced by ESO from Vault, consumed via
  `envFrom`. Core reads `process.env` unchanged; **no `.env` file exists in-cluster** — `dotenv`
  no-ops when the file is absent (config.ts:7), so this is safe.
- **`!lumi reload` becomes inert in-cluster:** `reloadEnv()` re-reads the `.env` file (config.ts:63),
  which isn't present, and `envFrom` values are fixed at pod start anyway. Keep
  `LUMI_ALLOW_ENV_RELOAD=false` (it is also a privileged command per CISO). **Secret rotation =
  pod restart** (or add stakater/reloader keyed on the Secret). Note this in the Deployment docs.
- **Least exposure:** template the `ExternalSecret` so module secrets (`HASS_TOKEN`,
  `GRAFANA_TOKEN`, `GRAFANA_ALERTS_SECRET`) are only pulled when `modules.enabled=true`. Core-only
  deployments then never mount module tokens.
- `.env` stays git-ignored in both repos; ship `.env.example` only. Confirm `.dockerignore`
  excludes `.env*` in both images (core already does).

### D3. Supply chain (two pipelines now)
- The git-tag dep `github:<owner>/lumi#semver:^2.0.0` resolves to a **tag**, which is mutable.
  `package-lock.json` records the resolved **commit SHA** — but that only protects builds that
  actually use the lockfile. Today neither the Dockerfiles nor CI do (`COPY package.json` +
  `npm install`): **switch every install to `COPY package*.json` + `npm ci`** in both repos'
  Dockerfiles and CI (fixed in A5/B4). Renovate then bumps the pinned commit deliberately.
- **Dependency confusion:** `lumi` is a squatted name on the public npm registry (v0.1.0).
  Mitigations baked into the plan: `lumi` is referenced *only* by git URL (never a registry
  range), it is **not** a `peerDependency` (B2), and the READMEs warn against bare
  `npm install lumi`. `lumi_modules` is currently unclaimed on npmjs — no registry exposure.
- Both repos keep `audit-ci` (dependency-review) and Renovate; both images get cosign keyless
  signatures + Syft SBOM (already in A6/B5 — the new `lumi_modules` workflow needs
  `permissions: id-token: write` for keyless signing, same as core's). GHCR pull in K8s via
  `imagePullSecrets` or workload identity, both images in the same org.

### D4. Network exposure & communication
- **Matrix transport:** already E2EE (Rust SDK) end-to-end; homeserver over HTTPS. No change.
- **Inbound listeners** (both `listen(port)` on all interfaces): metrics `/metrics`
  (`METRICS_PORT`, **unauthenticated**) and the grafana_alerts webhook (`GRAFANA_ALERTS_PORT`,
  HMAC-verified only **if `GRAFANA_ALERTS_SECRET` is set** — verifyHmac uses sha256 +
  `timingSafeEqual`, grafana_alerts.ts:119-133). Controls: default-deny **NetworkPolicy**
  (Part C) restricting each port to its legitimate source; **require `GRAFANA_ALERTS_SECRET`**
  whenever the webhook is exposed (document as mandatory, not optional, for cluster use); keep
  metrics reachable only from the monitoring namespace.
- **Outbound SSRF (pre-existing gap the split should flag):** the `http` module's `isAllowed()`
  (http.ts:55-63) matches hostname suffixes only — it does **not** block private/link-local
  ranges or the cloud metadata IP `169.254.169.254`. Inside a cluster this can reach internal
  services and the metadata endpoint. Compensating controls now: **egress NetworkPolicy**
  (Part C) and **require `HTTP_ALLOWED_DOMAINS` (deny-by-default)** when the http module is
  enabled. Flag a code-level fix (block RFC1918/link-local/metadata in `isAllowed`) as a
  follow-up in `lumi_modules`.

### D5. Secrets at rest
- The PVC (`LUMI_STATE_DIR=/data`) holds the crypto store (cross-signing keys, passphrase-encrypted
  via `MATRIX_CRYPTO_PASSWORD`-derived SSSS — safe) **and** per-module JSON stores written by
  `ModuleStore` in **plaintext**. Use an **encrypted-at-rest StorageClass**, RWO, and note that a
  module persisting sensitive data writes it unencrypted to the PVC.

### D6. Docs split for security
- `README_CISO.md`, `SECURITY.md` stay in core; add the D1 "Module trust" note and a Deployment
  security checklist (NetworkPolicy, digest pinning, ESO, rotation-by-restart).
- Module-specific security docs move to `lumi_modules`: webhook HMAC setup
  (`GRAFANA_ALERTS_SECRET`), the `http` SSRF allowlist (`HTTP_ALLOWED_DOMAINS`), and the SSRF
  follow-up note.

## Migration sequence
-1. **Save this plan into the repo** as `docs/SPLIT_PLAN.md` (on a feature branch, per branch
   policy) so the split is documented and reviewable in-repo; keep it updated as steps land.
0. Tag current monorepo `v1.x` as the pre-split baseline. **Existing GitHub releases, tags, and
   GHCR images are untouched by the split** (repo is modified in place, never recreated) — old
   `v1.x` releases/images stay available and rebuildable; the `v2.0.0` release notes should state
   that `v1.x` = monorepo, `v2.0.0+` = split core with modules in `lumi_modules`.
1. `lumi`: A1 barrel → A2 package.json → A3 loader → verify core still runs standalone and core
   tests pass with `LUMI_MODULES_DIR` unset. (tag `v2.0.0-rc`)
2. Create fresh `lumi_modules`; populate per Part B; rewrite imports; `npm install` (pulls core
   from git via devDep); `npm run typecheck && npm test` green.
3. `lumi`: A4 delete moved files + drop `axios`; A5 Dockerfile npm ci + self-symlink; A7 docs;
   add Part C Helm chart. Verify. Tag core `v2.0.0`.
4. Point `lumi_modules` peer/dev `lumi` at `^2.0.0`; build carrier image; publish.
5. `helm install` with `modules.enabled=true`; smoke test end-to-end.

**Versioning:** semver both repos independently. Breaking core API → core **major**;
`lumi_modules` pins `^2.0.0`. Initial split: core `v2.0.0`, modules `v1.0.0`.

## Verification
- **Core standalone:** in `lumi`, `npm run typecheck && npm test` pass; `npm run build` emits
  `dist/index.js` + `dist/index.d.ts`; `docker run` the core image (creds, no `LUMI_MODULES_DIR`)
  → `!help` lists only core modules.
- **Modules build against core:** in `lumi_modules`, `npm install` resolves `lumi` from git and
  builds it; `npm run typecheck && npm test` pass (feature tests import from `lumi`).
- **Runtime resolution:** in a shell container mimicking the pod (core image contents + the
  `node_modules/lumi` self-symlink), mount the carrier output at `/app/modules` and confirm a
  module loads: `require("/app/modules/weather.js")` resolves `require("lumi")` (via the
  symlink), `require("matrix-js-sdk")` (core copy), and `require("axios")` (volume copy)
  without error — no NODE_PATH involved, plain upward resolution.
- **End-to-end on K8s (or kind):** `helm install --set modules.enabled=true`; pod init container
  copies modules; core `!help` lists **core + feature modules**; a feature command (`!weather`)
  and a core command (`!ping`) respond; ESO-populated Secret is consumed via `envFrom`; state
  survives a pod restart (PVC). Then `--set modules.enabled=false` ⇒ core-only pod, `!help`
  shows core only.

- **Security checks:** confirm no `.env` is baked into either image (`.dockerignore`); pod runs
  as non-root with read-only rootfs (`kubectl exec` shows writes fail outside `/data`,
  `/app/modules`, `/tmp`); NetworkPolicy blocks egress to `169.254.169.254` and ingress to
  `/metrics` from outside monitoring; the grafana_alerts webhook rejects an unsigned/ bad-HMAC
  POST; a core-only deployment (`modules.enabled=false`) has no `HASS_TOKEN`/`GRAFANA_TOKEN` in
  its Secret; `cosign verify` succeeds for both images and the admission policy rejects an
  unsigned carrier image.

## Deferred (not in this pass)
- Slim `BotConfig`/`loadConfig` to core-only fields; move feature env reads into each module via
  exported `env()/envList()/envBool()`, so core never references a module's config.
- Optional: bundle each module with esbuild (externals `lumi`, `matrix-js-sdk`) to eliminate the
  carried `node_modules` entirely — revisit if module-only deps proliferate.
- **SSRF hardening** in the `http` module: block RFC1918 / link-local / `169.254.169.254` /
  loopback in `isAllowed()` (http.ts:55), in addition to the allowlist.
- Per-command authorization / admin-user check (pre-existing CISO gap, unaffected by the split).
