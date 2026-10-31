# syntax=docker/dockerfile:1.7
# Watchtower API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t watchtower/api:local .
# The same image runs in docker compose and on Cloud Run (ADR-001): configuration comes from the
# environment only, the app listens on $PORT (Cloud Run) or $API_PORT, and nothing is written to disk.

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
    pnpm install --frozen-lockfile --include-workspace-root --filter "@watchtower/api..."
RUN pnpm turbo run build --filter=@watchtower/api...
# Self-contained production tree: dist, prod dependencies and the workspace packages it needs
# (including @watchtower/db with its SQL migrations, used by the compose `migrate` service).
RUN pnpm deploy --filter=@watchtower/api --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    API_PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
