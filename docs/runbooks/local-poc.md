# Runbook: POC บนเครื่องเดียว (ต่อของจริงบางส่วน)

> สำหรับ AI/คนที่รับงานต่อ (Claude Code, Codex หรือคน) · ใช้กับ instance ทดลองบน `localhost` เท่านั้น · ค่า secret ทั้งหมดอยู่ในไฟล์ env นอก repo (`D:\Works\secret\watchtower.env` บนเครื่องเจ้าของ `[ASSUMED]` path) — **ห้ามพิมพ์ค่าออก terminal/log/แชต** (N1) ตรวจได้แค่ "มี/ไม่มี" หรือความยาว
> ตรวจล่าสุด 2026-11-03 `[TESTED]` บน Windows + Docker Desktop

## 1. สิ่งที่ต่อจริงแล้ว / ยัง mock
| ส่วน | สถานะ | ADR |
|---|---|---|
| ล็อกอิน staff | Google OIDC จริง ผ่าน `GOOGLE_ALLOWED_EMAILS` (บัญชี @gmail.com ส่วนตัว) · dev login **ปิด** · มี break-glass | ADR-005 (แก้ไข 2026-11-03) |
| AI | **`claude -p` ของเจ้าของ (model `sonnet`)** ผ่าน bridge ที่เป็น compose service เปิดค้าง (provider `claude-cli`) ไม่ใช้ API key · ใช้ได้เมื่อ host online เท่านั้น — **ใช้ต่อไปแบบนี้ ไม่ว่าจะทำงานต่อใน Claude Code หรือ Codex** | ADR-017, ADR-019 |
| Gmail | OAuth กล่องจริง + Pub/Sub push (ต้องมี tunnel ตอนอยากให้เมลใหม่เข้าเอง) · ไม่มี tunnel = กด "Sync now" ใน Admin → Integrations | ADR-014, runbook credentials §3.3/3.5 |
| LINE, Discord, SMTP ออกจริง, GCP logs/BigQuery | mock (SMTP ไป Mailpit `http://localhost:8025`) | — |

## 2. เปิดระบบ (ทุกครั้งที่เปิดเครื่อง)
```bash
docker compose --env-file D:\Works\secret\watchtower.env up -d --wait --build
```
- web `http://localhost:3000` · api `http://localhost:4000` · Mailpit `http://localhost:8025`
- checkout ใหม่หรือหลัง pull ที่มี dependency ใหม่: `pnpm install --frozen-lockfile` ก่อน (เช่น ฟอนต์ `@fontsource/*` จาก UI rework)
- Postgres volume เดิมที่ถูก init ด้วยรหัสอื่น: เปลี่ยน `POSTGRES_PASSWORD` แล้วต้อง `ALTER ROLE` ใน container (ใช้ค่าจาก env ของ container เอง ไม่พิมพ์) ไม่ต้องลบ volume

## 3. AI ผ่าน `claude -p` (bridge ใน Docker เปิดค้าง) — ADR-019
AI ใช้ได้ **เมื่อเครื่อง host online เท่านั้น**: bridge เช็คการเข้าถึง `api.anthropic.com:443` (cache 15 s) ตอน offline จะตอบ `503 offline` โดยไม่เรียก CLI → งาน AI ถูกบันทึก (`ai_run` error) ไม่ fallback เป็น mock → ticket แสดง "AI ออฟไลน์ … ระบบจะลองใหม่เอง" → งาน brief ถูกเลื่อนลองใหม่ทุก 5 นาที (นานสุด 24 ชม.) · ต่อเน็ตกลับมาแล้วไม่ต้องทำอะไร
1. **ขอ token (ครั้งเดียว, เจ้าของทำเอง):** ใน terminal ที่ login Claude Code แล้วรัน `claude setup-token` (ต้องมี Claude subscription) นำ token ที่ได้ไปใส่ในไฟล์ env นอก repo เป็น `CLAUDE_CODE_OAUTH_TOKEN` (ชื่อตัวแปร `[VERIFY]` กับเอกสาร Claude Code ปัจจุบัน) · **ห้ามพิมพ์/แปะ token ในแชตหรือ log**
2. **env file** (`D:\Works\secret\watchtower.env`) ต้องมีตัวแปรเหล่านี้ (ค่าตัวอย่างเฉพาะที่ไม่ลับ):
   - `AI_PROVIDER=claude-cli`
   - `CLAUDE_CLI_BRIDGE_URL=http://claude-bridge:4317`
   - `CLAUDE_CLI_BRIDGE_TOKEN` = สุ่ม ≥ 16 ตัว (เช่น `openssl rand -hex 24`)
   - `CLAUDE_CODE_OAUTH_TOKEN` = จากข้อ 1
   - `AI_MODEL_DEEP=sonnet`, `AI_MODEL_STANDARD=sonnet`, `AI_MODEL_LIGHT=sonnet`
   - `AI_MODEL_PRICES={"sonnet":{"inputUsdPerMTok":0,"outputUsdPerMTok":0}}`
   - `WATCHTOWER_KB_DIR=D:/Works/watchtower-kb`
3. **เปิด bridge (ค้างไว้ ไม่ต้องใช้ terminal):**
   ```bash
   docker compose --env-file D:\Works\secret\watchtower.env --profile ai up -d --build claude-bridge
   docker compose --env-file D:\Works\secret\watchtower.env up -d --no-deps worker
   ```
   บรรทัดสองให้ worker อ่านค่าใหม่ · `restart: unless-stopped` → ขึ้นเองเมื่อ Docker Desktop เปิด · ไม่ publish port ออก host (เฉพาะ container ใน compose network เข้าถึงได้ และต้องมี bearer token) · build ครั้งแรกดาวน์โหลด Claude Code ผ่าน npm
4. **ตรวจสุขภาพ:**
   ```bash
   docker compose --profile ai ps claude-bridge
   docker compose --profile ai exec claude-bridge node -e "fetch('http://127.0.0.1:4317/healthz').then(r=>r.text()).then(console.log)"
   ```
   `ps` ต้อง healthy · healthz ตอบ `{"status":"ok","online":true,"checkedAt":"…"}` · `online:false` = host ออก internet/Anthropic ไม่ได้ (AI จะ offline ตามที่อธิบายด้านบน) · log worker ต้องมี `AI provider is ready` + `"provider":"claude-cli"`
5. **ถ้า login ไม่ผ่าน:** `docker compose --profile ai logs claude-bridge` (มีแต่สถานะ ไม่มีข้อความ prompt) · `cli_failed` 502 ซ้ำแม้ online = token ผิด/หมดอายุ → ทำข้อ 1 ใหม่ แล้ว `up -d claude-bridge`
6. **ทางเดิม (bridge บน host ไม่ใช้ Docker):** ตั้ง `CLAUDE_CLI_BRIDGE_URL=http://host.docker.internal:4317` แล้วรัน `node --env-file=D:\Works\secret\watchtower.env tools/claude-cli-bridge/server.mjs` (ฟัง `127.0.0.1:4317` ใช้ login ของ `claude` บนเครื่อง ไม่ต้องมี `CLAUDE_CODE_OAUTH_TOKEN`)
7. **ต้นทุน/ข้อห้าม:** subscription ของเจ้าของ (`ai_run.cost_usd` = 0, daily token cap ยังบังคับ) · ห้ามใช้ใน production (ระบบไม่ยอม boot ถ้า `NODE_ENV=production` หรือ `APP_URL` ไม่ใช่ loopback) · `[ASK-HUMAN]` เงื่อนไขบริการของ Anthropic กับการใช้อัตโนมัติ และนโยบายข้อมูลลูกค้า (ADR-019)

## 3b. Knowledge base folder (`D:\Works\watchtower-kb`)
- นอก repo มี `README.md` อธิบายรูปแบบ (front-matter: `title, slug, lang, kind, visibility, tags, intent, orgs`) และตัวอย่างสมมติ 2 ไฟล์ใน `examples/` (ลบก่อน sync ได้)
- นำเข้า: shell ต้องมี `WATCHTOWER_KB_DIR` และ `MIGRATION_DATABASE_URL` (ชี้ Postgres ที่เครื่องนี้เข้าถึง เช่น host `localhost` ไม่ใช่ `postgres`) แล้ว `pnpm kb:sync --dry-run` (อ่าน/ตรวจไฟล์อย่างเดียว) → `pnpm kb:sync` (idempotent) · `pnpm kb:sync` อ่านเฉพาะ `.env` ใน repo root จึง export สองตัวแปรนี้ใน shell เอง ไม่พิมพ์ค่า
- `internal` → published + embedding ผ่าน worker · `customer`/`orgs` → **draft** ให้คน publish ในแอป · แก้ไฟล์ = เพิ่ม version · ลบไฟล์ไม่ทำอะไร

## 4. Gmail push (เฉพาะตอนอยากให้เมลใหม่ไหลเข้าเอง)
Pub/Sub ต้องยิง HTTPS เข้ามาหา api จาก internet → ต้องมี tunnel · **ห้ามชี้ tunnel ไปที่ api ตรง ๆ**
1. เปิดตัวกรอง (ค้างไว้): `pnpm push-filter` → `127.0.0.1:4318` ปล่อยเฉพาะ `POST /v1/inbound/gmail/push`
2. เจ้าของเปิด tunnel เอง (agent ถูกระบบสิทธิ์บล็อกไม่ให้เปิด ingress): `cloudflared tunnel --url http://localhost:4318` → ได้ `https://<สุ่ม>.trycloudflare.com` (เปลี่ยนทุกครั้ง)
3. ตั้ง `GMAIL_PUSH_AUDIENCE=<URL>/v1/inbound/gmail/push` ใน env file → `docker compose ... up -d --no-deps api worker`
4. GCP console → Pub/Sub → subscription `gmail-push-sub` → Edit: Endpoint URL + Audience = ค่าเดียวกันตรงทุกตัวอักษร (SA `watchtower-pubsub-push`)
5. ตรวจ: ยิงผ่าน tunnel แบบไม่มี token ต้องได้ 401, dev login ผ่าน tunnel ต้องได้ 404
6. เมลที่ส่งจากกล่องเดียวกันถึงตัวเองไม่กลายเป็น ticket (label `SENT` ถูกข้ามโดยตั้งใจ) ต้องส่งจากบัญชีภายนอก · `users.watch` ต่ออายุเองทุกวัน 02:15 UTC และตอน worker start

## 5. ล็อกอินและผู้ใช้
- คนใหม่: head สร้าง user ที่ Admin → Users (ระบบไม่สร้างให้อัตโนมัติ) **และ** เพิ่มอีเมลใน `GOOGLE_ALLOWED_EMAILS` (รับเฉพาะ `@gmail.com`/`@googlemail.com`) **และ** เพิ่มเป็น test user ใน GCP → Google Auth Platform → Audience (แอปอยู่สถานะ Testing)
- ทางฉุกเฉิน: break-glass (`BREAK_GLASS_EMAIL`/`_PASSWORD` ใน env file) ที่ปุ่ม Emergency บนหน้า login
- จะเปิด dev login อีก: ต้อง comment `GOOGLE_OIDC_CLIENT_ID/SECRET` ออกก่อน (สองอย่างเปิดพร้อมกันระบบไม่ยอม boot)

## 6. รัน test โดยไม่แตะข้อมูลของ POC
integration/e2e เขียนลง DB → **ห้ามชี้ไปที่ DB/Redis/MinIO ของ stack ที่เปิดอยู่** ใช้ container ทิ้งได้:
```bash
docker run -d --name wt-qc-pg -e POSTGRES_USER=watchtower -e POSTGRES_PASSWORD=watchtower -e POSTGRES_DB=watchtower -p 127.0.0.1:45432:5432 pgvector/pgvector:0.8.7-pg16-trixie
docker run -d --name wt-qc-redis -p 127.0.0.1:46379:6379 redis:7.4-alpine
```
env ตอนรัน: `TEST_DATABASE_URL=postgres://watchtower:watchtower@localhost:45432/watchtower TEST_REDIS_URL=redis://localhost:46379 REDIS_URL=redis://localhost:46379` (+ `TEST_S3_*`, `TEST_SMTP_PORT`, `MAILPIT_URL` ถ้าใช้ MinIO/Mailpit ทิ้งได้) · web e2e: `cd apps/web && pnpm build && PW_CHANNEL=chrome npx playwright test` (port 3100 ตายตัว ห้ามรันสองชุดพร้อมกัน; แก้ web แล้วต้อง build ใหม่) · หลาย agent รันพร้อมกันต้องแยก container คนละชุด ไม่งั้น hook timeout 30 s
- flaky ที่รู้: `apps/web/e2e/shift.e2e.ts` AC-7, `e2e-fullstack/ac1-gmail.e2e.ts` "noise" (ผ่านเมื่อรันเดี่ยว)
