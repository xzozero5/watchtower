# Gmail push over a Cloudflare quick tunnel (ADR-020, dev/POC only). Build context: tools/.
#   docker compose --profile gmail-tunnel up -d gmail-tunnel
# No credential is baked in: the subscription-admin key file is mounted read-only at run time.

# Official cloudflared image, pinned by version and digest; bump on purpose.
FROM cloudflare/cloudflared:2026.10.2@sha256:0e56c13c7058fcef9c4f0e7d83372f82330548dbf8f8b366f3d8b506526d93b2 AS cloudflared

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app
COPY push-only-filter/server.mjs push-only-filter/filter.mjs ./push-only-filter/
COPY gmail-tunnel/tunnel.mjs gmail-tunnel/server.mjs ./gmail-tunnel/

ENV HOME=/tmp
USER node

# Healthy only once the subscription points at this container's tunnel.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:4319/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "gmail-tunnel/server.mjs"]
