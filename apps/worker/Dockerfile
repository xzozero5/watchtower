# syntax=docker/dockerfile:1.7
# Watchtower worker image (BullMQ consumers + health server). Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t watchtower/worker:local .
# The same image runs in docker compose and on Cloud Run (ADR-001, min instances >= 1 there).
# Configuration comes from the environment only; the health server listens on $PORT or $WORKER_PORT.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --include-workspace-root --filter "@watchtower/worker..."
RUN pnpm turbo run build --filter=@watchtower/worker...
RUN pnpm deploy --filter=@watchtower/worker --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    WORKER_PORT=4100
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4100
CMD ["node", "dist/main.js"]
