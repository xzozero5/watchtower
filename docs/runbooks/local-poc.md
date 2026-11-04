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
> `claude -p` (sonnet) ใช้ ~5–10 s ต่อครั้ง `[TESTED 2026-11-03]` ซึ่งนานกว่า `INGEST_CLASSIFIER_TIMEOUT_MS` default 3000 → เมื่อ `AI_PROVIDER=claude-cli` ค่าเริ่ม `INGEST_CLASSIFIER_TIMEOUT_MS` เป็น 15000 อัตโนมัติ (T-170; ตั้งเองได้และค่าที่ตั้งชนะ) ไม่งั้นตอนรับเมลเข้าจะใช้ rules แทน AI (classify ตามหลังยังทำงาน)

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
7. **ต้นทุน/ข้อห้าม:** subscription ของเจ้าของ (`ai_run.cost_usd` = 0, daily token cap ยังบังคับ) · ค่าเริ่มต้นระบบไม่ยอม boot ถ้า `AI_PROVIDER=claude-cli` แต่ `NODE_ENV=production` หรือ `APP_URL` ไม่ใช่ loopback · **เปิด opt-in (ADR-021):** ตั้ง `CLAUDE_CLI_ALLOW_REMOTE=true` ใน env file แล้ว `up -d --no-deps api worker` → config ยอมทั้งสองกรณี และ api/worker log คำเตือนหนึ่งบรรทัด `claude-cli remote opt-in enabled (ADR-021)` ตอน boot (ไม่มีค่า secret) · ค่า `false`/ว่าง = พฤติกรรมเดิม · เจ้าของรับผิดชอบเงื่อนไขบริการ Anthropic และ PDPA ของ instance (ADR-021)
8. **bridge ไม่ publish port ออก host (ADR-021):** worker เรียก `http://claude-bridge:4317` ผ่าน network `ai` (worker และ api อยู่ทั้ง `default` และ `ai` — api เรียก bridge เองสำหรับ AI assistant, ADR-023 "Live provider"; web/caddy/minio เข้า bridge ไม่ได้) · ตรวจสุขภาพใช้ `docker compose --profile ai exec claude-bridge ...` ตามข้อ 4 · **ต้องทำบน POC หลังอัปเดต:** ลบ/แก้ `CLAUDE_CLI_BRIDGE_URL=http://host.docker.internal:4317` ใน env file ที่ยังเป็นค่าเก่า (ใช้ `http://claude-bridge:4317` หรือไม่ตั้งเลย) แล้ว `docker compose --profile ai up -d claude-bridge` + `up -d --no-deps worker` (port `127.0.0.1:4317` ที่เคย publish จะหายไป)
9. **สถานะ AI ในแอป (T-170):** worker เช็ค `/healthz` ของ bridge ทุก 15 วินาทีแล้วเก็บผลไว้ใน Redis · api เปิด `GET /v1/ai/status` (`online`/`offline`/`disabled`) · เมื่อ `offline` ทุกหน้า console แสดงแถบ "AI ออฟไลน์" และงาน brief/investigate/draft ถูกเลื่อนลองใหม่ทุก 5 นาทีโดยไม่เผา attempt (นานสุด 24 ชม.) · ไม่มี report จาก worker เกิน ~50 วินาที = `offline`
11. **AI assistant (bubble) ใช้ AI จริง (ADR-023 "Live provider"):** หลังอัปเดต ให้ `docker compose --env-file D:\Works\secret\watchtower.env --profile ai up -d --build claude-bridge` (slot เพิ่มเป็น 4) แล้ว `up -d --no-deps api worker` (api ต้องถูกสร้างใหม่เพื่อเข้า network `ai`) · api ใช้ env ชุดเดียวกับ worker (`AI_PROVIDER`, `CLAUDE_CLI_BRIDGE_*`, `AI_MODEL_*`, `AI_MODEL_PRICES`) — ไม่ต้องเพิ่มตัวแปร · ตรวจ: log api ต้อง **ไม่มี** `AI provider is selected but not fully set up` · bubble ไม่ขึ้น "AI is offline" · ข้อความแรกอาจช้า 10–40 วินาที (2 call ต่อข้อความ) · `AI_API_MAX_CONCURRENCY` (default 2) = จำนวน call พร้อมกันของ api ต้องน้อยกว่า `CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY` (4) เพื่อให้ worker เหลือ slot · worker หยุด = ไม่มี report สถานะ = assistant ตอบ offline
10. **ตั้ง `INGEST_CLASSIFIER_TIMEOUT_MS` เองไม่จำเป็นอีก:** ไม่ตั้ง = 3000 ms (provider อื่น) หรือ 15000 ms เมื่อ `AI_PROVIDER=claude-cli` · ตั้งค่าเองเมื่อไรค่านั้นชนะเสมอ

## 3b. Knowledge base folder (`D:\Works\watchtower-kb`)
- นอก repo มี `README.md` อธิบายรูปแบบ (front-matter: `title, slug, lang, kind, visibility, tags, intent, orgs`) และตัวอย่างสมมติ 2 ไฟล์ใน `examples/` (ลบก่อน sync ได้)
- นำเข้า: shell ต้องมี `WATCHTOWER_KB_DIR` และ `MIGRATION_DATABASE_URL` (ชี้ Postgres ที่เครื่องนี้เข้าถึง เช่น host `localhost` ไม่ใช่ `postgres`) แล้ว `pnpm kb:sync --dry-run` (อ่าน/ตรวจไฟล์อย่างเดียว) → `pnpm kb:sync` (idempotent) · `pnpm kb:sync` อ่านเฉพาะ `.env` ใน repo root จึง export สองตัวแปรนี้ใน shell เอง ไม่พิมพ์ค่า
- `internal` → published + embedding ผ่าน worker · `customer`/`orgs` → **draft** ให้คน publish ในแอป · แก้ไฟล์ = เพิ่ม version · ลบไฟล์ = บทความที่ sync สร้างไว้ถูก deprecate (ออกจากการค้นหา; ไม่แตะบทความที่เขียนในแอป; โฟลเดอร์ว่างไม่ deprecate อะไรเลย) (T-170)

## 4. Gmail push (เฉพาะตอนอยากให้เมลใหม่ไหลเข้าเอง) — container `gmail-tunnel` (ADR-020)
Pub/Sub ต้องยิง HTTPS เข้ามาหา api จาก internet → container `gmail-tunnel` ทำครบในตัว: ตัวกรอง push-only (ปล่อยแค่ `POST /v1/inbound/gmail/push`) + Cloudflare quick tunnel (URL สุ่มใหม่ทุกครั้งที่ขึ้น) + เรียก Pub/Sub `modifyPushConfig` ชี้ subscription ไปที่ URL ใหม่เอง · audience ของ OIDC เป็นค่าคงที่ `GMAIL_PUSH_AUDIENCE` จึง**ไม่ต้อง restart api** เมื่อ URL เปลี่ยน · **ห้ามชี้ tunnel ไปที่ api ตรง ๆ**

**ตั้งครั้งเดียว**
1. GCP: สร้าง service account เช่น `watchtower-pubsub-admin` ที่แก้ได้เฉพาะ subscription นี้ — role `Pub/Sub Editor` บน **subscription** `gmail-push-sub` (ไม่ใช่ทั้ง project) + `Service Account User` บน SA ผู้ลงนาม push (`watchtower-pubsub-push`) เพราะการตั้ง OIDC ต้อง actAs SA นั้น `[VERIFY กับเอกสาร Pub/Sub ตอนตั้งจริง]` → สร้าง key JSON เก็บนอก repo ในโฟลเดอร์ secret เดียวกับ env file
2. env file: `PUBSUB_PROJECT_ID`, `GMAIL_PUSH_SERVICE_ACCOUNT` (SA ผู้ลงนาม push), `GMAIL_PUSH_AUDIENCE` = ข้อความคงที่ใดก็ได้ที่จะไม่เปลี่ยนอีก เช่น `watchtower-gmail-push` (Pub/Sub ใส่ค่านี้ใน token, api ตรวจตรงทุกตัวอักษร), `GMAIL_TUNNEL_SA_KEY_PATH=<path ของ key JSON>`, `GMAIL_TUNNEL_SUBSCRIPTION` (ไม่ใส่ = `gmail-push-sub`)
3. ถ้า `GMAIL_PUSH_AUDIENCE` เปลี่ยนจากค่าเดิม → `docker compose --env-file <env file> up -d --no-deps api` หนึ่งครั้ง

**ทุกครั้งที่อยากทดสอบเมลจริง**

4. `docker compose --env-file <env file> --profile gmail-tunnel up -d --build --no-deps gmail-tunnel` — **ต้องมี `--no-deps`**: ไม่งั้น `--build` จะ build และขึ้น api + migrate ใหม่ด้วย (เคยเกิด 2026-11-03: migration ถูกรันบน POC โดยไม่ตั้งใจ)
5. `docker compose --profile gmail-tunnel logs -f gmail-tunnel` ต้องเห็น `tunnel https://….trycloudflare.com` → `subscription … now pushes to …` → `self-check: … refused by the api (401)` · `503` = api ยังไม่มี `GMAIL_PUSH_AUDIENCE/GMAIL_PUSH_SERVICE_ACCOUNT` · container healthy เมื่อ subscribe สำเร็จเท่านั้น
6. ส่งเมลจาก**บัญชีภายนอก**เข้ากล่อง support (เมลที่กล่องเดียวกันส่งถึงตัวเองถูกข้าม label `SENT` โดยตั้งใจ) · `users.watch` ต่ออายุเองทุกวัน 02:15 UTC และตอน worker start
7. ปิด: `docker compose --profile gmail-tunnel stop gmail-tunnel` — subscription ยังชี้ URL ที่ตายแล้ว Pub/Sub จะ retry แล้วทิ้งตาม retention; เมลที่ตกหล่นดึงด้วยปุ่ม Sync/งาน sync ของ worker · container ล่ม/restart = URL ใหม่ + subscribe ใหม่อัตโนมัติ

- ทางเดิมแบบมือยังใช้ได้: `pnpm push-filter` + `cloudflared tunnel --url http://localhost:4318` แล้วแก้ Endpoint ใน console เอง (audience คงเดิม)

## 4b. หมุน key ของ SA `watchtower-pubsub-admin` ทุก 90 วัน
เจ้าของทำเอง (ไม่พิมพ์/แปะเนื้อ key ที่ไหน) · ตั้งเตือนในปฏิทินทุก 90 วัน:
1. GCP Console → IAM & Admin → Service accounts → `watchtower-pubsub-admin` → **Keys → Add key → Create new key (JSON)** บันทึกทับไฟล์ที่ `GMAIL_TUNNEL_SA_KEY_PATH` ชี้ (นอก repo; ชื่อไฟล์ใหม่ก็ได้ แล้วแก้ path ใน env file)
2. `docker compose --env-file D:\Works\secret\watchtower.env --profile gmail-tunnel up -d --force-recreate gmail-tunnel` แล้วดู log ว่า subscribe สำเร็จ (self-check ผ่าน)
3. กลับหน้า Keys **ลบ key เก่า** (ดูจากวันที่สร้าง) หลังยืนยันว่า tunnel ทำงานด้วย key ใหม่แล้ว · ลบไฟล์ key เก่าในเครื่อง
4. ถ้า key รั่วหรือสงสัย: ลบ key ทันที (ข้อ 3) ก่อน แล้วค่อยสร้างใหม่

## 5. ล็อกอินและผู้ใช้
- คนใหม่: head สร้าง user ที่ Admin → Users (ระบบไม่สร้างให้อัตโนมัติ) **และ** เพิ่มอีเมลใน `GOOGLE_ALLOWED_EMAILS` (รับเฉพาะ `@gmail.com`/`@googlemail.com`) **และ** เพิ่มเป็น test user ใน GCP → Google Auth Platform → Audience (แอปอยู่สถานะ Testing)
- ทางฉุกเฉิน: break-glass (`BREAK_GLASS_EMAIL`/`_PASSWORD` ใน env file) ที่ปุ่ม Emergency บนหน้า login
- จะเปิด dev login อีก: ต้อง comment `GOOGLE_OIDC_CLIENT_ID/SECRET` ออกก่อน (สองอย่างเปิดพร้อมกันระบบไม่ยอม boot)

## 5b. ข้อมูลจำลอง 1 ปีใน POC (สำหรับ demo) — ทำแล้ว 2026-11-03
เจ้าของเลือกให้ POC เป็นชุดเดียวทั้งต่อของจริงและมีข้อมูลจำลอง (ไม่มี demo stack แยก) · seed รันใน compose network ผ่าน `docker-compose.seed.yml` จึงใช้รหัส DB/MinIO จาก env file โดยไม่ต้องคัดลอก:
```bash
docker compose --env-file <env file> -f docker-compose.yml -f docker-compose.seed.yml --profile seed run --rm --no-deps seed
```
- **สำรองก่อนเสมอ:** `pg_dump -Fc` ลง `D:\Works\watchtower-backups\` (ทำแล้ว `poc-20261103-1711-pre-year-seed.dump`) · ถอนข้อมูลจำลองทั้งหมด = restore ไฟล์นั้น (ข้อมูลจริงที่เข้ามาหลัง 17:11 จะหายด้วย)
- seed ปฏิเสธฐานที่มี ticket > 100 และรันซ้ำไม่เพิ่ม (มี org `Kestrel Freight` เป็นตัวบอก) · tier ของ SLA ห้ามซ้ำ: policy ทดสอบ `Smoke Gold`/`QA Head SLA` ถูกปลด tier และผูกกับ org ของมันตรง ๆ แทน เพื่อให้ seed สร้าง Gold/Silver/Standard
- ข้อมูลจำลองใช้โดเมน `example` ทั้งหมด: ถ้าตอบ ticket จำลองทาง Gmail จริง อีเมลจะเด้งกลับ (ไม่ถึงใคร) · พนักงานจำลอง (`@ops.example.com`) ล็อกอินไม่ได้เพราะ dev login ปิด — เดโมด้วยบัญชี Google ของเจ้าของ (role head)

## 6. รัน test โดยไม่แตะข้อมูลของ POC
integration/e2e เขียนลง DB → **ห้ามชี้ไปที่ DB/Redis/MinIO ของ stack ที่เปิดอยู่** ใช้ container ทิ้งได้:
```bash
docker run -d --name wt-qc-pg -e POSTGRES_USER=watchtower -e POSTGRES_PASSWORD=watchtower -e POSTGRES_DB=watchtower -p 127.0.0.1:45432:5432 pgvector/pgvector:0.8.7-pg16-trixie
docker run -d --name wt-qc-redis -p 127.0.0.1:46379:6379 redis:7.4-alpine
```
env ตอนรัน: `TEST_DATABASE_URL=postgres://watchtower:watchtower@localhost:45432/watchtower TEST_REDIS_URL=redis://localhost:46379 REDIS_URL=redis://localhost:46379` (+ `TEST_S3_*`, `TEST_SMTP_PORT`, `MAILPIT_URL` ถ้าใช้ MinIO/Mailpit ทิ้งได้) · web e2e: `cd apps/web && pnpm build && PW_CHANNEL=chrome npx playwright test` (port 3100 ตายตัว ห้ามรันสองชุดพร้อมกัน; แก้ web แล้วต้อง build ใหม่) · หลาย agent รันพร้อมกันต้องแยก container คนละชุด ไม่งั้น hook timeout 30 s
- flaky ที่รู้: `apps/web/e2e/shift.e2e.ts` AC-7, `e2e-fullstack/ac1-gmail.e2e.ts` "noise" (ผ่านเมื่อรันเดี่ยว)
