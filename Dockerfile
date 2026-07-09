# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Install only production deps in a clean layer so Docker cache stays warm
# when only source changes. npm ci keeps installs pinned to the lockfile.
# The node_modules/lumi self-symlink lets externally mounted feature modules
# (LUMI_MODULES_DIR, see the lumi_modules repo) resolve `require("lumi")`
# to this image's own compiled core. Created here because the distroless
# runtime stage has no shell; Docker COPY preserves the symlink.
FROM node:24-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && ln -s /app /app/node_modules/lumi \
 && mkdir -p /data

# ── Stage 2: build ─────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build

# ── Stage 3: runtime ───────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

# OCI image labels (values injected by CI via --build-arg)
ARG VERSION=dev
ARG REVISION=unknown
ARG BUILD_DATE=unknown
ARG REPO=local/lumi

LABEL org.opencontainers.image.title="lumi" \
      org.opencontainers.image.description="Lumi — a friendly, modular Matrix bot in TypeScript" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/${REPO}" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps    /app/node_modules ./node_modules
# Copy compiled JS from builder stage
COPY --from=builder /app/dist         ./dist
# package.json needed for runtime metadata
COPY                package.json      ./

# Persistent state dir (stores Matrix sync token between restarts)
# Created in deps stage; copied with nonroot uid/gid (65532 = distroless nonroot)
COPY --from=deps --chown=65532:65532 /data /data
VOLUME ["/data"]
ENV LUMI_STATE_DIR=/data

# Lumi uses only outbound connections — nothing to expose
# :nonroot tag already sets USER 65532 — no USER instruction needed

CMD ["dist/lumi.js"]
