# 09 — Security checklist

> Living checklist. Every security review (`security-reviewer`) checks the items for its scope, records findings in `docs/STATUS.md`, and adds new items here. Status per item: `[TESTED]` covered by an automated test, `[REVIEWED]` read in code review only, `[OPEN]` known gap with a BACKLOG task.
> Non-negotiables N1, N2, N4, N9 in `AGENTS.md` are the root rules; PRD §8.2 is the requirement source.

## 1. Secrets and configuration (N1, ADR-004)
- [ ] Infra secrets only in the environment; integration credentials in env or DB encrypted (envelope, ADR-004) — store + API + `credentials rotate` built in T-116a (ADR-012, `[TESTED]`); `security-reviewer` review and the admin UI (T-116c) `[OPEN]`
- [x] Integration credentials are write-only over HTTP, env wins over DB, head only, audit rows hold field names only, a test greps logs, responses and audit for the plaintext — T-116a `[TESTED]`
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
- [x] Expired sessions / refresh / magic-link tokens, tracking links and old break-glass counters purged daily by the worker (`cleanup` queue, batches, indexes in 0011); a counter that still locks is kept — T-117 `[TESTED]`

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
- [x] Status page subscribe (T-207a C-3): the same PoW as the portal (`GET /v1/status/subscriptions/challenge` + `verification` + honeypot), checked before the per-address/domain/page buckets; limits per IP (IPv6 by /64), per address, per receiving domain (30/h), page-wide (200/h, 1000/day; reaching one is logged at error level and audited) — all `[ASSUMED]` numbers `[TESTED]`
- [x] Status mail (T-207a C-7): `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058, one-click endpoint takes only an unsubscribe token); 3 hard bounces in a row suppress the address (migration 0093) `[TESTED]`

## 5b. Investigation tools and the product database (ADR-016, T-207a)
- [x] The mock product database runs in a Postgres server of its own with a memory limit (compose profile `product-mock`), not in the Watchtower cluster; ad-hoc data statements are off unless `PRODUCT_DB_ADHOC_ENABLED=true`, limited to 5 a minute and 100 rows a person, and refuse memory-hog forms (`repeat`, `array_agg`, `WITH RECURSIVE`, …) (C-1) `[TESTED]`
- [x] `grants.sql` revokes EXECUTE on functions of every non-system schema from PUBLIC and sets default privileges; `hardeningProblems()` also refuses ad-hoc when a dangerous extension is installed, the reader is a member of a server-file/program role, or it can run a non-system function (C-4) `[TESTED]`
- [x] A usage metric's dimensions must be allow-listed columns or names that do not look personal (C-5); a deploy feed URL carries no userinfo and no query/fragment (C-6); Discord interactions have their own per-IP and per-user limits (C-8); an evidence-card excerpt that reaches other organizations redacts their people too (C-9); `LOG_REDACT_PATHS` covers `Authorization` in every case and depth that a Pub/Sub or HTTP-client log can carry (C-10) `[TESTED]`
- [ ] BigQuery path (C-2): guard by IAM + dry-run before T-208 `[OPEN]`

## 6. Outbox and email (ADR-006)
- [x] Secret fields in `outbox.payload` and BullMQ jobs encrypted; rows expire with the secret's TTL — T-010 C-2 `[TESTED]`
- [ ] Dead-letter visible to head — T-121 `[OPEN]`
- [x] Customer emails never echo attacker-controlled text as the company — T-010 C-11 `[TESTED]`

## 7. Transport, headers, deployment
- [x] API: nosniff, `frame-ancestors 'none'`, `no-store` on auth, HSTS in production — T-010 C-5 `[TESTED]`
- [x] Web: CSP with a per-response nonce (`script-src 'self' 'nonce-…' 'strict-dynamic'`, no `'unsafe-inline'` for scripts) and `connect-src` = self + `API_URL` read at run time, sent by `apps/web/src/proxy.ts` (T-125 C-5); `frame-ancestors 'none'`, `object-src 'none'`. `style-src` keeps `'unsafe-inline'` (React inline style attributes cannot carry a nonce) `[TESTED]` unit + a production build served and checked: every `<script>` in `/login` carried the nonce
- [x] Compose ports bound to 127.0.0.1, `read_only`, `cap_drop: ALL`, `no-new-privileges` `[REVIEWED]`
- [ ] Trusted proxy hops correct behind Caddy; :4000 not published in the proxied profile — T-010 C-8 · override `docker-compose.proxy.yml` มีแล้ว ยังไม่รันกับ Caddy จริง `[VERIFY]` → T-125
- [x] Third-party images pinned by digest (MinIO fork, ADR-003) — T-010 C-14 `[TESTED]`
- [x] Service worker caches only same-origin static assets, never HTML or API `[REVIEWED]`

## 8. Integrations and AI (Phase 1 — T-114)
- [x] Sign-in limits and upload quotas: the subject part of a Redis counter key is an HMAC (key derived from `APP_ENCRYPTION_KEY`), not a bare SHA-256; break-glass counts an IPv6 client as its /64 (T-125 C-7) `[TESTED]`
- [x] `/docs` (OpenAPI) is never served when `NODE_ENV=production`, whatever `DOCS_ENABLED` says (T-125 QA-33) `[TESTED]`
- [x] A replayed portal proof-of-work is turned away by a read-only check before the email/organization limits can be spent (T-125 C-17) `[TESTED]`
- [ ] Webhook signatures verified on raw body (LINE HMAC, Discord Ed25519, Pub/Sub OIDC) `[OPEN]`
- [ ] Mock mode makes no network calls (`disableNetConnect` in tests) `[OPEN]`
- [ ] Investigation tools read-only with allow-listed tables/views; never `outbox`, sessions, tokens (N2) `[OPEN]`
- [ ] AI tool allow-list per intent; every AI action in `ai_run` (N4) `[OPEN]`
- [ ] KB crawler and Web Push SSRF guards (no RFC1918, link-local, metadata IP) `[OPEN]`

## 9. Dependencies
- [x] `pnpm audit --prod` clean on 2026-11-01 `[TESTED]`
- [x] Runtime deps only where used (`bullmq` in api) — T-010 C-12 `[TESTED]`
- [ ] New runtime network destination requires `[ASK-HUMAN]` (AGENTS.md)

## 10. Uploaded files and egress (ADR-022, T-155)
- [x] Malware scan: `UPLOAD_SCAN=off|clamav` (default off). With `clamav` a file is served (ticket and staff download) and attached to outgoing mail only when its `object_scan` row is `clean`; no row, `pending` and `error` are all "not yet" (fail closed); `infected` → object deleted, audit `upload.scan_infected`, internal ticket note `[TESTED]` (fake clamd over TCP; the real ClamAV image has not been run `[UNVERIFIED 70%]`)
- [x] Admin notice when the scan is off: `GET /v1/admin/upload-scan` → `notice: "scan_off"` (head only) `[TESTED]`
- [x] Daily caps on customer files through the portal (T-155a C-1): per client address, per email address and per organization (`PORTAL_UPLOAD_IP_DAILY_MB` 100, `PORTAL_UPLOAD_EMAIL_DAILY_MB` 50, `PORTAL_UPLOAD_ORG_DAILY_MB` 512, `[ASSUMED]`) and `PORTAL_UPLOAD_DAILY_MB` (2048) for the whole instance as the backstop; 429 `upload_quota`. Counted in Redis in one atomic Lua step (`INCRBY` on every cap or none), refunded when the submission fails, fixed 24 h windows. Reaching the instance-wide cap writes an audit row (`portal.attachment_rejected`, reason `upload_quota_global`), logs an error once an hour and counts `portal_upload_quota_global_total` for an alert. Not done: an in-app notification to admins (needs a new notification kind and a web label) `[OPEN]` `[TESTED]`
- [x] Unattached staff uploads are deleted after 24 h; the sweep and a request that is attaching the file exclude each other (advisory lock `staff_upload:<id>`: the claim takes it shared inside the transaction that saves the note, the sweep try-locks and skips) `[TESTED]`. Optional retention of the files of long-closed tickets (`UPLOAD_RETENTION_DAYS`, default 0 = keep) also deletes the raw message (`inbound_message.raw_object_key`, `inbound_event.raw_object_key`) of those tickets (PDPA) `[TESTED]`
- [x] An infected attachment of inbound mail deletes the raw `.eml` or payload it came from as well (it still holds the same bytes); the file is marked removed only when both are gone, otherwise the next tick retries (T-155a C-3) `[TESTED]`
- [x] clamd settings: `config/clamav/clamd.conf` (mounted read-only) sets `AlertEncrypted`, `AlertEncryptedArchive`, `AlertEncryptedDoc` and `AlertExceedsMax` to `yes`, so a password-protected archive or a file past the scan limits is answered `Heuristics.* FOUND` (infected, removed) and not `OK`. The ClamAV defaults for these are `no` `[VERIFY]` (from the ClamAV clamd.conf documentation as remembered; the page could not be fetched when this was written: confirm at https://docs.clamav.net/manual/Usage/Configuration.html for the pinned 1.5.3). Consequence: a customer's password-protected zip is refused. A test checks the lines; the real image has not been started with this file `[UNVERIFIED 70%]`
- [x] Network and container hardening of `clamav` (T-155a C-5, C-6): on network `scan` only, shared with the worker (api, web, caddy and minio are not on it), because clamd on 3310 has no authentication; `no-new-privileges`, `cap_drop: ALL` with `CHOWN SETUID SETGID DAC_OVERRIDE FOWNER` added back, `pids_limit: 200`. The capability list is a guess about what the image entrypoint needs `[UNVERIFIED 65%]`; the digest pin is unchanged (`[VERIFY]` against Docker Hub)
- [x] The clamd call has a total deadline as well as an idle timeout (`deadlineMs`, default 180 s), so a peer that answers one byte at a time cannot hold the tick (C-10). File names and signatures that go into an audit row or a ticket note lose control characters, format characters (bidi overrides, zero-width) and line separators (C-8). The `scan` queue runs one job at a time per worker process, and `markInfected` writes its audit row and ticket notes only for the run that turns `pending` into `infected`, so a second worker adds none `[TESTED]`
- [x] Upload slot (T-154): a submit with files can carry its proof of work in the `x-portal-proof` header, checked before a slot is taken (`PORTAL_UPLOAD_PROOF_HEADER=required` makes it mandatory; the default is `optional` until the web form sends the header `[OPEN]`); a reply's tracking token is checked before the slot; a sender below `PORTAL_UPLOAD_MIN_KB_PER_SECOND` (32, measured every `PORTAL_UPLOAD_IDLE_SECONDS`) is cut off and its slot freed; requests turned away count `portal_upload_busy_total` (alert on a sustained rate), cut-off senders count `portal_upload_too_slow_total` `[TESTED]`. Behind Caddy `TRUST_PROXY_HOPS` must be set, or every visitor shares the address of the proxy and so the per-address slot and caps `[VERIFY]`
- [x] Downloads stream from the object store (no whole file in api memory) `[TESTED]`
- [ ] Not covered: an object in the bucket that no database row points to (needs a bucket listing or a bucket lifecycle rule) `[OPEN]`
- **Egress added by ADR-022 (only with compose profile `scan`):** the `clamav` container runs `freshclam` to `database.clamav.net` (HTTPS) to download signatures. `api` and `worker` gain no new destination: the worker reaches clamd at `clamav:3310` on the `scan` network, which is not published to the host.
- **Network `ai` and egress of the api (ADR-023 "Live provider", T-155a C-7):** since the assistant the **api** is a member of network `ai` (with `worker` and `claude-bridge`), so the api, which faces users, can reach the bridge with its bearer token. The api holds no Anthropic credential: the OAuth token lives only in the bridge (`CLAUDE_CODE_OAUTH_TOKEN`), and it is the bridge that has egress to Anthropic. With `AI_PROVIDER=anthropic` the api itself would call Anthropic with the key from the credential store: that is egress of the api to Anthropic, off unless that provider is chosen `[ASSUMED]`. The bridge kills its `claude -p` child when the caller closes the connection (status 499 in its log), so an abandoned request does not hold a slot until the timeout `[TESTED]`.
- **Cap on AI spend with a free provider:** `AI_DAILY_TOKEN_CAP` empty means the default of `config/budgets.yaml` (`app_ai_daily.tokens`, 500000 tokens a day); it counts every non-mock provider, including `claude-cli` priced at 0, so a free provider is still bounded `[TESTED]` (unit test on `resolveAiCaps` and `evaluateBudget`).
- **Not a malware scan of what leaves:** files staff attach to a reply are held back by the same rule (not `clean` = not sent), but nothing re-scans after the fact when signatures are updated. A later signature update does not re-check files already `clean` `[ASSUMED]` acceptable for v1.

## 11. Remote images of inbound mail (T-175)
- **New egress `[ASSUMED]` — owner should know:** the **api** now opens connections to servers named in customers' mail, for staff who pressed "Display images". The destination is attacker-influenced by nature, so this is the SSRF surface of the instance. There was no guard to reuse; `apps/api/src/egress/` (`ip-guard.ts`, `safe-fetch.ts`) is written to be reused by the KB crawler and Web Push (the §8 item "KB crawler and Web Push SSRF guards" stays `[OPEN]` until they use it).
- [x] The browser sends only a position: `GET /v1/tickets/:id/messages/:mid/remote-image?u=<n>`; the address is the n-th `data-remote-src` of the stored, sanitised HTML. No URL comes from the client `[TESTED]`
- [x] `SafeImageFetcher`: https only (`REMOTE_IMAGES_ALLOW_HTTP=true` adds http); no credentials in the URL; ports 80/443 only; `localhost`, `.local`, `.internal` refused; the name is resolved once per hop and **every** answer must be public (loopback, RFC 1918, CGNAT, link-local incl. 169.254.169.254, multicast/reserved, IPv6 loopback/ULA/link-local, and the IPv4-mapped, NAT64, 6to4, Teredo forms); the socket connects to that checked address (no second lookup, so no DNS rebinding); literal IPs, including decimal and hex forms, are checked as the URL parser reads them; redirects are followed by us, at most 3, each hop re-checked; one 10 s deadline; at most 5 MB (header and stream); `Content-Type: image/*` **and** PNG/JPEG/GIF/WebP magic bytes (SVG refused); no cookies, `Authorization` or `Referer`; fixed User-Agent `Watchtower-ImageProxy/1.0`; `Accept-Encoding: identity` `[TESTED]` (fake DNS and fake sender, no internet)
- [x] Reply: type taken from the bytes, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`; every failure is the same 502 `remote_image_unavailable`, so nothing about our network reaches the person who wrote the mail `[TESTED]`
- [x] RBAC: `ticket.read` only. A client has no mail HTML; a developer (masked reader) gets 403, as for attachments, because a picture chosen by a stranger cannot be masked and a fetch tells the sender that someone from this company read the mail `[ASSUMED]`
- [x] Rate limit 300 pictures per minute per person (Redis) and 8 fetches in flight per api instance (429); in-memory cache 10 min / 32 MB per instance `[ASSUMED]`
- [x] Audit `ticket.remote_image_fetch` for every request, allowed or refused: ticket, message, position, host, a 12-hex fingerprint of the address, byte count or failure reason; never the path or query (they can hold a personal token) `[TESTED]`
- [x] The web CSP is unchanged (`img-src 'self' data: blob:`): pictures are fetched with the session and shown from `blob:` URLs; the mail iframe no longer opens `https:`/`http:` for a ticket's mail
- [ ] Not covered `[OPEN]`: the sender can still tell that someone opened the mail (the fetch comes from the api's IP, without cookies) and can serve a different picture per fetch; the proxy checks type, size and magic bytes only, not that the file is harmless to the browser's decoder; an internal DNS name that resolves to a public-looking address inside a VPC is unknowable to an address check; an outbound firewall for the api container (80/443 only) is T-125
