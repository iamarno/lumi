# lumi Helm chart

Deploys the [lumi](https://github.com/iamarno/lumi) Matrix bot on a single Kubernetes cluster (one replica, not HA — one Matrix session). Feature modules from [lumi_modules](https://github.com/iamarno/lumi_modules) are an optional add-on delivered by an init container.

## Quick start

```bash
# Core-only bot, secrets from Vault via External Secrets Operator
helm install lumi charts/lumi --set externalSecrets.enabled=true

# With feature modules
helm install lumi charts/lumi \
  --set modules.enabled=true \
  --set modules.image=ghcr.io/iamarno/lumi_modules --set modules.tag=1.0.0 \
  --set externalSecrets.enabled=true
```

## How modules are delivered

With `modules.enabled=true`, an init container runs the `lumi_modules` carrier image and copies the compiled modules (+ their `node_modules`) into an `emptyDir` volume. The core container mounts it **read-only** at `/app/modules` and loads it via `LUMI_MODULES_DIR`. Omit `modules.enabled` for a core-only bot. Swapping the module set = changing `modules.tag`/`modules.digest` + rollout; no core rebuild.

## Secrets

All configuration secrets flow through **one** Kubernetes Secret consumed via `envFrom`. Provide it one of three ways (first match wins):

| Value | Use |
|---|---|
| `existingSecret` | You manage the Secret yourself (any tooling) |
| `externalSecrets.enabled` | Vault → [External Secrets Operator](https://external-secrets.io/) → Secret. `corePath` is always synced; `modulesPath` only when `modules.enabled=true`, so core-only deployments never mount module tokens. |
| `secretEnv` | Inline values rendered to a plain Secret — dev/test only |

**Rotation = pod restart** (`kubectl rollout restart deploy/<release>`): `envFrom` values are fixed at pod start, and `!lumi reload` is inert in-cluster (no `.env` file). Consider [stakater/reloader](https://github.com/stakater/Reloader) keyed on the Secret.

## Security posture

- Pod: `runAsNonRoot` (65532), read-only root filesystem (only `/data`, `/tmp`, and the read-only modules mount), no capabilities, `RuntimeDefault` seccomp, no service-account token.
- **NetworkPolicy** (on by default): default-deny ingress — metrics only from `networkPolicy.metricsFrom`, webhook only from `networkPolicy.webhookFrom`; egress limited to DNS + `egressPorts`, always excluding the cloud metadata endpoint (`egressDeny`). Vanilla NetworkPolicy cannot match DNS names — use a CNI FQDN policy (e.g. Cilium) for tighter egress.
- **Pin images by digest** in production (`image.digest`, `modules.digest`) and enforce cosign verification at admission (both images are keyless-signed) — the init container injects executable code into the bot process; see `README_CISO.md` (module trust boundary).
- If `webhook.enabled`, treat `GRAFANA_ALERTS_SECRET` as **mandatory**.
- Use an encrypted-at-rest `persistence.storageClass`; module state (`ModuleStore` JSON) is written to the PVC in plaintext.

## Values

See [values.yaml](values.yaml) — every key is commented. Highlights:

| Key | Default | Description |
|---|---|---|
| `image.repository` / `tag` / `digest` | `ghcr.io/iamarno/lumi` / `2.0.0` / – | Core bot image (digest wins) |
| `modules.enabled` | `false` | Deploy feature modules via init container |
| `modules.image` / `tag` / `digest` | `ghcr.io/iamarno/lumi_modules` / `1.0.0` / – | Carrier image |
| `existingSecret` | – | Name of a pre-existing env Secret |
| `externalSecrets.*` | disabled | ESO store ref + Vault paths (core / modules) |
| `secretEnv` | `{}` | Inline secret env (dev/test) |
| `env` | `{}` | Non-secret env vars |
| `persistence.size` / `storageClass` | `1Gi` / cluster default | RWO state volume for `/data` |
| `metrics.enabled` / `port` | `false` / `9091` | Prometheus exporter + Service (+ optional ServiceMonitor) |
| `webhook.enabled` / `port` | `false` / `9093` | Grafana alerts webhook port (module) |
| `networkPolicy.*` | enabled | Ingress sources, egress ports, denied CIDRs |

## No liveness probe?

The distroless image has no shell and the bot exposes no health endpoint by default. If `metrics.enabled=true` you can add a `tcpSocket` probe on the metrics port via a values override; a first-class `/healthz` is a possible future core feature.
