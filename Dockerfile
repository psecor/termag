# syntax=docker/dockerfile:1.7
#
# termag ORCHESTRATOR image — the control plane only (backend API/WebSockets,
# the built frontend, and the Prisma schema tooling). It runs no agents and no
# tmux: every project must be pinned to a box or a self-managed agent
# (LOCAL_SESSIONS_ENABLED=false is baked in). Boxes are still EC2 instances the
# backend provisions via the AWS SDK; see docs/container-deploy.md for the
# runtime contract (env, ports, health, DB, auth modes, IAM).
#
# Targets:
#   runtime     (default) the server.
#   migrations  the same image with a shim so Shepherd's fixed Alembic command
#               runs our schema sync instead (see backend/scripts/opentelemetry-instrument).
#
# Build:   docker build -t termag-orchestrator .
#          docker build --target migrations -t termag-orchestrator-migrations .
# Run:     docker run --rm -p 3040:3040 --env-file backend/.env termag-orchestrator
# Schema:  docker run --rm --env-file backend/.env termag-orchestrator npm --prefix backend run db:push
#
# Runs as an unprivileged fixed UID with a read-only root filesystem in mind:
# nothing under /app is written at runtime; scratch goes to /tmp.

ARG NODE_VERSION=20

# ── build: compile backend (tsc) + frontend (vite) with the full dev toolchain ──
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
ENV npm_config_update_notifier=false
COPY backend/package.json backend/package-lock.json backend/
COPY frontend/package.json frontend/package-lock.json frontend/
RUN --mount=type=cache,target=/root/.npm \
    cd backend && npm ci --no-audit --no-fund \
 && cd ../frontend && npm ci --no-audit --no-fund
COPY backend backend
COPY frontend frontend
RUN cd backend && npm run db:generate && npm run build \
 && cd ../frontend && npm run build

# ── prod-deps: production node_modules with the Prisma client generated in place ──
# Done in its own stage (rather than pruning the build stage) so the generated
# client under node_modules/.prisma is produced against exactly the modules
# that ship. `prisma` is a runtime dependency here on purpose: the image is
# also what runs `db:push` during deploys.
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /src/backend
ENV npm_config_update_notifier=false
COPY backend/package.json backend/package-lock.json ./
COPY backend/prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
 && npx prisma generate

# ── runtime ──
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3040 \
    BASE_PATH=/termag \
    LOCAL_SESSIONS_ENABLED=false \
    npm_config_update_notifier=false
# openssl: Prisma's query engine links against libssl. tini: PID 1 signal
# forwarding + zombie reaping for the few child processes the backend spawns.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 termag \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/termag --shell /usr/sbin/nologin termag
WORKDIR /app
# Amazon's RDS certificate bundle so IAM-auth connections (which RDS requires to
# be TLS) verify the server certificate. backend/src/config/env.ts picks this
# path up by default; PG_SSL_CA_FILE overrides it.
ADD --chown=10001:10001 --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem certs/rds-global-bundle.pem
# Layout mirrors the source tree because the backend resolves the frontend
# bundle, the Sound Garden SPA and the AGENTS.md seed template relative to
# its own dist/ directory (../../frontend/dist, ../../sound-garden,
# ../../../agent/initial-AGENTS.md).
COPY --from=prod-deps --chown=10001:10001 /src/backend/node_modules backend/node_modules
COPY --from=build     --chown=10001:10001 /src/backend/package.json backend/package.json
COPY --from=build     --chown=10001:10001 /src/backend/prisma       backend/prisma
COPY --from=build     --chown=10001:10001 /src/backend/dist         backend/dist
COPY --from=build     --chown=10001:10001 /src/frontend/dist        frontend/dist
COPY --chown=10001:10001 sound-garden            sound-garden
COPY --chown=10001:10001 agent/initial-AGENTS.md agent/initial-AGENTS.md
USER 10001:10001
EXPOSE 3040
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/dist/index.js"]

# ── migrations: Shepherd's pre-deploy migration container ──
# Shepherd runs `opentelemetry-instrument alembic upgrade head` here as UID
# 65534 with PG_HOST/PG_DATABASE/PG_USER=migration/PG_PORT and no password; the
# shim ignores its arguments and runs the IAM-authenticated schema sync.
FROM runtime AS migrations
COPY --chmod=0755 backend/scripts/opentelemetry-instrument /usr/local/bin/opentelemetry-instrument
ENV PG_IAM_AUTH=true
USER 65534:65534
CMD ["opentelemetry-instrument", "alembic", "upgrade", "head"]
