# syntax=docker/dockerfile:1
# Build from the repository root, because the web app depends on workspace packages:
#   docker build -f apps/web/Dockerfile -t watchtower-web .
# One image for compose and Cloud Run (ADR-001). Nothing environment-specific is baked in:
# set API_URL when the container starts, not when the image is built.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable
WORKDIR /repo
# .dockerignore keeps .env files, docs, logs and node_modules out of this copy.
COPY . .
# Only the web app and the workspace packages it needs.
RUN pnpm install --frozen-lockfile --filter @watchtower/web...
RUN pnpm exec turbo run build --filter=@watchtower/web

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone output already holds the traced server and the node_modules it needs. Next.js
# leaves static files and public/ out of it on purpose, so they are copied next to server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
# The official node image ships an unprivileged "node" user (uid 1000).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
