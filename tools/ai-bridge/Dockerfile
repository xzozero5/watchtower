# Long-running AI bridge (ADR-031). Build context: tools/ai-bridge.
# No credential is baked in: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and
# CLAUDE_CLI_BRIDGE_TOKEN arrive as environment variables at run time.
FROM node:22-bookworm-slim

# Pinned; bump on purpose and re-check `claude -p --output-format json` (ADR-017 consequences).
ARG CLAUDE_CODE_VERSION=2.1.316
ARG CODEX_VERSION=0.166.0-alpha.5.1
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

WORKDIR /app
COPY bridge.mjs server.mjs ./

# Listens on the compose network only (the compose file publishes no port). The bearer token is
# still required for /v1/generate; /healthz is open and says only "ok" and "online".
ENV AI_BRIDGE_HOST=0.0.0.0 \
    AI_BRIDGE_PORT=4317 \
    AI_BRIDGE_MODE=codex \
    HOME=/home/node
USER node
EXPOSE 4317

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4317/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.mjs"]
