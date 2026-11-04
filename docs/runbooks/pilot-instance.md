# Runbook: deploy instance ใหม่สำหรับ pilot (T-306d)

> สำหรับเจ้าของ (หรือ ops ที่เจ้าของมอบหมาย) ที่จะ deploy instance ให้ทีมจริงใช้ — **DB สะอาด ไม่มี seed 1 ปี** · POC บน `localhost` (`local-poc.md`) เป็น demo/ทดสอบ ไม่ใช่ instance นี้
> placeholder: `<ENVF>` = ไฟล์ env นอก repo, `<DOMAIN>` = ชื่อโดเมนของ instance, `<BACKUPS>` = โฟลเดอร์สำรองนอก repo · ไม่ใส่ค่าจริงของใครใน repo (N1) · **ห้ามพิมพ์ค่า secret ลง terminal/log/แชต** ตรวจได้แค่ "มี/ไม่มี" หรือความยาว
> สถานะ: เขียน 2026-11-04 · ส่วนที่ติด `[ทดสอบแล้ว]` รันจริงกับ container ทิ้งแล้ว (seed `--allow-production`, backup, restore drill, ขั้นตอน restore จริง) · **ทั้ง stack แบบ `NODE_ENV=production` บนเครื่อง pilot ยังไม่เคยรันจริง** `[ยังไม่ยืนยัน 60%]` จึงมีข้อ 11 ให้ไล่ตรวจทีละข้อ

## 0. ลำดับงาน (สรุป)

1. ตัดสินใจ 5 ข้อใน §1 (`[ASK-HUMAN]`) → 2. ตั้งเครื่อง §2 → 3. สร้าง env file + secret §4 → 4. build + ขึ้น infra + migrate + seed reference §5 → 5. ขึ้นทั้ง stack + สร้าง head คนแรก §5.5–5.7 → 6. ต่อ Gmail / AI / ClamAV §6 → 7. ตั้ง backup + ซ้อม restore §7 → 8. ตั้ง budget + ทดสอบ kill switch §8 → 9. ตรวจ stage ≤ 2 §9 → 10. checklist ก่อนเปิดให้ทีม §11

## 1. ต้องตัดสินใจก่อนเริ่ม (`[ASK-HUMAN]`)

| #   | เรื่อง                       | ทำไมต้องตัดสิน                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | เครื่องที่ใช้ + เปิดให้ใครเข้า | เครื่องเดียว (Docker Compose, ADR-001) ที่เปิดตลอดช่วง pilot · AI ผ่าน `claude -p` ใช้ได้เฉพาะตอนเครื่องนี้ online (ADR-019)                                                                                                                                                                      |
| 2   | **HTTPS + โดเมน**            | Google login ต้องใช้ redirect URI แบบ HTTPS (ยกเว้น localhost) และ Gmail push ต้อง HTTPS · `Caddyfile` ใน repo เป็น `http://:8080`, `auto_https off` ("TLS เป็นหน้าที่ของ load balancer") → ต้องมีตัวจบ TLS หน้า Caddy (เช่น Cloudflare Tunnel, reverse proxy ของเครื่อง) — **repo ยังไม่มีตัวนี้** ถ้าจะให้ Caddy ออกใบรับรองเองต้องแก้ Caddyfile + ADR (N10) |
| 3   | Google Workspace domain ของ staff | production ใช้ `GOOGLE_ALLOWED_DOMAIN` (โดเมน Workspace) เท่านั้น · `GOOGLE_ALLOWED_EMAILS` (gmail.com ส่วนตัว) **ถูกปฏิเสธเมื่อ `NODE_ENV=production`** · ถ้าไม่มี Workspace ต้องตัดสินใจเองว่า pilot จะรันแบบไหน (ดู §6.1)                                                                         |
| 4   | SMTP relay ขาออก             | ไม่ตั้ง = อีเมลทั้งหมด (magic link, CSAT, แจ้งเตือน) ไปค้างที่ Mailpit ในเครื่อง ไม่ถึงใคร · production บังคับ TLS + login เว้นแต่ `SMTP_ALLOW_INSECURE=true` (relay ภายในที่ไว้ใจได้)                                                                                                                 |
| 5   | AI: `claude-cli` หรือ provider อื่น | `claude-cli` บน instance ที่ไม่ใช่ loopback ต้องตั้ง `CLAUDE_CLI_ALLOW_REMOTE=true` (ADR-021) · เจ้าของรับผิดชอบเงื่อนไขบริการ Anthropic + PDPA ของ instance เอง (ADR-021 ข้อ 1)                                                                                                                       |

## 2. ตั้งเครื่อง

- Docker Engine/Desktop + **Docker Compose ≥ 2.24** (`docker-compose.proxy.yml` ใช้ `!reset`) `[ยืนยันแล้ว จากหัวไฟล์ compose]` · `git`, `bash` (Git Bash บน Windows ได้), Node + pnpm เฉพาะถ้าจะรัน `pnpm kb:sync` / CLI จาก host
- ทรัพยากร `[ASSUMED]`: RAM ≥ 8 GB ว่าง (api จำกัด 1 GB, ClamAV ~1.5 GB, Postgres/Redis/MinIO/web/worker), ดิสก์ ≥ 30 GB ว่าง + ที่สำรองแยก ถ้าเปิด sleep/hibernate ระบบ AI จะ offline
- clone repo ที่ tag/commit ที่ตัดสินใจ แล้ว **ไม่สร้าง `.env` ใน repo** (pre-commit บล็อก `.env`) ใช้ `--env-file <ENVF>` ทุกคำสั่ง
- compose project ชื่อ `watchtower` (กำหนดใน `docker-compose.yml`) → **อย่าให้ instance pilot ชื่อชนกับ POC บนเครื่องเดียวกัน**: ใช้เครื่องคนละเครื่อง หรือปิด POC ก่อน (volume `pgdata` ชื่อเดียวกัน อาจทับข้อมูล POC)

### Compose profiles / ไฟล์ที่เกี่ยวข้อง

| ส่วน                              | สั่งอย่างไร                                                    | pilot                                |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| default (postgres, redis, minio, mailpit, migrate, api, worker, web, caddy) | `docker compose ... up -d --wait` | **เปิด**                             |
| `docker-compose.proxy.yml`        | `-f docker-compose.yml -f docker-compose.proxy.yml`            | **ใช้** (api ไม่ publish port, `TRUST_PROXY_HOPS=1`, ทุกอย่างผ่าน Caddy origin เดียว) |
| `--profile ai` (claude-bridge)    | ดู §6.2                                                        | เปิดถ้าใช้ `claude-cli`              |
| `--profile scan` (clamav)         | ดู §6.3                                                        | **เปิด** (`UPLOAD_SCAN=clamav`)      |
| `--profile gmail-tunnel`          | ดู §6.1                                                        | เฉพาะถ้าไม่มี HTTPS ถาวร             |
| `--profile seed` (`docker-compose.seed.yml`) | ดู §5.4 (**เฉพาะ `--allow-production`**)            | ใช้ครั้งเดียว                        |
| `--profile product-mock`          | —                                                              | **ห้ามเปิด** (DB จำลองสำหรับ demo)   |

## 3. สิ่งที่ pilot ต่อจริงได้ / ยัง mock

ตรงกับ `local-poc.md` §1: Gmail (OAuth + Pub/Sub), AI (`claude -p`), ล็อกอิน Google = จริงได้ · **LINE, Discord, GCP logs/BigQuery = mock จนกว่าจะมี credential** (ADR-014, `credentials.md`) → ห้ามบอกทีมว่าช่องทางเหล่านี้ใช้งานจริง · ทุกค่า `*_MOCK_ENABLED`/`*_FAKE_ENABLED` ต้อง `false`/ว่าง (production ปฏิเสธ boot ถ้า true)

## 4. env file และ secret checklist

สร้าง `<ENVF>` นอก repo จาก `.env.example` (**คัดลอกชื่อตัวแปร ไม่คัดลอกค่า "ตัวอย่าง"**) · สร้าง secret ด้วยคำสั่งใน `credentials.md` §3.1 (`gen`/`genhex` เขียนลงไฟล์ ไม่พิมพ์ค่า; `openssl` ใน Git Bash ต้อง `tr -d '\r\n'`) · ตัวแปรที่ api/worker อ่านทั้งหมดอยู่ใน `.env.example` และ `x-app-env` ของ `docker-compose.yml` (มี test กันตก)

### 4.1 บังคับ (ไม่ตั้ง = boot ไม่ขึ้น หรือไม่ปลอดภัย)

| ตัวแปร                                                                         | ค่า / วิธีได้                                                                           | หมายเหตุ                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                     | `production`                                                                            | เปิดกฎ boot เข้ม (ไม่มี `change-me`, secret ≥ 32 bytes, ไม่มี dev login)                              |
| `APP_URL`, `API_URL`, `PROXY_PUBLIC_URL`                                       | `https://<DOMAIN>` และ `https://<DOMAIN>/api` (`PROXY_PUBLIC_URL` = origin ที่ browser เห็น) | ใช้ใน link อีเมล, cookie, redirect URI                                                                |
| `JWT_SECRET`                                                                   | สุ่ม ≥ 32 ตัวอักษร (`gen JWT_SECRET 48`)                                                | เปลี่ยน = session ทุกอันหลุด                                                                          |
| `APP_ENCRYPTION_KEY`                                                           | base64 ของ 32 bytes (`gen APP_ENCRYPTION_KEY 32`)                                       | **สำรองใน password manager แยกจาก DB backup** — หาย = credential ใน DB เปิดไม่ได้ (ADR-004/012)         |
| `PORTAL_TOKEN_SECRET`                                                          | สุ่ม (`gen PORTAL_TOKEN_SECRET 32`)                                                     | ตั้งแยกเพื่อหมุน `APP_ENCRYPTION_KEY` ได้โดยลิงก์ลูกค้าไม่พัง                                           |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                            | รหัสผ่านสุ่ม (`genhex POSTGRES_PASSWORD 24`, URL-safe)                                  | ต้องตั้ง**ก่อน**ขึ้น Postgres ครั้งแรก (volume init ด้วยรหัสแรก)                                      |
| `APP_DB_USER`, `APP_DB_PASSWORD`                                               | `genhex APP_DB_PASSWORD 24`                                                             | role จำกัดที่ api/worker ใช้ (ไม่มีสิทธิ์ DDL, แก้/ลบ audit ไม่ได้) สร้างโดย `migrate`                  |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`                                               | `genhex S3_SECRET_KEY 24`                                                               | MinIO root (ไฟล์แนบ)                                                                                 |
| `DEV_LOGIN_ENABLED`                                                            | `false`                                                                                 | `true` ใน production = boot ล้ม                                                                      |
| `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`  | จาก `credentials.md` §3.2                                                               | redirect URI = `<API_URL>/v1/auth/google/callback` ต้องตรงทุกตัวอักษร · production ต้องมีทั้งสามค่า    |
| `GOOGLE_ALLOWED_EMAILS`                                                        | **ว่าง**                                                                                | production ปฏิเสธถ้าไม่ว่าง                                                                           |
| `BREAK_GLASS_EMAIL`, `BREAK_GLASS_PASSWORD`                                    | **ว่าง** แล้วสร้างด้วย CLI ผ่าน stdin (§5.6)                                            | ไม่เก็บรหัสผ่านใน env                                                                                |
| `TICKET_KEY_PREFIX`                                                            | เช่น `OPS` (2–10 ตัว ขึ้นต้นด้วยตัวอักษร)                                               | เปลี่ยนทีหลังได้แต่คีย์ที่ส่งในอีเมลแล้วใช้ prefix เก่า                                                |
| `GMAIL_MOCK_ENABLED`, `LINE_LOGIN_FAKE_ENABLED`, `CREDENTIAL_LIVE_TEST_ENABLED` | `false`/ว่าง                                                                            | `CREDENTIAL_LIVE_TEST_ENABLED=true` = ปุ่ม Test ยิง service จริง เปิดเมื่อเจ้าของตัดสิน                  |

### 4.2 อีเมลออก

`SMTP_RELAY_HOST`, `SMTP_RELAY_PORT` (465 = TLS, 587 = STARTTLS), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (ที่อยู่ที่ relay อนุญาตให้ส่ง) · `SMTP_ALLOW_INSECURE=false` เว้นแต่บันทึกการยอมรับความเสี่ยง · ไม่ตั้ง `SMTP_RELAY_HOST` = ไป Mailpit (ใช้เทสเท่านั้น; Mailpit UI ผูก `127.0.0.1` ไม่เปิด internet)

### 4.3 AI และงบ

| ตัวแปร                                                                             | ค่า                                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                                                      | `claude-cli` (ต้องคู่กับ `CLAUDE_CLI_ALLOW_REMOTE=true`) หรือ provider อื่นที่เจ้าของเลือก; `mock` = ไม่มี AI จริง |
| `CLAUDE_CLI_ALLOW_REMOTE`                                                          | `true` (เฉพาะถ้า `AI_PROVIDER=claude-cli`; api/worker log คำเตือนหนึ่งบรรทัดตอน boot)                     |
| `CLAUDE_CLI_BRIDGE_URL`, `CLAUDE_CLI_BRIDGE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`      | `http://claude-bridge:4317`, token สุ่ม ≥ 16 ตัว (`openssl rand -hex 24`), token จาก `claude setup-token` (§6.2) |
| `AI_MODEL_DEEP`/`_STANDARD`/`_LIGHT`, `AI_MODEL_PRICES`, `AI_AGENT_MODEL_*`        | ตาม `local-poc.md` §3 ข้อ 2 และ 12                                                                      |
| `AI_DAILY_COST_CAP_USD`, `AI_DAILY_TOKEN_CAP`, `AI_BUDGET_ALERT_PERCENT`           | ดู §8 · ว่าง = ค่าใน `config/budgets.yaml` (1 USD / 500,000 token / 80%) `[ASSUMED]`                    |
| `AI_AUTOSEND_ENABLED`                                                              | **ไม่ตั้ง / `false`** (stage 3 ปิด, ADR-025)                                                          |
| `REDACTION_NER`                                                                    | ว่าง/`off` หรือ `local` (T-153) — วัดผลก่อนเปิด                                                       |
| `WATCHTOWER_KB_DIR`                                                                | โฟลเดอร์ KB นอก repo (ถ้าใช้ `pnpm kb:sync`)                                                         |

### 4.4 Gmail, ClamAV, ไฟล์

`GMAIL_OAUTH_CLIENT_ID`/`_SECRET` (หรือบันทึกผ่าน Admin › Integrations), `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT`, `PUBSUB_PROJECT_ID` ฯลฯ ตาม `credentials.md` §3.3–3.5 · `UPLOAD_SCAN=clamav` · `UPLOAD_RETENTION_DAYS` (ตัดสินร่วมกับเรื่อง PDPA; 0 = เก็บตลอด)

### 4.5 ตรวจว่าตั้งแล้วโดยไม่พิมพ์ค่า

```bash
ENVF=<ENVF>
chk() { v=$(grep -m1 "^$1=" "$ENVF" | cut -d= -f2-); [ -n "$v" ] && echo "$1: set (${#v} chars)" || echo "$1: EMPTY/missing"; }
for k in JWT_SECRET APP_ENCRYPTION_KEY PORTAL_TOKEN_SECRET POSTGRES_PASSWORD APP_DB_PASSWORD S3_SECRET_KEY \
         GOOGLE_OIDC_CLIENT_ID GOOGLE_OIDC_CLIENT_SECRET GOOGLE_ALLOWED_DOMAIN SMTP_RELAY_HOST; do chk $k; done
# ค่าที่ต้องไม่มี: ตรวจเฉพาะ "มีบรรทัดที่มีค่า" ไม่พิมพ์ค่า
for k in GOOGLE_ALLOWED_EMAILS BREAK_GLASS_PASSWORD AI_AUTOSEND_ENABLED; do
  v=$(grep -m1 "^$k=" "$ENVF" | cut -d= -f2-); [ -z "$v" ] || [ "$v" = false ] && echo "$k: ok (empty/false)" || echo "$k: MUST BE EMPTY"; done
grep -c 'change-me' "$ENVF"   # ต้องได้ 0
```

## 5. Deploy

ทุกคำสั่งรันที่ root ของ repo · `DC` = `docker compose --env-file <ENVF> -f docker-compose.yml -f docker-compose.proxy.yml`

### 5.1 Build

```bash
DC build
```

### 5.2 Infra

```bash
DC up -d --wait postgres redis minio minio-init
```

`mailpit` จะขึ้นด้วยเมื่อขึ้น `worker` (worker พึ่ง Mailpit ใน compose) — ไม่เป็นไรถ้า `SMTP_RELAY_HOST` ตั้งแล้ว (worker ส่งผ่าน relay)

### 5.3 Migrate (schema + role ของ app) — ย้อนกลับได้

```bash
DC run --rm migrate          # ใช้ DATABASE_URL ของเจ้าของ schema สร้าง role APP_DB_USER ให้ด้วย
```

migration แต่ละไฟล์มี `.down.sql` คู่ (`pnpm db:rollback` จาก host ถ้าจำเป็น) · ก่อน migrate ทุกครั้งหลังมีข้อมูลจริง → **backup ก่อน** (§7)

### 5.4 Seed ข้อมูลอ้างอิงเท่านั้น (`--allow-production`) `[ทดสอบแล้ว 2026-11-04 กับ Postgres ทิ้ง]`

seed โหลด: calendar วันหยุด, SLA policy ตาม tier, intent เริ่มต้น (stage 2), นิยามกะ — **ไม่สร้าง** org / user / contact / ticket / audit / บทความตัวอย่าง · ไม่เรียก email/LINE/Discord/Gmail/GCP · รันซ้ำไม่เพิ่ม

```bash
DC -f docker-compose.seed.yml --profile seed run --rm --no-deps seed \
  node node_modules/@watchtower/db/dist/seed-cli.js --allow-production
```

- ต้องระบุ command เอง — ค่าเริ่มต้นของ service `seed` รัน `--scenario year` (ข้อมูลจำลอง 1 ปี) ด้วย **ห้ามใช้ใน pilot**
- `NODE_ENV=production` มาจาก env file; ถ้าลืม `--allow-production` seed ปฏิเสธ (ทดสอบแล้ว)
- ผลที่ต้องเห็น: `reference data only: no demo organizations, users, tickets or articles` และ `tickets +0, organizations +0, users +0`
- **วันหยุดในไฟล์ตัวอย่างเป็น `[VERIFY]`** (ไม่ได้อ่านจากประกาศ ครม. จริง) → head ต้องตรวจ/แก้ calendar + SLA policy ใน Admin ก่อนใช้ SLA จริง (§11)
- ตรวจ DB สะอาด:

```bash
DC exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
  "select (select count(*) from ticket) as tickets, (select count(*) from users) as users, (select count(*) from organization) as orgs, (select count(*) from audit_log) as audit"'
# ต้องได้ 0|0|0|0 ก่อนสร้าง head คนแรก
```

### 5.5 ขึ้นทั้ง stack

```bash
DC up -d --wait                       # api, worker, web, caddy (+ mailpit)
DC ps                                 # ทุก service healthy; api ไม่ publish port (ผ่าน Caddy เท่านั้น)
```

- ตัวจบ TLS (ข้อ 2 ใน §1) ชี้ไปที่ Caddy `127.0.0.1:${CADDY_PORT:-8080}` · เปิด `https://<DOMAIN>` ต้องเห็นหน้า login (ปุ่ม Google, ไม่มี dev login)
- `DC logs api | head` ต้อง**ไม่มี** `AI provider is selected but not fully set up` และต้องมี `claude-cli remote opt-in enabled (ADR-021)` ถ้าใช้ claude-cli

### 5.6 สร้าง head คนแรก (ครั้งเดียว)

Google login ปฏิเสธคนที่ยังไม่มี user ที่ head สร้างไว้ (`staff_not_provisioned`) จึงต้องสร้าง break-glass ก่อน แล้วเข้าไปเชิญทีม:

```bash
read -rs -p 'break-glass password (>=12): ' P; echo
printf '%s\n' "$P" | DC run --rm --no-deps -T api node dist/cli/break-glass.js head@<DOMAIN>
unset P
```

(ยังไม่เคยรันคำสั่งนี้ผ่าน compose จริง `[ยังไม่ยืนยัน 70%]` — `credentials.md` §3.1 ก็ติด `[VERIFY]`; ถ้า `run -T` อ่าน stdin ไม่ได้ ใช้ `DC exec -T api ...` กับ api ที่ขึ้นแล้ว) · เก็บรหัสใน password manager · เข้าผ่านปุ่ม Emergency บนหน้า login

### 5.7 Allow-list ผู้ใช้ Google

allow-list มี 2 ชั้น (ต้องผ่านทั้งคู่):

1. **โดเมน** — `GOOGLE_ALLOWED_DOMAIN` ตรวจ claim `hd` และอีเมลลงท้ายโดเมนนั้น (บัญชี gmail.com เข้าไม่ได้) · OAuth consent = Internal (`credentials.md` §3.2)
2. **รายคน** — head สร้าง user ที่ Admin › Users ทีละคน พร้อม role (agent/lead/head) · ระบบไม่สร้าง user อัตโนมัติ · คนที่ไม่ได้ถูกสร้าง = ปฏิเสธ

ตรวจ: ลองล็อกอินด้วยบัญชีในโดเมนที่ยังไม่ถูกสร้าง ต้องถูกปฏิเสธ; ด้วยบัญชี gmail.com ต้องถูกปฏิเสธ

## 6. Integrations

### 6.1 Gmail และ gmail-tunnel

- ต่อ OAuth ของกล่อง support ตาม `credentials.md` §3.3 (redirect URI `<API_URL>/v1/admin/integrations/gmail/oauth/callback`; token เก็บเข้ารหัสใน DB อ่านกลับไม่ได้) แล้วกด Connect ที่ Admin › Integrations (head)
- **ถ้ามี HTTPS ถาวร (§1 ข้อ 2):** Pub/Sub push ชี้ `https://<DOMAIN>/api/v1/inbound/gmail/push` (Caddy ตัด `/api`) ตั้งตาม `credentials.md` §3.5 · ไม่ต้องใช้ gmail-tunnel
- **ถ้าไม่มี:** ใช้ container `gmail-tunnel` (ADR-020, Cloudflare quick tunnel + ตัวกรอง push-only, URL สุ่มใหม่ทุกครั้งที่ขึ้น) ตาม `local-poc.md` §4 — ต้อง `--no-deps` เสมอ · เหมาะกับ POC มากกว่า pilot: URL เปลี่ยนเมื่อ container restart และเมลที่เข้าระหว่างล่มต้องดึงด้วย Sync
- ไม่มี push = ปุ่ม Sync now / งาน sync ของ worker ดึงเมลได้ (ช้ากว่า) · เมลที่กล่องเดียวกันส่งถึงตัวเองถูกข้ามโดยตั้งใจ — ทดสอบด้วยบัญชีภายนอก
- หมุน key ของ SA ทุก 90 วัน: `local-poc.md` §4b

### 6.2 claude-bridge (`claude -p`, ADR-019/021)

1. เจ้าของรัน `claude setup-token` เอง (ต้องมี subscription) นำ token ใส่ `<ENVF>` เป็น `CLAUDE_CODE_OAUTH_TOKEN` — **ห้ามพิมพ์/แปะ**
2. ใน `<ENVF>`: `AI_PROVIDER=claude-cli`, **`CLAUDE_CLI_ALLOW_REMOTE=true`**, `CLAUDE_CLI_BRIDGE_URL=http://claude-bridge:4317`, `CLAUDE_CLI_BRIDGE_TOKEN`, `AI_MODEL_*`, `AI_MODEL_PRICES` (`local-poc.md` §3)
3. ```bash
   DC --profile ai up -d --build claude-bridge
   DC up -d --no-deps api worker       # ให้ api/worker อ่านค่าใหม่และเข้า network ai
   ```
4. ตรวจ: `DC --profile ai ps claude-bridge` = healthy · `DC --profile ai exec claude-bridge node -e "fetch('http://127.0.0.1:4317/healthz').then(r=>r.text()).then(console.log)"` ต้อง `"online":true` · log worker `AI provider is ready` · ที่ Admin › AI การ์ด model ต่อ agent (`GET /v1/ai/models`)
5. bridge **ไม่ publish port** (เฉพาะ network `ai`; worker และ api เข้าได้) และต้องมี bearer token เสมอ · host offline = `AI ออฟไลน์` และงานรอลองใหม่ ไม่ fallback เป็น mock · ต้นทุนเป็น subscription (`cost_usd` = 0) จึง**ต้องพึ่ง `AI_DAILY_TOKEN_CAP`** (§8)
6. ตรวจซ้ำเมื่อ: เงื่อนไขบริการ Anthropic เปลี่ยน, มีคนนอกทีมเจ้าของเข้า instance (ADR-021)

### 6.3 ClamAV (`UPLOAD_SCAN=clamav`, ADR-022)

```bash
# <ENVF>: UPLOAD_SCAN=clamav
DC --profile scan up -d --wait        # ครั้งแรกโหลด signature ~300 MB ใช้เวลาหลายนาที; RAM ~1.5 GB
DC up -d --no-deps api worker         # ถ้า UPLOAD_SCAN เพิ่งเปลี่ยน
```

- ตรวจ: `clamav` healthy · `GET /v1/admin/upload-scan` (ล็อกอินเป็น head) ได้ `mode` = `clamav` และ**ไม่มี** `notice: "scan_off"` · อัปโหลดไฟล์ทดสอบ (EICAR สตริงมาตรฐาน) บน portal ต้องถูกปฏิเสธ/ลบและมี audit `upload.scan_infected`
- clamd ล่ม = ไฟล์ค้าง `pending` ไม่ถูกปล่อย · egress ใหม่ 1 ปลายทาง `database.clamav.net` (freshclam)
- ข้อจำกัดที่รู้: zip ที่ไฟล์ข้างในใหญ่เกิน `MaxFileSize` ได้ `OK` (B-007) — เจ้าของตัดสินให้ "reject at upload" (T-182) · ตรวจว่า T-182 เสร็จหรือบันทึกการยอมรับความเสี่ยงก่อนเปิดให้ลูกค้าอัปโหลด

### 6.4 ที่ยัง mock

LINE OA, Discord, GCP logs/BigQuery: ไม่ตั้ง credential = mock · pilot ไม่ควรโฆษณาช่องทางเหล่านี้ · เปิดเมื่อมี credential จริง (`credentials.md` §3.6–3.11, ต้อง `[ASK-HUMAN]`)

## 7. Backup / restore

**สิ่งที่ต้องสำรอง:** (1) Postgres (`backup.sh`) (2) ไฟล์แนบใน MinIO (volume `miniodata`) (3) `<ENVF>` และ `APP_ENCRYPTION_KEY` — **เก็บคนละที่กับ dump** (4) Redis ไม่ต้อง: คิวงานและ outbox อยู่ใน Postgres (ADR-006), rate-limit counter เกิดใหม่ได้

ไฟล์ dump มีข้อมูลลูกค้าและ credential (เข้ารหัสด้วย `APP_ENCRYPTION_KEY`) → ปฏิบัติเหมือน secret: เก็บนอก repo, สิทธิ์ 600 (script ตั้งให้), ไม่ส่งทางแชต, กำหนดอายุเก็บ (PDPA) `[ASK-HUMAN]` จำนวนวัน

### 7.1 สำรอง `[ทดสอบแล้ว]`

```bash
tools/restore-drill/backup.sh --container watchtower-postgres-1 --out <BACKUPS> --label pre-pilot
```

- รัน `pg_dump -Fc` **ใน** container Postgres (เวอร์ชันตรงกับ server) เขียนไฟล์ฝั่ง host, ตรวจว่า `pg_restore -l` อ่านได้ก่อนเปลี่ยนชื่อเป็นไฟล์สุดท้าย · ไม่แตะ DB (อ่านอย่างเดียว) · ชื่อ container ดูจาก `DC ps` (`WATCHTOWER_PG_CONTAINER` ตั้งแทน `--container` ได้)
- ตั้งเวลา: ก่อนเปิดทีม 1 ครั้ง, ก่อน migrate/อัปเดตทุกครั้ง, แล้ววันละครั้งระหว่าง pilot `[ASSUMED]` (Windows Task Scheduler เรียก `bash.exe tools/restore-drill/backup.sh ...` หรือ cron)
- ไฟล์แนบ (MinIO) `[ยังไม่ยืนยัน 50%]`: หยุดเขียนสั้น ๆ แล้ว `docker run --rm -v watchtower_miniodata:/data:ro -v <BACKUPS>:/out alpine tar czf /out/minio-$(date -u +%Y%m%d).tgz -C /data .` (ชื่อ volume `watchtower_miniodata` ตามชื่อ project; ยังไม่ได้ลองรันจริง)

### 7.2 ซ้อม restore ลง stack ทิ้ง `[ทดสอบแล้ว]`

```bash
tools/restore-drill/restore-drill.sh <BACKUPS>/watchtower-YYYYMMDD-HHMMSS-pre-pilot.dump \
  --source-container watchtower-postgres-1
```

- สร้าง container Postgres ทิ้ง (ชื่อ `wt-restore-drill-<pid>`, **ไม่ publish port**, ไม่เกี่ยวกับ stack จริง), สร้าง role ที่ dump อ้างถึง, `pg_restore --exit-on-error`, แล้วตรวจ: extension `vector`, ตาราง migration, จำนวนตาราง, สวิตช์ AI ทั้งสอง, `audit_log` อ่านได้, **ไม่มี intent เกิน stage 2** และ (เมื่อให้ `--source-container`) จำนวนแถวทุกตารางตรงกับต้นทาง (อ่านด้วย `SELECT count(*)` เท่านั้น) · ลบ container ทิ้งเองเมื่อจบ (`--keep` ไว้ดู)
- exit 0 = ผ่านทุกข้อ, 1 = มีข้อไม่ผ่าน · ผลที่ทดสอบ 2026-11-04: ผ่านกับ DB หลัง migrate+seed reference (102 ตาราง, 55 migration), **ตกถูกต้อง**เมื่อ source มีแถวใหม่หลังทำ dump และเมื่อไฟล์ dump ถูกตัด
- ซ้อมก่อนเปิดทีม 1 ครั้ง และทุกสัปดาห์ระหว่าง pilot `[ASSUMED]` · ซ้อมแล้วถ้าไม่เคยเห็น PASS = ยังไม่มี backup

### 7.3 กู้คืนจริง (ลง instance ใหม่หรือหลังเครื่องพัง) `[ทดสอบแล้ว]`

```bash
# 1. stack ใหม่ + secret เดิม (โดยเฉพาะ APP_ENCRYPTION_KEY) แล้ว:  DC up -d --wait postgres redis minio minio-init
# 2. migrate ครั้งเดียวเพื่อสร้าง role (role เป็นของทั้ง cluster ไม่อยู่ใน dump)
DC run --rm migrate
# 3. ทิ้ง DB ว่างแล้วสร้างใหม่ (ถอด stack ที่ต่ออยู่ก่อน: DC stop api worker web)
DC exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""'
# 4. restore ลง DB ว่าง (ไม่ใช้ --clean: ตกบนตาราง partition [ทดสอบแล้ว])
DC exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < <BACKUPS>/<file>.dump
# 4b. ถ้าสั่งจาก Windows แล้ว path เพี้ยน ให้ตั้ง MSYS_NO_PATHCONV=1 นำหน้า
# 5. DC run --rm migrate (ว่างเปล่า = ไม่ทำอะไร, ใช้ยืนยันว่า schema ตรง) แล้ว DC up -d --wait
```

ทดสอบกับ container ทิ้ง: migrate → drop/create → `pg_restore --no-owner` ผ่าน (exit 0) และ role `APP_DB_USER` ล็อกอินอ่านข้อมูลได้ · ขั้น 3 ใช้ `-c` สองตัวใน psql ตัวเดียว (ไม่ได้ลองรูปแบบ `DC exec` ที่ห่อ quote นี้บน Windows `[ยังไม่ยืนยัน 70%]` — ถ้า quote เพี้ยนให้ `DC exec postgres psql ...` ทีละคำสั่ง)

## 8. Kill switch และ budget

1. ตั้งเพดาน AI ใน `<ENVF>`: `AI_DAILY_TOKEN_CAP` (สำคัญที่สุดกับ `claude-cli` เพราะ cost = 0), `AI_DAILY_COST_CAP_USD` (provider ที่คิดเงิน), `AI_BUDGET_ALERT_PERCENT` (เตือนที่ N%, หยุดที่เพดาน → ตกกลับไป rules) แล้ว `DC up -d --no-deps api worker` · ค่าใน `config/budgets.yaml` เป็น `[ASSUMED]` เจ้าของปรับตามจริง
2. ตรวจ: head/lead เปิด Admin › AI (การ์ดงบ) หรือ `GET /v1/ai/budget` (สิทธิ์ `ai.autonomy.set`) ต้องเห็นเพดานตามที่ตั้ง, ใช้ไปเท่าไร, เวลารีเซ็ต (UTC) · เพดานรายผู้ใช้ของ assistant: `ASSISTANT_*` / `config/budgets.yaml`
3. **ทดสอบ kill switch ก่อนเปิดทีม** (head เท่านั้น, ต้องกรอกเหตุผลทั้งเปิดและปิด, มี audit):
   - Admin › AI → "stop all AI runs" (หรือ `POST /v1/autonomy/switches` `ai_kill_switch`) → ทุกหน้า console ขึ้นแถบ "AI paused", ticket ใหม่ไม่มี brief/draft จาก AI, auto-ack จากเทมเพลตปลอดภัยยังส่ง
   - `DC exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "select key, is_on from ai_switch"'` ต้องเห็น `ai_kill_switch|t` → ปิดสวิตช์ → `|f`
   - `ai_stage_cap_pinned` ("จำกัดทุก intent ไม่เกิน stage 2") **แนะนำให้เปิดตลอด pilot** `[ASSUMED]` — กันการเลื่อน stage โดยไม่ตั้งใจ
4. **ทางฉุกเฉินนอกแอป** (เมื่อเข้าแอปไม่ได้): `DC stop worker` หยุดงาน AI ทั้งหมดและการส่งออก; `DC --profile ai stop claude-bridge` ทำให้ AI offline (ไม่ fallback เป็น mock); คืนค่าด้วย `DC up -d --no-deps worker`

## 9. ตรวจว่าทุก intent อยู่ stage ≤ 2 (N3)

```bash
DC exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
  "select key, autonomy_stage, autonomy_pinned from intent order by autonomy_stage desc, key"'
# ต้องไม่มีแถวที่ autonomy_stage > 2   (หลัง seed reference: 11 intent ทั้งหมด = 2)
```

หรือ `GET /v1/autonomy` (staff) · ฐานข้อมูลบังคับเพดานด้วย CHECK + ฟังก์ชัน promotion เท่านั้น (migration 0007 (stage 3 จะมาพร้อม T-304b, ตรวจซ้ำเมื่อ merge)) · เมื่อ restore จาก backup ให้ `restore-drill.sh` ตรวจข้อนี้ให้ · เงื่อนไขอื่นที่ต้องเป็นจริง: `AI_AUTOSEND_ENABLED` ไม่ตั้ง/`false` (ADR-025) → ไม่มี `ai_auto` ส่งหาลูกค้า · stage 3 เปิดได้ต่อเมื่อเจ้าของอนุมัติ (นับ 4 สัปดาห์ตาม STATUS) ไม่ใช่ใน runbook นี้

### 9b. บันทึกผล replay ก่อนเลื่อน intent เป็น stage 3 (T-306g)

gate ของ auto-send อ่าน `ai_replay_result` แถวล่าสุดของ "ชุดปัจจุบัน" (drafter model + grader model + prompt version ของสองตัว + procedure version ที่ publish) — ไม่มีแถวที่ผ่านของชุดนั้น = `replay_missing` (ระงับ ไม่ rollback) · เปลี่ยน model, prompt หรือ publish procedure ใหม่ทุกครั้งต้องบันทึกใหม่ · แถวเขียนได้ทางเดียวคือ `record_replay_result()` โดยผู้ถือ `ai.autonomy.promote` (ฐานข้อมูลตรวจ) และ **`passed` เป็นจริงไม่ได้ถ้าเป็น mock / ไม่มีเคส / มี violation / redaction eval ไม่ผ่าน**

```bash
# ใช้ DATABASE_URL ของ login แอป (ไม่ใช่ owner) และ AI_PROVIDER=claude-cli + env ของ provider ครบ (§4.3, §6.2) [ASK-HUMAN: เปิดใช้ provider จริง]
# ซ้อมก่อน: แสดงผลโดยไม่บันทึก (ใช้ AI call จริงตาม --max-calls)
pnpm --filter @watchtower/eval-runner record -- --intent <key> --as <อีเมลของ head> --dry-run --max-calls 60
# บันทึกจริง (ซ้ำคำสั่งเดิมโดยตัด --dry-run)
pnpm --filter @watchtower/eval-runner record -- --intent <key> --as <อีเมลของ head> --max-calls 60
```

- คำสั่งอ่าน ticket ที่ resolve/closed ล่าสุดของ intent (ไม่นับ ticket seed, ค่าเริ่ม 90 วัน / 30 ใบ ปรับด้วย `--days` `--limit`), redact แล้วรัน drafter + grader + redaction eval · พิมพ์เฉพาะตัวเลข (ชุด model/version, จำนวน ticket/เคส/violation, ผล redaction, จำนวน call) ไม่พิมพ์ข้อความ ticket
- `--max-calls` คือ budget guard ของรอบนี้: ถ้าหยุดกลางทางจะ **ไม่บันทึก** (exit 2) ให้เพิ่มค่าแล้วรันใหม่
- `passed yes` ต้องเห็นพร้อม `violations 0`, `redaction eval passed`, `provider real` · `provider mock` บันทึกได้แต่ไม่มีทางผ่าน (ใช้ตรวจ plumbing)
- ถ้า intent มี procedure ที่ publish: ต้องมี `procedure_simulation` ที่ผ่านบน steps เดียวกันด้วย (T-303d) ไม่เช่นนั้น gate ยังเห็น `replay_missing`
- ข้อจำกัด: violation = เคส drafter/grader ที่ตก check (ภาษา, review flag, invariant ของ grader) ส่วน classifier ไม่นับ (label คือสิ่งที่ ticket จบด้วย ไม่ใช่การตัดสิน) · ยังไม่เคยรันกับ provider จริง `[ยังไม่ยืนยัน]`

## 10. ปิด pilot / ถอย

หยุดรับเมล: ปิด subscription Pub/Sub หรือ `DC stop worker` · สำรองสุดท้าย (§7.1) · เก็บ/ลบข้อมูลตามนโยบายที่เจ้าของกำหนด `[ASK-HUMAN]` (ลบข้อมูลย้อนกลับไม่ได้) · ถอน Google OAuth client / SA key ที่ใช้ (`credentials.md` §4)

## 11. Checklist ก่อนเปิดให้ทีม (pilot readiness)

อ้าง gate ของ `po` (STATUS 2026-11-04): pilot เริ่มเมื่อ T-113, T-114 (ไม่มี P0/P1), T-125a, T-207 ปิด แล้ว `[ASK-HUMAN]` เริ่ม pilot — ตรวจสถานะจริงใน `docs/STATUS.md` ก่อน · ติ๊กทีละข้อพร้อมหลักฐาน (คำสั่ง/หน้าจอ ไม่ใช่ค่า secret)

**Gate ของโปรเจกต์**

- [ ] T-113, T-114, T-125a, T-207 ปิดตาม `docs/STATUS.md` และไม่มี P0/P1 ค้าง
- [ ] เจ้าของตัดสิน 5 ข้อใน §1 แล้ว และสั่งเริ่ม pilot (`[ASK-HUMAN]`)

**โครงสร้างและความลับ**

- [ ] §4.5 ผ่าน: secret ครบ/ความยาวถูก, `change-me` = 0, `GOOGLE_ALLOWED_EMAILS` ว่าง, `AI_AUTOSEND_ENABLED` ไม่ตั้ง
- [ ] `APP_ENCRYPTION_KEY` และ `<ENVF>` สำรองใน password manager คนละที่กับ dump
- [ ] `DC ps` ทุก service healthy · ไม่มี port ของ api/postgres/redis/minio เปิดออกนอก `127.0.0.1` · `product-mock` ไม่ถูกเปิด
- [ ] เข้าผ่าน `https://<DOMAIN>` ได้ ใบรับรองถูกต้อง · `/docs` ปิด (production) · `/metrics` ไม่เปิดสาธารณะ (Caddy ตอบ 404)

**ข้อมูลและผู้ใช้**

- [ ] DB สะอาดตาม §5.4 ก่อนสร้าง head (0|0|0|0) และไม่มี seed 1 ปี/ข้อมูล demo
- [ ] head คนแรก + ทีมถูกสร้างใน Admin › Users · allow-list ตาม §5.7 ทดสอบทั้งกรณีผ่านและถูกปฏิเสธ · break-glass ใช้งานได้และเก็บรหัสแล้ว
- [ ] ตรวจ/แก้ calendar วันหยุดและ SLA policy ให้ตรงของจริง (ไฟล์ตัวอย่างเป็น `[VERIFY]`) · ตั้ง org/tier ของลูกค้า pilot
- [ ] ข้อความไทยใน UI: เจ้าของตรวจรวบตอนจบตาม STATUS (ยังไม่ได้ตรวจ — ระบุกับทีม)

**ช่องทางและ AI**

- [ ] Gmail: OAuth Connect สำเร็จ, เมลจากบัญชีภายนอกเข้าเป็น ticket (push หรือ Sync) · ตอบกลับออกจริงผ่าน relay (ลองส่งหาบัญชีทดสอบ ไม่ใช่ลูกค้าจริง)
- [ ] SMTP relay ทำงาน (magic link/CSAT ถึงกล่องทดสอบ ไม่ค้าง Mailpit) หรือบันทึกว่ายังไม่เปิด
- [ ] AI: `GET /v1/ai/status` = `online` · draft/brief ขึ้นบน ticket ทดสอบ · PII ถูก redact ก่อนส่ง (ดู `ai_run.redaction`) · ทีมรู้ว่า AI ตอบลูกค้าเองไม่ได้ (draft รอคนอนุมัติ)
- [ ] ClamAV: `mode=clamav`, EICAR ถูกบล็อก · มีข้อสรุปเรื่อง B-007/T-182
- [ ] LINE/Discord/GCP: ยัง mock → แจ้งทีมแล้ว

**ความปลอดภัยในการปฏิบัติการ**

- [ ] §8: เพดาน AI ตั้งแล้วและอ่านจาก `/v1/ai/budget` ได้ · ทดสอบ kill switch เปิด→ปิดสำเร็จ (มี audit) · `ai_stage_cap_pinned` เปิด
- [ ] §9: ไม่มี intent เกิน stage 2
- [ ] §7: backup แรกทำแล้ว **และ `restore-drill.sh` ได้ PASS** บน backup นั้น · ตั้งเวลา backup รายวัน · มีสำเนา MinIO · รู้ขั้นตอน §7.3
- [ ] ทีมได้รับแจ้ง: ใครเป็น head, ช่องทางแจ้งปัญหา, ที่เก็บรหัส break-glass, เวลาที่ host ต้องออนไลน์ (AI)

## 12. ยังไม่ยืนยัน / ข้อจำกัด

- ทั้ง stack แบบ production ผ่าน compose + proxy บนเครื่อง pilot ยังไม่เคยรันจริง `[ยังไม่ยืนยัน 60%]` · ตัวจบ TLS ยังไม่มีใน repo (§1 ข้อ 2)
- คำสั่ง break-glass ผ่าน `compose run` (§5.6), backup MinIO (§7.1) และรูปแบบ quote ของ §7.3 บน Windows ยังไม่ได้ลองรัน
- ค่า RAM/ดิสก์และความถี่ backup/ซ้อม restore เป็น `[ASSUMED]`
- วันหยุดไทยในไฟล์ตัวอย่างเป็น `[VERIFY]`; อายุเก็บ dump/ข้อมูลเป็นเรื่อง PDPA ที่เจ้าของตัดสิน
