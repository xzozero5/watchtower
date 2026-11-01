# 04 — Architecture (ร่าง T-001)

> สถานะ: ร่างโดย `architect` · อ้างอิง `docs/decisions/ADR-001-stack.md` และ PRD §7, §8, §12
> เอกสารนี้อธิบาย "โครงจริงของโค้ด" ส่วนที่ยังไม่มีโค้ดติดป้ายไว้ และจะปรับตาม T-002 ถึง T-005

## 1. Module map

```
browser / PWA
      |
caddy :8080 (local)
      |-- apps/web :3000 (Next.js) --> packages/ui, packages/shared
      |       |  HTTP + WebSocket
      `-- apps/api :4000 (NestJS)  --> packages/db, packages/ai, packages/channels, packages/shared
              |  BullMQ + pub/sub (Redis)
          apps/worker (BullMQ)     --> packages/db, packages/ai, packages/channels, packages/shared

packages/db --> Postgres + pgvector        object storage: MinIO (local), GCS (GCP)
```

| Workspace | package | หน้าที่ | สถานะ |
|---|---|---|---|
| `apps/web` | `@watchtower/web` | Next.js App Router, three-pane, portal, PWA · คุยกับระบบผ่าน API เท่านั้น | รอ T-003 |
| `apps/api` | `@watchtower/api` | NestJS: REST/OpenAPI, WebSocket gateway, MCP endpoint · module ตาม domain: auth, tickets, channels, alerts, kb, ai, shifts, metrics, admin | รอ T-002 |
| `apps/worker` | `@watchtower/worker` | BullMQ: ingestion, AI runs, schedulers (SLA, CSAT, Gmail watch, metrics, briefs, สร้าง partition) | ยังไม่มี task เฉพาะใน Phase 0 ดู §9 |
| `packages/db` | `@watchtower/db` | Drizzle schema, migration runner, query | placeholder → T-002 |
| `packages/ai` | `@watchtower/ai` | provider abstraction (Vercel AI SDK), agents, tool registry, prompt, PII redaction | placeholder → T-106 |
| `packages/channels` | `@watchtower/channels` | adapter: gmail, line, portal, discord, webhook (`ingest`, `send`, `markRead`, `capabilities` ตาม PRD §4.2) | placeholder → T-007, T-102 |
| `packages/ui` | `@watchtower/ui` | shared component + design tokens | placeholder → T-003 |
| `packages/shared` | `@watchtower/shared` | type และ pure function ที่ทุกฝั่งใช้ ไม่มี I/O เป็น leaf ของกราฟ | มี `CHANNEL_TYPES`, `resolveIntegrationMode` |

Build ของ package: ESM, `tsc` ออกที่ `dist/`, `exports` ชี้ `dist/index.js` · turbo สั่ง `^build` ก่อน `lint`, `typecheck`, `test`, `dev`

## 2. Data flow ของ ticket ใน Phase 0 (portal path)

> `[ASSUMED]` ทั้งหัวข้อเป็นแบบที่เสนอให้ T-005 และ T-007 ยังไม่มีโค้ด · AC-1 ใน PRD เขียนสำหรับ Gmail ส่วน T-009 ใช้ "AC-1 (portal path)" แทนจนกว่าจะถึง Phase 1

1. **Submit:** ลูกค้ากรอกฟอร์มใน `apps/web` → `POST` ไป `apps/api` ผ่าน human-verification (มี mock mode ดู §6)
2. **สร้าง ticket ใน transaction เดียว:** หา org จาก allow-listed domain, หา/สร้าง `contact`, map category → `intent` (Phase 0 ไม่มี AI), คำนวณ `first_response_due_at` และ `resolution_due_at` จาก `sla_policy` กับ `business_calendar`, เขียน `ticket` + `message` + `ticket_event` + `audit_log`
3. **งานหลัง commit:** api enqueue BullMQ job ส่ง confirmation email พร้อม tracking link แบบ signed → worker ส่งผ่าน SMTP ไป Mailpit · api publish event ลง Redis pub/sub → WebSocket gateway กระจายเข้า queue ของ agent
4. **Agent ตอบ:** composer ใน `apps/web` → REST → `message` (public หรือ internal) + `ticket_event` + `audit_log` → job อีเมลแจ้งลูกค้าเฉพาะ public reply
5. **ลูกค้าติดตาม:** tracking page ตรวจ signed link แล้วแสดงเฉพาะ public message · reply จากหน้านี้เข้า timeline เดิม
6. **Resolve:** เปลี่ยน status ตาม workflow R-1.2 → `ticket_event` + `audit_log` → job อีเมลแจ้ง status

> **สถานะจริง (T-007, `[TESTED]`):** ขั้น 1–6 ทำงานตามนี้ ผ่าน `apps/api/src/portal/` — ฟอร์มสาธารณะ `POST /v1/portal/tickets` (PoW จาก `GET /v1/portal/challenge`), tracking ด้วย header `X-Portal-Token` (token อยู่ใน URL fragment ของลิงก์ในอีเมล เก็บเฉพาะ SHA-256 ใน `portal_access_token`), reply จากลูกค้าเข้า `TicketsService.reply` ด้วย sender แบบ `contact`, อีเมลทั้งหมดเขียนลง outbox ใน transaction เดียวกับ reply/status/merge แล้ว worker render TH/EN (`apps/worker/src/processors/portal-email.ts`) · แนบไฟล์ยังไม่รองรับ (รอ T-102) · ลิงก์แยกต่อ org (R-9.1 "per org") ยังไม่ทำ

กติกา flow: งานเข้าคิวผ่าน outbox table (เขียนใน transaction เดียวกับข้อมูล, relay ใน worker ย้ายไป BullMQ — ADR-006) · job ทุกตัวมี idempotency key · ไม่มี AI action ใน Phase 0 จึงยังไม่แตะ N3 และ N4

## 3. Boundary rules

บังคับด้วย lint ใน `tools/eslint/boundaries.mjs` และพิสูจน์ด้วย `tools/eslint/boundaries.test.mjs` (`pnpm test:boundaries`)

| Workspace | import workspace ได้ | ห้ามรู้จัก |
|---|---|---|
| `apps/web` | `ui`, `shared` | DB/Redis client |
| `apps/api` | `db`, `ai`, `channels`, `shared` | — |
| `apps/worker` | `db`, `ai`, `channels`, `shared` | — |
| `packages/shared` | ไม่มี | HTTP, DB/Redis |
| `packages/db` | `shared` | HTTP |
| `packages/ai` | `shared` | HTTP, DB/Redis, global `fetch` กลุ่มเดียวกัน |
| `packages/channels` | `shared` | DB/Redis |
| `packages/ui` | `shared` | DB/Redis |

`[CONFIRMED]` จาก brief ของ T-001: apps ห้าม import กันเอง, `ai` ไม่รู้จัก HTTP/DB, `channels` ไม่รู้จัก DB, packages ห้าม import apps
`[ASSUMED]` ที่เพิ่มเอง: `apps/web` ห้ามใช้ `db`/`ai`/`channels`, `shared` เป็น leaf, `ai` กับ `channels` ไม่ขึ้นต่อกัน, นับ Redis/BullMQ เป็นกลุ่มเดียวกับ DB, ห้าม `fetch` ใน `ai`

กลไก:
- **ชื่อ package:** `@typescript-eslint/no-restricted-imports` คุม `import`, `export from`, `import x = require()` · `no-restricted-syntax` คุม `import()`, `require()`, `import('x').T`
- **path:** rule `watchtower/no-relative-escape` คำนวณ path จริงแล้วรายงานเมื่อออกนอก workspace ของไฟล์ ใช้แทน `import-x/no-restricted-paths` เพราะ rule นั้น resolve ผ่าน symlink ใน `node_modules` แล้วปฏิเสธ dependency ที่อนุญาตด้วย `[TESTED]`
- **กันลืม:** test อ่าน `apps/*` และ `packages/*` จริง ถ้ามี workspace ที่ไม่อยู่ในตาราง `WORKSPACES` หรือประกาศ `@watchtower/*` เกินสิทธิ์ test จะ fail

ข้อจำกัดที่รู้อยู่:
- `import(variable)` ตรวจแบบ static ไม่ได้
- `// eslint-disable` ข้ามกฎได้ ต้องจับตอน review
- ห้ามใช้ tsconfig `paths` ชี้ข้าม workspace เพราะ lint มองเป็นชื่อ package ธรรมดา
- "ไม่รู้จัก HTTP" หมายถึงโค้ดของเรา Vercel AI SDK ยังยิง HTTP ภายในไปหา provider

**Port ที่ต้องฉีดเข้า `packages/ai`** เพราะห้ามรู้จัก DB/HTTP: settings ของ provider/model (อยู่ใน DB ตาม PRD §6.7), ตัวบันทึก `ai_run` (N4), และ read-only investigation tools (N2) · ตัว implement อยู่ใน `apps/api` หรือ `apps/worker`

## 4. Port map

| Service | Host port | ที่มา |
|---|---|---|
| `web` | 3000 (`/health`) | `[CONFIRMED]` + `APP_URL` ใน `.env.example` |
| `api` | 4000 (`/health`, OpenAPI `/docs`) | `[CONFIRMED]` + `API_URL` ใน `.env.example` |
| `caddy` | 8080 (http local) | `[CONFIRMED]` |
| `postgres` | 5432 | `.env.example` |
| `redis` | 6379 | `.env.example` |
| `minio` | 9000 (S3), 9001 (console) | 9000 จาก `.env.example` · 9001 `[ASSUMED]` |
| `mailpit` | 1025 (SMTP), 8025 (UI) | 1025 จาก `.env.example` · 8025 `[ASSUMED]` |
| `pubsub` emulator | 8085 (เริ่ม T-102) | `.env.example` |

`[ASSUMED]` compose bind service ภายในที่ `127.0.0.1` เท่านั้น ให้ T-010 ตรวจ · `[ASSUMED]` caddy ส่ง `/api/*`, `/docs`, WebSocket ไป `api` ที่เหลือไป `web` · ตรวจ health ตรงที่ 3000 และ 4000 เพราะ `/health` ผ่าน caddy จะถึง `web` เท่านั้น

## 5. Env และ config

- **12-factor:** config ของ infra ผ่าน environment เท่านั้น ส่วน credential ของ integration อยู่ใน environment หรือ DB แบบเข้ารหัส ตั้งผ่าน admin UI ได้ และ environment ชนะ (ADR-004, งาน T-116) · `apps/api` และ `apps/worker` validate ด้วย Zod ตอน boot แล้ว fail ทันทีถ้าค่าที่จำเป็นขาด · package ไม่อ่าน `process.env` เอง รับค่าผ่าน parameter
- **รายการตัวแปร:** `.env.example` เป็นแหล่งเดียว · ค่า secret จริงอยู่นอก repo และไม่ลง log
- **Guard ตอน boot (T-010):** `JWT_SECRET`/`APP_ENCRYPTION_KEY` เป็น placeholder หรือสั้นกว่า 32 byte → ล้ม ยกเว้นเมื่อ `APP_URL` เป็น loopback และ `NODE_ENV != production` · `DEV_LOGIN_ENABLED=true` ร่วมกับ Google credential หรือ production → ล้ม (ADR-005)
- **host ใน `.env.example` เป็น `localhost`** (ใช้กับ `pnpm dev` และ integration test บนเครื่อง) ส่วน `docker-compose.yml` สร้าง `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `SMTP_HOST` ด้วยชื่อ service เองเสมอ ค่าเหล่านี้ใน `.env` จึงไม่กระทบ container `[TESTED]` (T-002)
- **CORS:** `apps/api` อนุญาต origin ของ `APP_URL` เพียงตัวเดียว ไม่ใช้ `*` · browser เรียก `API_URL` ตรง ใน compose `web` ได้ `API_URL=http://localhost:4000` `[TESTED]`
- **MinIO:** image ทางการ `minio/minio` ถูกถอนจาก Docker Hub และ Quay (ตรวจ 2026-10-31) compose จึงใช้ fork `pgsty/minio` ปักเวอร์ชัน**และ digest** (`image: repo:tag@sha256:…` ทั้ง `minio` และ `minio-init`; tag ไว้ให้อ่านง่าย, digest คือตัวที่ Docker ใช้จริง — T-010 C-14) override ได้ด้วย `MINIO_IMAGE`/`MINIO_MC_IMAGE` (ถ้า override ให้ปัก digest เองด้วย) ปรับเวอร์ชันต้องแก้ tag กับ digest พร้อมกัน `[ASK-HUMAN]` ตัดสินว่าจะคงตัวนี้หรือเขียน ADR เปลี่ยนเป็น S3-compatible ตัวอื่น
- **Google Workspace domain ของ SSO:** อ่านจาก `GOOGLE_ALLOWED_DOMAIN` ค่าตัวอย่าง `example.com` `[CONFIRMED]`
- **ค่าที่แก้ได้จากหน้า admin** (provider/model ตาม PRD §6.7) เก็บใน DB ค่าใน environment เป็นค่าเริ่มต้นเท่านั้น · `config/models.yaml` และ `config/budgets.yaml` ใช้กับ AI ที่ build โปรเจกต์ โค้ดแอปไม่อ่าน
- **Turbo env mode:** `build`, `test`, `typecheck`, `lint` เป็น strict เพื่อให้ cache ถูก · `dev`, `test:e2e`, `db:*`, `eval` ใช้ `--env-mode=loose` และไม่ cache เพราะต้องเห็นตัวแปรทั้งหมด
- **Build-time public value:** Next.js ฝังค่า `NEXT_PUBLIC_*` ตอน build ซึ่งขัดกับ "image เดียวกัน" ของ ADR-001 จึงควรให้ web อ่าน API URL ตอน runtime `[ASSUMED]`

ผลของ T-002 ต่อ `.env.example` `[TESTED]`: เติม port ของ service และ `S3_REGION`, `GOOGLE_ALLOWED_DOMAIN=example.com`, ย้าย comment ท้ายบรรทัดไปบรรทัดของตัวเอง (test parse ด้วย `util.parseEnv`), `change-me` ถูก Zod ปฏิเสธเมื่อ `NODE_ENV=production` · `PUBSUB_EMULATOR_HOST` ยังไม่มี service จนถึง T-102

## 6. Mock mode ของทุก integration

กติกา: **ค่าว่าง = mock** ตาม `.env.example` · ใช้ `resolveIntegrationMode()` จาก `@watchtower/shared` · ขาดบางตัวถือเป็น mock ไม่ใช่ live (fail safe) · ทุก integration มี interface เดียว และ mock ไม่ยิง network ออกนอกเครื่อง · การต่อของจริงครั้งแรกเป็น `[ASK-HUMAN]`

| Integration | ตัวแปรที่ตัดสิน | พฤติกรรม local | เริ่มใน |
|---|---|---|---|
| Google OIDC | `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET` | `POST /v1/auth/dev-login` (ต้องตั้ง `DEV_LOGIN_ENABLED=true` เอง, นอก production, เฉพาะบัญชีที่ dev login สร้าง) + break-glass · production boot ล้มถ้า credential ไม่ครบ `[TESTED]` | T-004 |
| Email ขาออก | `SMTP_HOST`, `SMTP_PORT` | ส่ง SMTP จริงเข้า Mailpit ไม่ออกอินเทอร์เน็ต | T-007 |
| Human verification | `PORTAL_POW_DIFFICULTY_BITS`, `PORTAL_MIN_FILL_SECONDS` | self-hosted proof-of-work + honeypot + rate limit (ADR-007) ไม่มีปลายทางภายนอกจึงไม่มี mock ที่ผ่านเสมอ · test ใช้ difficulty 8 bits / fill 0 s · provider ภายนอก (Turnstile/hCaptcha) = `[ASK-HUMAN]` | T-007 |
| Object storage | `S3_*` | MinIO ผ่าน S3 interface เดียวกับ GCS | T-002 |
| Gmail | `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`, `GMAIL_OAUTH_MAILBOX` (OAuth, ค่าเริ่มต้น) หรือ `GMAIL_SERVICE_ACCOUNT_JSON_PATH`, `GMAIL_IMPERSONATE_USER` (delegation, ทางเลือก) | recorded fixtures + Pub/Sub emulator | T-102 |
| LINE | `LINE_CHANNEL_ID` และ credential ของ channel | webhook จำลอง, บันทึกการส่งแทนการยิงจริง | T-103 |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_ALERT_CHANNEL_ID` | บันทึกข้อความลง log | T-104 |
| Web Push | `WEB_PUSH_VAPID_PUBLIC`, `WEB_PUSH_VAPID_PRIVATE` | แจ้งเตือนใน app อย่างเดียว | T-105 |
| AI provider | `AI_PROVIDER=mock` | คำตอบ deterministic ไม่ใช้ key | T-106 |
| GCP Logs, BigQuery, Monitoring | `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | read-only stub (N2) | T-108, T-201 |
| GitHub App | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | read-only stub | T-108 |

## 7. ข้อสังเกต schema (PRD §7) สำหรับ T-004 และ T-005

`[ASSUMED]` ทั้งหมดเป็นข้อเสนอ · `[VERIFY]` drizzle-kit ยังประกาศ `PARTITION BY` ใน schema ไม่ได้ ต้องเขียนเป็น SQL migration เอง ให้ T-002 ตรวจกับรุ่นที่ใช้

- **Partition รายเดือน:** ใช้กับตาราง append-only ที่ค้นตามเวลา: `audit_log`, `ticket_event`, `incident_timeline`, `ai_run`, `tool_execution`, `usage_metric_point` · Phase 0 ทำแค่ `audit_log` และ `ticket_event`
- **ห้าม partition `message`:** unique index ของ partitioned table ต้องมี partition key จึงกัน `(channel_account_id, external_id)` ซ้ำข้ามเดือนไม่ได้ ซึ่งเป็น idempotency ของ ingestion ตาม PRD §8.3
- **ผลของ partition ต่อ FK:** primary key ต้องเป็น `(id, created_at)` · `ai_draft.ai_run_id` จึงอ้าง `ai_run` ตรง ๆ ไม่ได้ ต้องเก็บ `ai_run_created_at` คู่กันหรือไม่ partition `ai_run` ตัดสินตอน T-106
- **สร้าง partition ล่วงหน้า:** ใช้ scheduler ใน worker เพราะ ADR-001 ห้ามพึ่ง cron ของ OS และต้องมี default partition กันข้อมูลตก
- **Audit (PRD §8.2):** immutable ด้วย trigger ที่ปฏิเสธ `UPDATE`/`DELETE` และ role ของแอปไม่มีสิทธิ์สองคำสั่งนี้ · PRD กำหนดให้ audit การอ่าน PII ด้วย ตารางจึงต้องมี action สำหรับ read · retention ≥ 1 ปี ใช้วิธี detach partition
- **Index ของ queue:** `ticket(status, queue_id, priority, first_response_due_at)`, `ticket(org_id, status)`, `ticket(assignee_id, status)`, partial index สำหรับ ticket ที่ยังเปิด · `ticket.number` unique · `message(ticket_id, created_at)` · `ticket_event(ticket_id, created_at)`
- **RBAC ระดับ org:** ทุก query ของ client ต้องกรอง `org_id` เป็นจุดที่ T-009 ทดสอบ
- **Full-text search ภาษาไทย (R-1.8):** parser `simple` ของ Postgres ตัดคำไทยไม่ได้ → T-005 ใช้ `ILIKE` + GIN `pg_trgm` ทดสอบกับข้อความไทยแล้ว `[TESTED]` ดู §11
- **`user` เป็นคำสงวนของ Postgres:** ตั้งชื่อตาราง `users` หรือ quote ทุกครั้ง
- **Array ใน PRD** เช่น `organization.domains[]`, `contact.emails[]` ต้องมี GIN index ถ้าใช้ match อีเมลขาเข้า

## 8. ความพร้อมย้ายไป GCP

| กฎ ADR-001 | สถานะตอน T-001 |
|---|---|
| config ผ่าน env เท่านั้น | กำหนดใน §5 รอ T-002 implement |
| ไม่มี local filesystem state | `GMAIL_SERVICE_ACCOUNT_JSON_PATH`, `GITHUB_APP_PRIVATE_KEY_PATH` เป็น path ไฟล์ Cloud Run mount จาก Secret Manager ได้ `[VERIFY]` |
| storage ผ่าน interface เดียว | S3 interface · GCS ผ่าน S3 interop `[VERIFY]` |
| scheduler อยู่ใน worker | กำหนดใน §7 |
| health endpoint ทุก service | web และ api รอ T-002, T-003 · worker ยังไม่มี HTTP server แต่ Cloud Run ต้องการ port ที่ตอบได้ `[VERIFY]` |
| image เดียวกันทั้ง compose และ Cloud Run | `.dockerignore` พร้อม รอ Dockerfile ใน T-002 |

## 9. เรื่องที่ยังเปิดและ `[ASSUMED]`

- `[ASSUMED]` **logic ที่ทั้ง api และ worker ใช้** (เช่น สร้าง ticket จาก inbound) ห้าม import ข้าม app จึงต้องอยู่ใน package · หลัง T-005 การสร้าง ticket อยู่ใน `apps/api` (ดู §11) T-102 ต้องเขียน ADR ว่า ingestion อยู่ api หรือแยก package · ข้อเสนอเดิม: pure logic เช่นคำนวณ SLA อยู่ `shared`, งาน transaction อยู่ `db` ใน Phase 0 ถ้าโตเกินค่อยแยก `packages/domain` ด้วย ADR ใหม่
- `[ASSUMED]` **`apps/worker` ไม่มีเจ้าของใน BACKLOG Phase 0:** T-002 สร้างใน compose แต่ scope เขียนแค่ `apps/api` ให้ T-002 สร้างโครง worker ด้วย เพราะ T-007 ต้องส่งอีเมลผ่าน queue
- `[ASSUMED]` **ที่อยู่ของ client read-only ของ GCP, BigQuery, GitHub:** `packages/ai` เก็บแค่ interface ส่วน implement อยู่ app หรือ package ใหม่ ตัดสินตอน T-108
- `[ASSUMED]` **eval runner:** PRD §12 ให้อยู่ใน `packages/ai` แต่ `CLAUDE.md` วาง `evals/runner` ซึ่งไม่อยู่ใน workspace glob · ตอนนี้ `pnpm eval` ชี้ `packages/ai` ตัดสินตอน T-302
- `[ASSUMED]` Node 22 ตาม brief, TypeScript 6.0 เพราะ `typescript-eslint` 8.72 ประกาศ peer `<6.1.0` จึงยังใช้ TypeScript 7 ไม่ได้

## 10. Auth, session, RBAC, audit (T-004) `[TESTED]` ยกเว้นที่ระบุ

เหตุผลและทางเลือกอยู่ใน `docs/decisions/ADR-005-auth-session-audit.md` · ที่นี่คือแผนที่โค้ดและกติกาที่ task ถัดไปต้องรู้

| เรื่อง | ที่อยู่ในโค้ด |
|---|---|
| Contract HTTP (Zod schema ใช้ร่วม api/web), roles, permission strings, defaults | `packages/shared/src/auth.ts`, `rbac.ts` |
| ตาราง `users`, `permissions`, `role_permissions`, `sessions`, `refresh_tokens`, `magic_link_tokens`, `audit_log` | migration `packages/db/migrations/0001_auth_rbac_audit.sql` (+ `.down.sql`), Drizzle mirror ใน `packages/db/src/schema/` |
| Guard global, decorator `@Public` `@RequirePermission` `@RequireAnyPermission` `@CurrentPrincipal`, `Principal`, org scope | `apps/api/src/auth/` |
| Audit: `AuditInterceptor` (global), `AuditScope`, `AuditService`, redaction | `apps/api/src/audit/` |
| Email ผ่านคิว: producer `EmailOutbox` → worker `processors/email.ts` → SMTP | `apps/api/src/queue/`, `apps/worker/src/` |
| Partition รายเดือนของ audit log | SQL `ensure_monthly_partitions` + job `maintenance:ensure-partitions` ใน worker |

กติกา:
- **route ใหม่ทุกตัวต้องมี `@RequirePermission(...)`/`@RequireAnyPermission(...)` หรือ `@Public()`** ไม่งั้น 403 `route_not_configured` และ `routes-policy.test.ts` fail · เพิ่ม route สาธารณะต้องแก้ allow-list ใน test นั้นโดยตั้งใจ · permission string ใหม่ต้องเพิ่มใน `PERMISSIONS`/`DEFAULT_ROLE_PERMISSIONS` **และ** migration ใหม่ที่ `INSERT` ลง `permissions`/`role_permissions` (test เทียบ seed กับค่าใน shared)
- **Secret ใน job:** อีเมลที่พก link ต้องส่งผ่าน `EmailOutbox.send(job, jobId, tx, ttlSeconds)` ซึ่งเข้ารหัส `link`/`trackingUrl` (AES-256-GCM, subkey ของ `APP_ENCRYPTION_KEY`) และตั้ง `expires_at` · worker เปิดก่อนส่ง SMTP · test อ่าน link ผ่าน `harness.openEmail(job)` (ADR-006)
- **Audit:** ทุก POST/PUT/PATCH/DELETE ถูกบันทึกอัตโนมัติ · ตั้งชื่อ action ด้วย `@Audited({ action, targetType })` และเติม `AuditScope.set({ targetId, before, after })` ใน service · GET ที่คืน PII ติด `@AuditPiiRead('contact')` · ต้อง commit พร้อมกัน → `audit.recordInTransaction(tx, entry)` · ห้ามใส่ secret เอง (redaction เป็นด่านสุดท้าย ไม่ใช่ข้ออ้าง)
- **Org scope:** ทุก query ของตารางที่ client เห็นต้องมี `orgScopeCondition(table.orgId, principal.orgScope)` และโหลดแบบ by-id แล้วเรียก `assertOrgAccess(principal, row.orgId)` (404)
- **ตารางใหม่:** ได้สิทธิ์ SELECT/INSERT/UPDATE/DELETE ให้ `watchtower_app` อัตโนมัติ · ตาราง append-only (เช่น `ticket_event`) ให้ใช้ trigger `reject_mutation()`, `REVOKE UPDATE, DELETE, TRUNCATE`, และ `ensure_monthly_partitions('<table>', n, true)`
- **Integration test:** ใช้ `createTestDatabase()` จาก `@watchtower/db/testing` (database ใหม่ + migrate + login role แบบจำกัดต่อ test file) และ `apps/api/src/testing/harness.ts` (`startHarness`, `TestClient` ที่มี cookie jar/CSRF/Origin/IP)
- **Cookie และ header (T-010):** ชื่อ cookie มาจาก `cookieNames(config)` (`__Host-` เมื่อ Secure) ห้ามอ่าน `wt_at`/`wt_rt` ตรง ๆ · อ่านผ่าน `readCookie` เสมอ (cookie ซ้ำ = ไม่มี) · header ความปลอดภัยของ api อยู่ใน `http/security-headers.middleware.ts`
- **ยังไม่ทำ:** purge session/token ที่หมดอายุ · LINE Login (Phase 1) · UI login (T-006)

## 11. Ticketing core (T-005) `[TESTED]` ยกเว้นที่ระบุ
| เรื่อง | ที่อยู่ในโค้ด |
|---|---|
| Contract + pure logic: workflow, key `OPS-n`, SLA business time, realtime filter | `packages/shared/src/{ticketing,sla,realtime,directory,common}.ts` |
| ตาราง calendar, SLA, queue(+member), org, contact, channel_account, intent, transition, ticket, message, `ticket_event` | `packages/db/migrations/0002_ticketing.sql` (+down), `packages/db/src/schema/ticketing.ts`, seed `packages/db/src/seed/intents.ts` |
| API modules | `apps/api/src/{tickets,sla,team-queues,orgs,intents,realtime}/` |

กติกา:
- **เขียน ticket ผ่าน `UnitOfWorkService.run()` เท่านั้น:** ticket + message + `ticket_event` + `audit.recordInTransaction` อยู่ใน tx เดียว · `uow.emit` (realtime) และ `uow.afterCommit` รันหลัง commit ถ้า fail จะลง log โดยไม่ rollback · **งานเข้าคิวห้ามใช้ `afterCommit`** ให้เขียน `OutboxService.enqueue(job, uow.tx)` ใน transaction (ADR-006, `[TESTED]` Redis ล่ม → แถวค้าง `pending` → ส่งทีหลัง) · ตัวอักษรนำหน้าเลข ticket มาจาก `TICKET_KEY_PREFIX` (ค่าเริ่มต้น `OPS`) ผ่าน `TicketKeys` · tier ของ org เป็นข้อมูลในตาราง `org_tier` (migration 0003) · ลบ queue/contact ที่ ticket/message ยังอ้างอยู่ = 409
- **Concurrency:** ticket `FOR UPDATE` (merge ล็อกตามลำดับ id) · round-robin ล็อกแถว `team_queue` (ดูคิวก่อน แล้วค่อยใช้สิทธิ์เมื่อ ticket ย้ายจริง) · idempotency ของ inbound = advisory lock + unique `message_external_key`
- **Workflow (R-1.2):** เก็บเป็นข้อมูลใน `ticket_status_transition` (`workflow.manage`) · เข้า `merged` ได้ทาง merge เท่านั้น · chain ลึกไม่เกิน 1 ชั้น มี trigger กัน loop
- **SLA:** due date คำนวณจาก `createdAt` + pause ที่จบแล้ว (อ่านจาก event `sla.resumed`) · pause ที่ยังไม่จบเก็บใน `ticket.sla_paused_at` · เปลี่ยน calendar/holiday ไม่คำนวณ ticket ที่เปิดอยู่ใหม่ (ลูกค้าได้ due date ที่สัญญาไว้แล้ว) `[ASSUMED]`
- **`ticket_event` เป็นทั้ง log และ state:** SLA คำนวณ pause จาก `sla.resumed` จึงห้าม detach partition ที่ยังมี ticket เปิด (นโยบายต่างจาก `audit_log`) · partition สร้างโดย `maintenance:ensure-partitions` (`PARTITIONED_TABLES`)
- **Delivery status:** ข้อความขาเข้า = `not_applicable` · reply บน portal = `delivered` · channel อื่น = `pending` จนกว่า outbox ของ adapter จะส่ง
- **Realtime:** `/v1/realtime` ใช้ `ws` บน HTTP server ของ Nest เพราะต้องตรวจ Origin + cookie + session ตอน upgrade · fan-out ผ่าน Redis `REALTIME_CHANNEL` · event มีแค่ id และ field สั้น ๆ ไม่มีเนื้อความ · client ได้เฉพาะ org ตัวเองและไม่ได้ internal (`realtimeEventFor`) · หลุดแล้ว refetch REST · Cloud Run ตัด WS ตาม request timeout `[VERIFY]` ซึ่ง client ต้อง reconnect ทุก 15 นาทีอยู่แล้ว (4401)
- **Search (R-1.8):** `ILIKE` + GIN `pg_trgm` บน `ticket.subject`, `message.body_text` (ทดสอบภาษาไทยแล้ว) · ต้องใช้ DB locale UTF-8 ที่ไม่ใช่ `C` `[ASSUMED]` · `q` ขั้นต่ำ 2 ตัว (คำไทยสั้นมี 2 ตัวบ่อย) แต่สั้นกว่า 3 ตัวไม่มี trigram จึงใช้ index ไม่ได้ ควรใช้คู่กับ filter อื่น · ยังไม่ค้น attachment (T-102)
- **Duplicate suggestion (R-1.5):** `GET /v1/tickets/:id/duplicates` org + intent เดียวกัน ภายใน 72 ชม. ไม่ merged/closed สูงสุด 10
- **ข้อเบี่ยงจาก PRD §7:**
  - `team_queue.members[]` → `team_queue_member`
  - `ticket_event.actor` → `actor_type`/`actor_id`/`visibility`
  - เพิ่ม `ticket.channel`, `ticket.sla_paused_at`, `organization.status`, `sla_policy.business_calendar_id`
  - linked tickets มีแค่ `parent_ticket_id`
  - `incident_id`/`runbook_article_id`/`procedure_version_id` ยังไม่มี FK
