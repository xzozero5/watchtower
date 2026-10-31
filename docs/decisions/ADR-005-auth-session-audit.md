# ADR-005 — Auth, session, CSRF, RBAC และ audit log (T-004)

- **Status:** Proposed (เขียนโดย `backend-dev` ใน T-004 · รอ `architect`/`security-reviewer` ตรวจใน T-010 แล้ว main thread เปลี่ยนเป็น Accepted)
- **Date:** 2026-10-31 (เวลากรุงเทพ)
- **Context:** PRD §2.2–2.3 และ §8.2 กำหนดว่า staff ใช้ Google SSO จำกัด domain, client ใช้ magic link, มี break-glass admin, session เป็น JWT สั้น + refresh พร้อม device list/forced logout, RBAC ด้วย permission string และ audit log ที่แก้ไม่ได้ · ADR-001 กำหนด NestJS + Drizzle + Postgres · ADR-004 กำหนดรหัส break-glass อยู่ใน environment

## Decision

**Token และ cookie**
- Access token = JWT HS256 อายุ 15 นาที (`ACCESS_TOKEN_TTL_SECONDS`) มีแค่ `sub` (user) กับ `sid` (session) · **ทุก request** อ่าน session + user จาก DB ซ้ำ (revoke, disable, เปลี่ยน role มีผลทันที ไม่รอ token หมดอายุ)
- Refresh token = สุ่ม 256 bit เก็บเฉพาะ SHA-256 hash ใช้ครั้งเดียว แล้วออกตัวใหม่ (rotation) · **ถ้านำตัวที่ใช้แล้วมาใช้อีก = session ถูก revoke ทั้งเส้น** (`refresh_reuse`) · ไม่มี grace window: browser ต้อง refresh ทีละ tab (T-006 ต้อง single-flight)
- เก็บใน cookie `wt_at` (SameSite=Lax) และ `wt_rt` (SameSite=Strict) ทั้งคู่ `HttpOnly`, `Secure` เมื่ออยู่ production หรือ `API_URL` เป็น https, ไม่ตั้ง `Domain`, `Path=/` · **ไม่ใช้ path แคบ** เพราะ reverse proxy อาจ mount api ใต้ `/api` แล้ว cookie path จะไม่ match เงียบ ๆ · token ไม่อยู่ใน JSON body เลย
- เหตุผลที่เลือก cookie แทน token ใน `localStorage`: script ใน web อ่าน token ไม่ได้ (XSS ขโมย session ไม่ได้) แลกกับต้องทำ CSRF เอง
- ข้อสมมติ `[ASSUMED]`: web และ api อยู่ **same-site** (localhost คนละพอร์ต, หรือ `app.example.com` กับ `api.example.com`, หรือ origin เดียวผ่าน Caddy) · ถ้า deploy คนละ site ต้องเขียน ADR ใหม่ (SameSite=None)

**CSRF (สามชั้น)**
1. SameSite ของ cookie
2. Origin check ก่อน routing: unsafe method ที่มี header `Origin` ต้องเป็น `APP_URL` หรือ origin ของ api เอง (Swagger) ไม่งั้น 403 `origin_not_allowed` (รวม `Origin: null`)
3. Synchronizer token ผูก session: `x-csrf-token` = HMAC(JWT_SECRET-subkey, sessionId) บังคับกับ POST/PUT/PATCH/DELETE ของ route ที่ต้อง login · client ได้ค่านี้จาก body ของ login/refresh/`GET /v1/auth/session` (อ่านข้าม origin ไม่ได้เพราะ CORS) · `refresh`/`logout`/login เป็น `@Public` จึงใช้ชั้น 1–2 + cookie `wt_rt` ที่ SameSite=Strict
- CORS: origin เดียว (`APP_URL`), `credentials: true`, ไม่ใช้ `*`

**Sign-in**
- Staff: Google OIDC authorization code + **PKCE S256**, `state`, `nonce` ผ่าน `openid-client` · state/verifier/nonce อยู่ใน cookie HttpOnly ที่เซ็นด้วย JWT_SECRET อายุ 10 นาที (ผูกกับ browser ที่เริ่ม flow) · ตรวจฝั่ง server: `email_verified === true`, claim `hd` = `GOOGLE_ALLOWED_DOMAIN` และ email ลงท้าย `@<domain>` (พารามิเตอร์ `hd` ใน URL เป็นแค่ hint) · `openid-client` ข้ามการตรวจ signature ของ ID token เมื่อรับจาก token endpoint ผ่าน TLS (OIDC Core §3.1.3.7) เราตรวจซ้ำด้วย `jose` กับ JWKS ของ provider · **ไม่ auto-provision**: ต้องมี user ที่ head สร้างไว้ก่อน
- Mock mode (`GOOGLE_OIDC_CLIENT_ID`/`SECRET` ว่าง): ไม่เรียก network · `POST /v1/auth/dev-login` เปิดเฉพาะ mock และ `NODE_ENV !== production` · **boot ล้มใน production ถ้าไม่มี credential ครบ** (guard ใน `@watchtower/shared`)
- Client: magic link · token 256 bit เก็บ hash ใช้ครั้งเดียว (`UPDATE … WHERE consumed_at IS NULL` ครั้งเดียว) หมดอายุ 15 นาที · ขอลิงก์ใหม่ = ลิงก์เก่าใช้ไม่ได้ · ตอบ 202 เหมือนกันทุกกรณีและทำงานจริงหลังตอบ (ไม่บอกว่าอีเมลมีบัญชี) · rate limit: ต่อ IP 10/15 นาที (429), ต่อ email 3/15 นาที (เงียบ) · ลิงก์ใช้ **URL fragment** `/login/magic#token=…` แล้วให้หน้าเว็บ POST ไป verify (mail scanner ที่ GET ลิงก์ไม่ทำให้ token ถูกใช้) · ส่งผ่านคิว BullMQ `email` → worker → SMTP (Mailpit) · client อยู่ได้ org เดียว (`users.org_id`) · เพิ่มบัญชีเองจาก domain allow-list ผ่าน port `CLIENT_ORG_RESOLVER` (T-005 เป็นผู้ implement)
- Break-glass: role `head` เท่านั้น · สร้างจาก `BREAK_GLASS_EMAIL`/`PASSWORD` ตอน boot หรือ CLI `break-glass` (รหัสจาก env/stdin ไม่รับเป็น argument) ไม่มีรหัสเริ่มต้นใน repo · argon2id (19 MiB, 2 passes) · ผิด 5 ครั้งล็อก 15 นาที (นับแบบ atomic, รหัสถูกระหว่างล็อกก็ไม่ผ่าน) · 10 ครั้ง/IP/15 นาที · บัญชีไม่มี/ล็อก/รหัสผิด ตอบเหมือนกันและใช้เวลา argon2 เท่ากัน · ทุกครั้งลง audit

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

## Links
- PRD §2.2, §2.3, §8.2 · ADR-001 · ADR-004 · `docs/04-ARCHITECTURE.md` §7 · OIDC Core §3.1.3.7 · RFC 7636 (PKCE)
