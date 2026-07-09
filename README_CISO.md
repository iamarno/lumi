# Lumi security briefing — CISO edition

---

## What's safe and why

**E2EE is real, not theatre.** Messages are encrypted end-to-end using the Rust SDK (Vodozemac / Double Ratchet). The crypto stack is the same one Element uses. Key material never leaves the process in plaintext.

**Key persistence is atomic.** The crypto store write is tmp → rename → bak. A crash mid-write leaves either the previous primary or the backup intact — no partial state that could corrupt the identity.

**Cross-signing bootstrap is gated on two secrets.** Both `MATRIX_CRYPTO_PASSWORD` (SSSS) and `MATRIX_PASSWORD` (UIA) must be set for bootstrap to run. Neither is logged.

**SSSS key is derived, not random.** The PBKDF2 derivation (500k iterations) means restarts don't generate new keys — the same key is always reconstructed from the passphrase. No key material is stored in plaintext env vars (the passphrase is, but not the derived key).

**Verification requires human confirmation.** The SAS flow posts emojis to the admin room and waits for explicit `!lumi verify confirm`. A rogue verification request can't auto-complete.

---

## Module trust boundary

**The lumi / lumi_modules split is a code-organization boundary, not a privilege boundary.** Feature modules are `require()`d into the core process and run with full privileges: any module can read every environment secret (`MATRIX_ACCESS_TOKEN`, `MATRIX_CRYPTO_PASSWORD`, `MATRIX_PASSWORD`, `HASS_TOKEN`, `GRAFANA_TOKEN`, `GRAFANA_ALERTS_SECRET`), the crypto store, the state volume, and the network. Consequences:

- Authoring or reviewing a module is a **privileged change**. The `lumi_modules` repo must carry the same branch protection and review bar as core.
- In Kubernetes, the modules init container injects executable code into the bot. Pin the carrier image **by digest**, and enforce cosign signature verification at admission (Sigstore policy-controller or Kyverno) for both images.
- Deploy core-only (`modules.enabled=false`) where feature modules are not needed — module secrets are then never mounted (the Helm chart's ExternalSecret template only pulls them when modules are enabled).

Deployment security checklist (Helm chart): NetworkPolicy enabled, images pinned by digest, ESO-managed Secret, secret rotation = pod restart, read-only root filesystem, no service account token.

---

## What's not safe / current flaws

**No per-command authorization.** `LUMI_ALLOWED_USERS` and `LUMI_ALLOWED_ROOMS` restrict who lumi talks to, but there is no role system — any allowlisted user can run any command, including `!lumi reload` if `LUMI_ALLOW_ENV_RELOAD=true`.

**The admin room is a single point of trust.** The verification confirmation is only as secure as whoever can send `!lumi verify confirm` in the admin room. If that room is compromised or another bot is in it, an attacker could confirm a rogue verification. There's no per-user ACL on the confirm command.

**`globalBlacklistUnverifiedDevices = false`.** Lumi sends encrypted messages to unverified devices. This is intentional (otherwise lumi couldn't communicate with anyone until they're verified), but it means lumi doesn't enforce a verified-device policy for recipients. An attacker who adds an unverified device to a user's account will receive lumi's messages.

**`MATRIX_CRYPTO_PASSWORD` in plaintext env.** The passphrase that protects both the on-disk store and the SSSS key lives in `.env` / environment variables. On a compromised host, an attacker can read it, derive the SSSS key, and extract all cross-signing private keys from the server. This is a systemic limitation of secret management via env vars — not unique to lumi.

**No verification request rate limiting.** Any user can spam verification requests. Lumi will accept each one, start SAS, and post to the admin room. Low-effort DoS against the admin room.

**Session key forward secrecy gap.** Lumi uses `MemoryStore` (not a persistent room state store). On restart, it can't decrypt messages sent before it re-joined the sync. This is by design but worth noting — there's no key backup configured, so historical messages in encrypted rooms are unrecoverable after a fresh device registration.

---

## What to improve

**Per-command authorization.** Basic user/room allowlisting is implemented via `LUMI_ALLOWED_USERS` / `LUMI_ALLOWED_ROOMS`, but there is no role system. High-risk commands (`!lumi reload`, `!lumi verify confirm`) should only be executable by a designated admin user ID.

**Per-command authorization.** Some commands (`!lumi reload`, `!lumi verify confirm`) are higher-risk than others. A simple role system — e.g. only the room admin or a configured admin user ID can run privileged commands — would reduce blast radius significantly.

**Admin room sender check.** `!lumi verify confirm` should only be accepted from a configured `LUMI_ADMIN_USER` Matrix ID, not from any participant in the admin room.

**Verification rate limiting.** Reject or ignore verification requests from the same user more than N times per hour.

**Secret management.** Replace env var secrets with a secrets manager (Vault, AWS Secrets Manager, Docker secrets). At minimum, document that `.env` must not be world-readable and should be mounted read-only in the container.

---

## Post-quantum cryptography (PQC)

Currently **not PQC-safe**. The E2EE stack uses:

- **Curve25519** (Olm key agreement) — vulnerable to a sufficiently large quantum computer via Shor's algorithm
- **Ed25519** (cross-signing signatures) — same exposure
- **AES-256** (symmetric encryption) — considered quantum-resistant at its current key size (Grover's algorithm halves effective key length, 128-bit post-quantum security remains)

The Matrix spec has a PQC roadmap (MSC3897 and related proposals) targeting **ML-KEM / Kyber** for key encapsulation. The Rust SDK is expected to implement this once the spec stabilises. Lumi will get this for free when matrix-js-sdk ships it — no lumi-specific work needed. Timeline: uncertain, likely 1–2 years before it's production-ready in the SDK.

Practically: "harvest now, decrypt later" attacks are the realistic PQC threat. If lumi is used for high-sensitivity communications today, assume those messages could be decrypted by a quantum-capable adversary in the future.

---

## Summary risk table

| Risk | Severity | Mitigated? |
|---|---|---|
| Unauthenticated command access | High | Partial — allowlist via `LUMI_ALLOWED_USERS` / `LUMI_ALLOWED_ROOMS` |
| Admin room takeover → rogue verify | Medium | Partial — human confirm required |
| Env var secret exposure on compromised host | High | No — systemic |
| Unverified device recipients | Medium | By design, documented |
| Verification spam / DoS | Low | No |
| PQC / harvest now decrypt later | Long-term | No — SDK roadmap |
