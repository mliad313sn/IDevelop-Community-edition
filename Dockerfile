# syntax=docker/dockerfile:1
# IDevelop Community Edition — production container (multi-stage).
# Reproducible, horizontally-scalable artifact for Docker Compose / Kubernetes
# (the app ships /health, /readyz and /metrics for orchestration). Schema
# migrations run automatically on boot.
#
# Supply-chain / CIS Docker Benchmark notes (docs/SECURITY-SUPPLY-CHAIN.md):
#   - base image pinned by digest (CIS 4.2 trusted base; Scorecard Pinned-Dependencies);
#     Dependabot (docker ecosystem) proposes digest bumps weekly.
#   - production dependencies only, installed from the lockfile (npm ci --omit=dev).
#   - application code is owned by root and read-only to the runtime user; only
#     the state directories below are writable (CIS 4.1 non-root user).
#   - no secrets in any layer: .dockerignore excludes .env*, keys and .git (CIS 4.10).
#   - HEALTHCHECK on the readiness probe (CIS 4.6).
#   - setuid/setgid bits stripped (CIS 4.8).
#   - the npm/npx/corepack CLIs are removed from the runtime stage (CIS 4.3: only
#     what the app needs; their bundled dependencies were the image's only
#     HIGH findings besides the app's own). Run operator scripts with `node
#     scripts/<name>.js`, which is all the matching npm scripts do.

# node:22-alpine, multi-arch index digest resolved 2026-09-29 (Node 22.23.x).
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS run
LABEL org.opencontainers.image.title="IDevelop Community Edition" \
      org.opencontainers.image.description="Open-source skills, talent and continuous-performance platform" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/mliad313sn/IDevelop-Community-edition"
# All mutable state lives under /app/data (one volume to back up).
ENV NODE_ENV=production \
    UPLOADS_DIR=/app/data/uploads \
    QUARANTINE_DIR=/app/data/uploads/_quarantine \
    BACKUP_DIR=/app/data/backups/auto \
    AUDIT_ANCHOR_DIR=/app/data/audit-anchors \
    SQL_CONSOLE_BACKUP_DIR=/app/data/sql-restore-points
WORKDIR /app
# tini for correct PID-1 signal handling (graceful shutdown). Fixed UID/GID so
# volume ownership and compose tmpfs mounts (uid=10001) are predictable.
RUN apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && addgroup -S -g 10001 app \
    && adduser -S -D -u 10001 -G app -h /home/app app
# Code and dependencies stay root-owned: the runtime user can read, not modify.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Writable state. multer stages uploads in /app/tmp and then rename()s them into
# UPLOADS_DIR; a rename cannot cross mount points (EXDEV), so tmp is a symlink
# into the same /app/data volume. logs/ is written by winston at /app/logs;
# AI_Engine_Docs/tmp is the data-import staging folder (ephemeral).
RUN mkdir -p /app/data/tmp /app/data/logs /app/data/uploads/_quarantine \
             /app/data/backups/auto /app/data/audit-anchors /app/data/sql-restore-points \
             /app/AI_Engine_Docs/tmp \
    && ln -s /app/data/tmp /app/tmp \
    && ln -s /app/data/logs /app/logs \
    && chown -R app:app /app/data /app/AI_Engine_Docs \
    && chmod -R u=rwX,g=,o= /app/data /app/AI_Engine_Docs \
    && { find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true; }
USER app:app
EXPOSE 3000
# Container healthcheck hits the readiness probe (DB up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
