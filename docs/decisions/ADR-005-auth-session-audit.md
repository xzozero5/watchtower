# ADR-005 — Auth, session, CSRF, RBAC และ audit log (T-004)

- **Status:** Accepted 2026-11-01 · ตรวจโดย `security-reviewer` T-010 (2026-11-01) หลังแก้ C-1, C-6, C-7, C-16
- **Date:** 2026-10-31 (เวลากรุงเทพ)
- **Context:** PRD §2.2–2.3 และ §8.2 กำหนดว่า staff ใช้ Google SSO จำกัด domain, client ใช้ magic link, มี break-glass admin, session เป็น JWT สั้น + refresh พร้อม device list/forced logout, RBAC ด้วย permission string และ audit log ที่แก้ไม่ได้ · ADR-001 กำหนด NestJS + Drizzle + Postgres · ADR-004 กำหนดรหัส break-glass อยู่ใน environment

## Decision

**Token และ cookie**
- Access token = JWT HS256 อายุ 15 นาที (`ACCESS_TOKEN_TTL_SECONDS`) มีแค่ `sub` (user) กับ `sid` (session) · **ทุก request** อ่าน session + user จาก DB ซ้ำ (revoke, disable, เปลี่ยน role มีผลทันที ไม่รอ token หมดอายุ)
- Refresh token = สุ่ม 256 bit เก็บเฉพาะ SHA-256 hash ใช้ครั้งเดียว แล้วออกตัวใหม่ (rotation) · **ถ้านำตัวที่ใช้แล้วมาใช้อีก = session ถูก revoke ทั้งเส้น** (`refresh_reuse`) · ไม่มี grace window: browser ต้อง refresh ทีละ tab (T-006 ต้อง single-flight)
- เก็บใน cookie `wt_at` (SameSite=Lax) และ `wt_rt` (SameSite=Strict) (เมื่อ `Secure` ชื่อจริงคือ `__Host-wt_at` / `__Host-wt_rt` ดู "แก้ไขจาก T-010") ทั้งคู่ `HttpOnly`, `Secure` เมื่ออยู่ production หรือ `API_URL` เป็น https, ไม่ตั้ง `Domain`, `Path=/` · **ไม่ใช้ path แคบ** เพราะ reverse proxy อาจ mount api ใต้ `/api` แล้ว cookie path จะไม่ match เงียบ ๆ · token ไม่อยู่ใน JSON body เลย
- เหตุผลที่เลือก cookie แทน token ใน `localStorage`: script ใน web อ่าน token ไม่ได้ (XSS ขโมย session ไม่ได้) แลกกับต้องทำ CSRF เอง
- ข้อสมมติ `[ASSUMED]`: web และ api อยู่ **same-site** (localhost คนละพอร์ต, หรือ `app.example.com` กับ `api.example.com`, หรือ origin เดียวผ่าน Caddy) · ถ้า deploy คนละ site ต้องเขียน ADR ใหม่ (SameSite=None)

**CSRF (สามชั้น)**
1. SameSite ของ cookie
2. Origin check ก่อน routing: unsafe method ที่มี header `Origin` ต้องเป็น `APP_URL` หรือ origin ของ api เอง (Swagger) ไม่งั้น 403 `origin_not_allowed` (รวม `Origin: null`)
3. Synchronizer token ผูก session: `x-csrf-token` = HMAC(JWT_SECRET-subkey, sessionId) บังคับกับ POST/PUT/PATCH/DELETE ของ route ที่ต้อง login · client ได้ค่านี้จาก body ของ login/refresh/`GET /v1/auth/session` (อ่านข้าม origin ไม่ได้เพราะ CORS) · `refresh`/`logout`/login เป็น `@Public` จึงใช้ชั้น 1–2 + cookie `wt_rt` ที่ SameSite=Strict
- CORS: origin เดียว (`APP_URL`), `credentials: true`, ไม่ใช้ `*`

**Sign-in**
- Staff: Google OIDC authorization code + **PKCE S256**, `state`, `nonce` ผ่าน `openid-client` · state/verifier/nonce อยู่ใน cookie HttpOnly ที่เซ็นด้วย JWT_SECRET อายุ 10 นาที (ผูกกับ browser ที่เริ่ม flow) · ตรวจฝั่ง server: `email_verified === true`, claim `hd` = `GOOGLE_ALLOWED_DOMAIN` และ email ลงท้าย `@<domain>` (พารามิเตอร์ `hd` ใน URL เป็นแค่ hint) · `openid-client` ข้ามการตรวจ signature ของ ID token เมื่อรับจาก token endpoint ผ่าน TLS (OIDC Core §3.1.3.7) เราตรวจซ้ำด้วย `jose` กับ JWKS ของ provider · **ไม่ auto-provision**: ต้องมี user ที่ head สร้างไว้ก่อน
- Mock mode (`GOOGLE_OIDC_CLIENT_ID`/`SECRET` ว่าง): ไม่เรียก network · `POST /v1/auth/dev-login` เปิดเฉพาะเมื่อ **`DEV_LOGIN_ENABLED=true` ตั้งเองอย่างชัดแจ้ง** และ mock และ `NODE_ENV !== production`, และ sign in ได้เฉพาะบัญชีที่ dev login สร้างเอง (`users.dev_created`) — ดู "แก้ไขจาก T-010" · **boot ล้มใน production ถ้าไม่มี credential ครบ** (guard ใน `@watchtower/shared`)
- Client: magic link · token 256 bit เก็บ hash ใช้ครั้งเดียว (`UPDATE … WHERE consumed_at IS NULL` ครั้งเดียว) หมดอายุ 15 นาที · ขอลิงก์ใหม่ = ลิงก์เก่าใช้ไม่ได้ · ตอบ 202 เหมือนกันทุกกรณีและทำงานจริงหลังตอบ (ไม่บอกว่าอีเมลมีบัญชี) · rate limit: ต่อ IP 10/15 นาที (429), ต่อ email 3/15 นาที (เงียบ) · ลิงก์ใช้ **URL fragment** `/login/magic#token=…` แล้วให้หน้าเว็บ POST ไป verify (mail scanner ที่ GET ลิงก์ไม่ทำให้ token ถูกใช้) · ส่งผ่านคิว BullMQ `email` → worker → SMTP (Mailpit) · client อยู่ได้ org เดียว (`users.org_id`) · เพิ่มบัญชีเองจาก domain allow-list ผ่าน port `CLIENT_ORG_RESOLVER` (T-005 เป็นผู้ implement)
- Break-glass: role `head` เท่านั้น · สร้างจาก `BREAK_GLASS_EMAIL`/`PASSWORD` ตอน boot หรือ CLI `break-glass` (รหัสจาก env/stdin ไม่รับเป็น argument) ไม่มีรหัสเริ่มต้นใน repo · argon2id (19 MiB, 2 passes) · **ล็อกแยกต่อ (บัญชี, IP)** ผิดครั้งที่ 5 จาก IP นั้นล็อก IP นั้น 60 วินาที ผิดเพิ่มทุกครั้งทบสองเท่าสูงสุด 1 ชม. (นับแบบ atomic, รหัสถูกระหว่างล็อกก็ไม่ผ่าน, ไม่กระทบ IP อื่น) ดู "แก้ไขจาก T-010" · 10 ครั้ง/IP/15 นาที · บัญชีไม่มี/ล็อก/รหัสผิด ตอบเหมือนกันและใช้เวลา argon2 เท่ากัน · ทุกครั้งลง audit

**RBAC**
- `users.role` ∈ `agent|lead|head|client|system` · `permissions` + `role_permissions` เป็นตาราง seed จาก migration (ตรงกับ `DEFAULT_ROLE_PERMISSIONS` ใน `@watchtower/shared` มี test เทียบ) · head แก้ได้ผ่าน `PUT /v1/rbac/roles/:role/permissions` โดยไม่ deploy (head ห้ามลบ `rbac.manage`, `user.manage`, `audit.read`, `session.revoke.any` ของตัวเอง) · `users.permissions[]` เพิ่มสิทธิ์รายคน (service identity)
- **Deny-by-default:** `AuthGuard` เป็น `APP_GUARD` ระดับ global · route ที่ไม่มี `@Public()` หรือ `@RequirePermission(…)`/`@RequireAnyPermission(…)` ตอบ 403 `route_not_configured` แม้เป็น head · test ไล่ทุก route ของ module จริง และล็อกรายการ route สาธารณะไว้เป็น allow-list
- Client scope: `Principal.orgScope` + `orgScopeCondition(column, scope)` ใน `@watchtower/db` + `assertOrgAccess` (404 ไม่ใช่ 403 เพื่อไม่บอกว่ามี org นั้น)

**Audit log**
- ตาราง `audit_log` partition รายเดือน (UTC) + default partition สร้างด้วย SQL migration · function `ensure_monthly_partitions` (`SECURITY DEFINER`) สร้างล่วงหน้า · worker รันทุกวัน 03:00 UTC และตอนเริ่ม
- Immutable สองชั้น: trigger `BEFORE UPDATE OR DELETE` (row) และ `BEFORE TRUNCATE` (statement ต่อ partition) ปฏิเสธทุก role รวม owner · role `watchtower_app` ถูก `REVOKE UPDATE, DELETE, TRUNCATE` (รวม partition ที่สร้างทีหลัง) · api/worker เชื่อมด้วย login role ที่เป็นสมาชิก `watchtower_app` เท่านั้น (compose: `watchtower_api`)
- `AuditInterceptor` (global) เขียน 1 แถวต่อทุก mutation ทั้งสำเร็จและล้มเหลว + route ที่ติด `@AuditPiiRead`/`@Audited({always:true})` · service เติม target/before/after ผ่าน `AuditScope.set()` (AsyncLocalStorage) · ถ้าเขียน audit ไม่ได้หลัง mutation สำเร็จ → 500 (ไม่ซ่อน) · การปฏิเสธ (403, CSRF) เขียนจาก guard เพราะ interceptor ไม่ถูกเรียก · `recordInTransaction` สำหรับ mutation ที่ต้อง commit พร้อม audit
- `before/after/metadata` ผ่าน `redactForAudit` เสมอ: ตามชื่อ key (password, token, secret, hash, cookie, authorization, api key …) และตามรูปค่า (JWT, bearer, argon2, token 43 ตัวอักษรของระบบ)
- **ข้อจำกัดที่ยอมรับ `[ASSUMED]`:** superuser/owner ปิด trigger ได้ (`ALTER TABLE … DISABLE TRIGGER`) · 401 ของคนที่ไม่ได้ login ที่ยิง route ทั่วไปไม่ลง audit (กัน log ท่วม) · เห็นเฉพาะ login ที่ล้มเหลว, refresh ที่ล้มเหลว, 403 และ CSRF reject ของคนที่ login แล้ว

## Options considered
- **Token ใน `localStorage` + `Authorization: Bearer`** — ไม่ต้องทำ CSRF แต่ XSS ขโมย session ได้ ไม่เลือก
- **JWT อย่างเดียวไม่เช็ก DB** — เร็ว แต่ forced logout/disable ไม่ทันที ขัดกับ PRD §2.3 · เลือกเช็ก DB ทุก request (1 query ต้นทุนต่ำ ใส่ cache ได้ภายหลัง)
- **Refresh แบบมี grace window สำหรับหลาย tab** — ลดการหลุด login แต่ลดการตรวจ replay · เลือกเข้มงวด ให้ client แก้ด้วย single-flight
- **ใช้ `openid-client` อย่างเดียว** — ตรวจ signature ของ ID token ที่มาจาก token endpoint ไม่ครบ · เพิ่ม `jose` ตรวจซ้ำ (เพิ่มการเรียก JWKS ของ provider เดียวกัน)
- **argon2 (node-argon2) แทน `@node-rs/argon2`** — ต้อง compile ตอน install; `@node-rs/argon2` มี binary สำเร็จรูป ไม่มี install script (pnpm 10 บล็อก script ตามค่าเริ่มต้น)
- **Auto-provision staff ตอน Google login ครั้งแรก** — สะดวก แต่ทุกคนใน domain ได้สิทธิ์เห็น ticket/PII ทันที · ไม่เลือก ให้ head สร้างบัญชีก่อน

## Consequences
- dependency ใหม่: `jose`, `openid-client`, `@node-rs/argon2`, `bullmq`, `drizzle-orm`, `pg` (api) · `nodemailer` (worker, ต่อ SMTP ที่ตั้งผ่าน `SMTP_HOST`/`SMTP_PORT` เท่านั้น) · ปลายทางขาออกใหม่ใน runtime มีแค่ Google OIDC discovery/token/JWKS เมื่อเปิด live mode
- migration `0001` สร้าง group role `watchtower_app` (ระดับ cluster) · down migration ไม่ลบ role นี้ · ผู้รัน migration ต้องมีสิทธิ์ `CREATEROLE`
- ตั้ง `DATABASE_URL` ของ api/worker เป็น login role แบบจำกัด และ `MIGRATION_DATABASE_URL` เป็น owner · compose ทำให้อัตโนมัติ
- T-005: ทุกตารางใหม่ได้สิทธิ์ SELECT/INSERT/UPDATE/DELETE ให้ `watchtower_app` อัตโนมัติ (default privileges) · ตาราง append-only ต้อง `REVOKE` เอง และใช้ `reject_mutation()` + `ensure_monthly_partitions(..., true)`
- T-006: ดู contract ใน JSDoc ของ `AuthController` และ schema ใน `packages/shared/src/auth.ts`
- ต้องมีงาน purge session/refresh/magic-link token ที่หมดอายุ (ยังไม่ทำ)

## แก้ไขจาก T-010 (security review) `[TESTED]` ยกเว้นที่ระบุ
เปลี่ยนจากที่เขียนข้างบน (ข้างบนแก้ให้ตรงแล้ว) · test อยู่ใน `apps/api/src/auth/hardening.integration.test.ts`, `break-glass.integration.test.ts`, `packages/shared/src/config.test.ts`

- **C-1 dev login:** เปิดเมื่อ `DEV_LOGIN_ENABLED=true` (ค่าเริ่มต้น false; compose ก็ false, `.env.example` เป็น true สำหรับเครื่อง local) **และ** Google เป็น mock **และ** ไม่ใช่ production — ตั้ง true ร่วมกับ Google credential หรือใน production แล้ว **boot ล้ม** (ไม่ปล่อยผ่านเงียบ ๆ) · `users.dev_created` (migration `0005`) ถูกตั้งเมื่อ dev login สร้างบัญชี; บัญชีที่ไม่ได้สร้างจาก dev login (head เชิญ, seed, SQL, break-glass, system) ได้ 403 ทุกกรณี จึงเปิดโดยพลาดบน DB ที่มีบัญชีจริงก็ยัง sign in เป็นคนเหล่านั้นไม่ได้ · ข้อควรรู้: บัญชี demo จาก `pnpm db:seed` sign in ด้วย dev login ไม่ได้ ต้องให้ dev login สร้างบัญชีของตัวเอง
- **C-1 secret อ่อน:** `JWT_SECRET`/`APP_ENCRYPTION_KEY` ที่เป็น placeholder (`change-me…`) หรือสั้นกว่า 32 byte → boot ล้ม **ยกเว้น** `NODE_ENV != production` **และ** `APP_URL` เป็น loopback (`localhost`, `127.0.0.0/8`, `::1`, `*.localhost`) · compose บนเครื่องตัวเอง (APP_URL = localhost) ยังบูตด้วยค่าตัวอย่างได้ · ใช้ APP_URL เป็น LAN IP หรือโดเมนจริงต้องตั้ง secret จริง · production มี guard เข้มกว่าเดิมอยู่แล้ว (32 byte base64)
- **C-5 headers:** api ตอบ `X-Content-Type-Options: nosniff`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` ทุก response, `Cache-Control: no-store` บน `/v1/auth/*`, `Strict-Transport-Security` เฉพาะ production (`apps/api/src/http/security-headers.middleware.ts`) · CSP ของ api มีแค่ `frame-ancestors` โดยตั้งใจ (JSON + Swagger UI ที่ต้อง inline script)
- **C-5 headers ของ web (`apps/web/next.config.ts`):** CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' <API_URL>; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` + `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` ปิด camera/microphone/geolocation/payment/usb · **`'unsafe-inline'` ใน script-src ยังอยู่** เพราะหน้ามี inline script ที่ nonce ไม่ครอบ (theme bootstrap ใน layout และข้อมูล hydration ของ Next) — nonce ต้องใช้ `src/proxy.ts` สร้าง nonce ต่อ response ซึ่งอยู่นอกขอบเขตงานนี้ · **ข้อจำกัดที่พบ `[TESTED]`:** `headers()` ใน `next.config.ts` ถูกคำนวณตอน `next build` และฝังใน `.next/routes-manifest.json` ไม่ใช่ตอน request จึงอ่าน `API_URL` ที่เป็น runtime ไม่ได้ (ขัดกับ ADR-001 ข้อ "image เดียว") · ตอนนี้ใช้ `API_URL` ที่มีตอน build ถ้ามี (pin `connect-src` เป็น origin นั้น + ws/wss) ไม่มีก็ถอยไปอนุญาต `https: http: wss: ws:` ซึ่งเป็นส่วนที่อ่อนที่สุดของ policy · ทางออกที่ถูกต้อง = `src/proxy.ts` (nonce + `connect-src` จาก `readRuntimeConfig()` ตอน request) งาน frontend ถัดไป
- **C-6 cookie:** เมื่อ `cookieSecure` ชื่อเป็น `__Host-wt_at` / `__Host-wt_rt` / `__Host-wt_oidc` (browser ปฏิเสธ cookie ที่มี prefix นี้ถ้าไม่ `Secure`, ไม่ `Path=/`, หรือมี `Domain`) กัน subdomain พี่น้องปลูก cookie ชื่อเดียวกัน (cookie tossing) · บน http ธรรมดาใช้ชื่อเดิมเพราะ `Secure` ทำไม่ได้ · request ที่มี cookie ชื่อเดียวกันซ้ำ (access/refresh/oidc) ถือว่าไม่มี credential → 401 (`readCookie` คืน undefined; refresh ลง audit `duplicate_refresh_cookie`; WebSocket handshake 401) · ข้อควรรู้: web ไม่อ่าน cookie เหล่านี้ (HttpOnly) จึงไม่กระทบ
- **C-7 break-glass lockout:** ตาราง `break_glass_attempt (user_id, ip)` แทน `users.failed_login_count/locked_until` (คอลัมน์เดิมยังอยู่แต่ไม่ถูกใช้) · ผิดครั้งที่ 5 จาก IP หนึ่งล็อก (บัญชี, IP) นั้น 60 วิ, ครั้งที่ 6 = 120 วิ ... สูงสุด 3600 วิ · นับใหม่เมื่อเงียบเกิน 24 ชม. หรือเมื่อ sign in สำเร็จจาก IP นั้น · ระหว่างล็อกไม่ต่อเวลา · ล็อกใหม่ = audit row `auth.break_glass.lockout` + log `warn` · IP อื่นและบัญชีอื่นไม่ถูกกระทบ → คนที่รู้อีเมลแอดมินล็อกแอดมินออกไม่ได้อีก · ข้อแลก `[ASSUMED]`: botnet ได้เดา 5 ครั้งต่อ IP ก่อนถูกชะลอ (argon2id + รหัส ≥ 12 ตัว + limit 10/IP/15 นาที) · CLI `break-glass --unlock <email>` ล้างทุกล็อกของบัญชีและลง audit `auth.break_glass.unlocked` · ต้องตั้ง `TRUST_PROXY_HOPS` ให้ถูกเมื่ออยู่หลัง proxy (C-8) ไม่งั้นทุก client ใช้ IP ของ proxy ร่วมกัน
- **C-8 proxy:** `TRUST_PROXY_HOPS` เดิม 0 (ไม่เชื่อ `X-Forwarded-For`) · `docker-compose.proxy.yml` รัน stack ผ่าน Caddy อย่างเดียว (api ไม่ publish :4000, ตั้ง hops = 1, web/api/อีเมลใช้ origin เดียว `PROXY_PUBLIC_URL`) · api เตือนครั้งเดียวต่อ 10 นาทีเมื่อ hops = 0 แต่ request มี `X-Forwarded-For` มาจาก address ส่วนตัว (Caddy ใน docker network) · `[VERIFY]` พฤติกรรมของ Caddy ที่เขียนทับ `X-Forwarded-For` ของ client เมื่อไม่ตั้ง `trusted_proxies` (ตามเอกสาร Caddy; ยังไม่ได้รัน stack เต็มผ่าน proxy)
- **C-9 audit snapshot ของ user:** เก็บเฉพาะ `id`, `role`, `status`, `hasEmail` (เดิมมี email, name, orgId) เหมือน contact
- **C-10 `emailTag`:** HMAC-SHA-256 ด้วย subkey ของ `APP_ENCRYPTION_KEY` (label `watchtower/audit/email-tag/v1`) แทน SHA-256 เปล่า ๆ ที่ใครอ่าน audit log ได้ก็เดาอีเมลย้อนได้ · เปลี่ยน key แล้ว tag เปลี่ยนทั้งหมด (แถวเก่าไม่ match แถวใหม่)

- **C-16 (main thread, 2026-11-01):** `DEV_LOGIN_ENABLED=true` ทำให้ boot ล้มถ้า `APP_URL` ไม่ใช่ loopback — `.env.example` ที่ถูก copy ไปขึ้น host ที่เข้าถึงได้จะไม่แจกบัญชี head

## แก้ไข 2026-11-03: allow-list อีเมลสำหรับบัญชี Google ส่วนตัว (เจ้าของสั่ง, POC)
- **Context:** เจ้าของต้องการใช้ Google login จริงบน instance ทดลองด้วยบัญชี `@gmail.com` ส่วนตัว ซึ่งไม่มี claim `hd` จึงถูกกฎ domain ข้างบนปฏิเสธเสมอ (dev login เป็นทางเดียวที่เหลือ และ dev login ใครก็ล็อกอินเป็น role ไหนก็ได้)
- **Decision:** เพิ่ม `GOOGLE_ALLOWED_EMAILS` (รายการอีเมลคั่นด้วย comma) เป็นทางที่สองของกฎ staff: ผ่านเมื่อ `email_verified === true` **และ** อีเมล (ตัดช่องว่าง, ตัวพิมพ์เล็ก) **ตรงทั้งตัว** กับรายการ โดยไม่ดู `hd` · กฎ domain เดิมยังทำงานคู่กัน (ผ่านทางใดทางหนึ่ง) · **ไม่ auto-provision** เหมือนเดิม (ต้องมี user ที่ head สร้างไว้) · **ห้ามใน production**: ตั้งค่านี้ขณะ `NODE_ENV=production` แล้ว api ไม่ยอม boot (เหตุผล: บัญชีส่วนตัวอยู่นอกการควบคุมขององค์กร — ปิดบัญชีพนักงานที่ออกไม่ได้, ไม่มี 2SV บังคับ) · ห้ามมี wildcard หรือ pattern · audit การ login บอกว่าผ่านทางไหน (`domain` / `allowlist`) โดยไม่ใส่อีเมลเกินที่ audit เดิมเก็บ
- **Consequences:** มีทาง login ที่ไม่ผูกกับ Workspace บนเครื่องทดลองได้โดยไม่ต้องเปิด dev login · รายการผิด = คนนั้นเข้าได้ถ้ามี user อยู่แล้ว (สองชั้น: allow-list + ต้องมีบัญชี) · ต้องผ่าน `security-reviewer` ก่อน merge

## Links
- PRD §2.2, §2.3, §8.2 · ADR-001 · ADR-004 · `docs/04-ARCHITECTURE.md` §7 · OIDC Core §3.1.3.7 · RFC 7636 (PKCE)
