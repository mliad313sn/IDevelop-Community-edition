# IDevelop Community Edition — production container (multi-stage).
# Reproducible, horizontally-scalable artifact for Docker Compose / Kubernetes
# (the app ships /health, /readyz and /metrics for orchestration). Schema
# migrations run automatically on boot.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS run
LABEL org.opencontainers.image.title="IDevelop Community Edition" \
      org.opencontainers.image.description="Open-source skills, talent and continuous-performance platform" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENV NODE_ENV=production
WORKDIR /app
# tini for correct PID-1 signal handling (graceful shutdown).
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Drop privileges.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3000
# Container healthcheck hits the readiness probe (DB up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
