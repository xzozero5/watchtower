# 09 — Security checklist

> Living checklist. Every security review (`security-reviewer`) checks the items for its scope, records findings in `docs/STATUS.md`, and adds new items here. Status per item: `[TESTED]` covered by an automated test, `[REVIEWED]` read in code review only, `[OPEN]` known gap with a BACKLOG task.
> Non-negotiables N1, N2, N4, N9 in `AGENTS.md` are the root rules; PRD §8.2 is the requirement source.

## 1. Secrets and configuration (N1, ADR-004)
- [ ] Infra secrets only in the environment; integration credentials in env or DB encrypted (envelope, ADR-004) — T-116 for the DB store `[OPEN]`
- [ ] No secret value in logs, audit rows, API responses, error messages, test output `[REVIEWED]`
- [x] Boot refuses placeholder/weak `JWT_SECRET` / `APP_ENCRYPTION_KEY` outside loopback dev — T-010 C-1 `[TESTED]`
- [x] Dev-login only with explicit `DEV_LOGIN_ENABLED=true`, mock Google, non-production, and only for dev-created accounts — T-010 C-1 `[TESTED]`
- [ ] `.env*` never committed (pre-commit) `[TESTED]` · org-specific terms blocked by local `.git/info/forbidden-terms` (list supplied by the owner)

## 2. Authentication and session (PRD §2.3, ADR-005)
- [x] Google OIDC with PKCE S256, state, nonce, JWKS verification, `hd` + `email_verified` `[TESTED]`
- [x] Magic link single-use, short TTL, token in URL fragment removed with `replaceState` `[TESTED]`
- [x] Refresh rotation with reuse detection → revoke family `[TESTED]`
- [x] CSRF: HMAC token + Origin check, `null` origin rejected `[TESTED]`
- [x] Cookies use `__Host-` prefix when Secure; duplicate auth cookies rejected — T-010 C-6 `[TESTED]`
- [x] Break-glass lockout per (account, IP) with backoff + CLI unlock — T-010 C-7 `[TESTED]`
- [ ] Expired sessions / refresh / magic-link tokens purged — T-117 `[OPEN]`

## 3. Authorization and data scoping
- [x] RBAC deny-by-default; every route must be in the policy table (`route_not_configured`) `[TESTED]`
- [x] Client users see only their org over REST, timeline and WebSocket; internal notes never reach clients `[TESTED]`
- [ ] Permission matrix reviewed by the real team (`[ASSUMED]`, T-115)

## 4. Audit and privacy (PRD §8.2, PDPA)
- [x] Audit log append-only (no UPDATE/DELETE for the app role), partitioned `[TESTED]`
- [x] Audit rows hold ids/statuses, not message text; PII reads audited (`@AuditPiiRead`) `[TESTED]`
- [x] User snapshots in audit minimised like contacts — T-010 C-9 `[TESTED]`
- [ ] Retention / crypto-shred ADR for PDPA erasure `[OPEN]`
- [ ] PII redaction before every LLM call, `RedactedText` type — T-106 (N4) `[OPEN]`

## 5. Public portal (ADR-007)
- [x] Self-hosted human verification: PoW + honeypot + minimum fill time + rate limits; no third-party destination `[TESTED]`
- [x] Rate-limit order: stateless PoW check before per-email/per-org buckets — T-010 C-3 `[TESTED]`
- [x] Unverified requesters cannot raise P1 — T-010 C-4 `[TESTED]`
- [x] Tracking links: HMAC, hash stored, revocable, identical 401 for every failure (no enumeration) `[TESTED]`
- [x] Tracking TTL 30 days default, revoked on close — T-010 C-13 `[TESTED]`

## 6. Outbox and email (ADR-006)
- [x] Secret fields in `outbox.payload` and BullMQ jobs encrypted; rows expire with the secret's TTL — T-010 C-2 `[TESTED]`
- [ ] Dead-letter visible to head — T-121 `[OPEN]`
- [x] Customer emails never echo attacker-controlled text as the company — T-010 C-11 `[TESTED]`

## 7. Transport, headers, deployment
- [x] API: nosniff, `frame-ancestors 'none'`, `no-store` on auth, HSTS in production — T-010 C-5 `[TESTED]`
- [ ] Web: CSP with `connect-src` limited to self + API URL, `frame-ancestors 'none'`, `object-src 'none'` — headers exist, but `script-src 'unsafe-inline'` and a build-time `connect-src` fallback remain → T-125
- [x] Compose ports bound to 127.0.0.1, `read_only`, `cap_drop: ALL`, `no-new-privileges` `[REVIEWED]`
- [ ] Trusted proxy hops correct behind Caddy; :4000 not published in the proxied profile — T-010 C-8 · override `docker-compose.proxy.yml` มีแล้ว ยังไม่รันกับ Caddy จริง `[VERIFY]` → T-125
- [x] Third-party images pinned by digest (MinIO fork, ADR-003) — T-010 C-14 `[TESTED]`
- [x] Service worker caches only same-origin static assets, never HTML or API `[REVIEWED]`

## 8. Integrations and AI (Phase 1 — T-114)
- [ ] Webhook signatures verified on raw body (LINE HMAC, Discord Ed25519, Pub/Sub OIDC) `[OPEN]`
- [ ] Mock mode makes no network calls (`disableNetConnect` in tests) `[OPEN]`
- [ ] Investigation tools read-only with allow-listed tables/views; never `outbox`, sessions, tokens (N2) `[OPEN]`
- [ ] AI tool allow-list per intent; every AI action in `ai_run` (N4) `[OPEN]`
- [ ] KB crawler and Web Push SSRF guards (no RFC1918, link-local, metadata IP) `[OPEN]`

## 9. Dependencies
- [x] `pnpm audit --prod` clean on 2026-11-01 `[TESTED]`
- [x] Runtime deps only where used (`bullmq` in api) — T-010 C-12 `[TESTED]`
- [ ] New runtime network destination requires `[ASK-HUMAN]` (AGENTS.md)
