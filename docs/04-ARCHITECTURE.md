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

กติกา flow: enqueue หลัง commit เท่านั้น (พิจารณา outbox table ถ้าต้องการ at-least-once จริงตาม PRD §8.3) · job ทุกตัวมี idempotency key · ไม่มี AI action ใน Phase 0 จึงยังไม่แตะ N3 และ N4

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

- **12-factor:** config ผ่าน environment เท่านั้น · `apps/api` และ `apps/worker` validate ด้วย Zod ตอน boot แล้ว fail ทันทีถ้าค่าที่จำเป็นขาด · package ไม่อ่าน `process.env` เอง รับค่าผ่าน parameter
- **รายการตัวแปร:** `.env.example` เป็นแหล่งเดียว · ค่า secret จริงอยู่นอก repo และไม่ลง log
- **host ใน `.env.example` เป็นชื่อ service ของ compose** (`postgres`, `redis`, `minio`, `mailpit`, `pubsub`) ถ้ารัน `pnpm dev` นอก container ต้อง override เป็น `localhost`
- **Google Workspace domain ของ SSO:** อ่านจาก `GOOGLE_ALLOWED_DOMAIN` ค่าตัวอย่าง `example.com` `[CONFIRMED]`
- **ค่าที่แก้ได้จากหน้า admin** (provider/model ตาม PRD §6.7) เก็บใน DB ค่าใน environment เป็นค่าเริ่มต้นเท่านั้น · `config/models.yaml` และ `config/budgets.yaml` ใช้กับ AI ที่ build โปรเจกต์ โค้ดแอปไม่อ่าน
- **Turbo env mode:** `build`, `test`, `typecheck`, `lint` เป็น strict เพื่อให้ cache ถูก · `dev`, `test:e2e`, `db:*`, `eval` ใช้ `--env-mode=loose` และไม่ cache เพราะต้องเห็นตัวแปรทั้งหมด
- **Build-time public value:** Next.js ฝังค่า `NEXT_PUBLIC_*` ตอน build ซึ่งขัดกับ "image เดียวกัน" ของ ADR-001 จึงควรให้ web อ่าน API URL ตอน runtime `[ASSUMED]`

จุดที่ T-002 ต้องดูใน `.env.example`:
- ยังไม่มีตัวแปร port ของ service และ `S3_REGION`
- `GOOGLE_ALLOWED_DOMAIN` ยังว่าง
- บางบรรทัดมี comment ต่อท้ายค่า ต้องทดสอบว่า parser ที่ใช้ตัด comment ถูก
- ค่าตัวอย่าง `change-me` ควรถูก Zod ปฏิเสธเมื่อ `NODE_ENV=production`
- `PUBSUB_EMULATOR_HOST` มีค่าแล้วแต่ยังไม่มี service นี้ใน Phase 0

## 6. Mock mode ของทุก integration

กติกา: **ค่าว่าง = mock** ตาม `.env.example` · ใช้ `resolveIntegrationMode()` จาก `@watchtower/shared` · ขาดบางตัวถือเป็น mock ไม่ใช่ live (fail safe) · ทุก integration มี interface เดียว และ mock ไม่ยิง network ออกนอกเครื่อง · การต่อของจริงครั้งแรกเป็น `[ASK-HUMAN]`

| Integration | ตัวแปรที่ตัดสิน | พฤติกรรม local | เริ่มใน |
|---|---|---|---|
| Google OIDC | `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET` | local admin แบบ break-glass และ dev login `[ASSUMED]` | T-004 |
| Email ขาออก | `SMTP_HOST`, `SMTP_PORT` | ส่ง SMTP จริงเข้า Mailpit ไม่ออกอินเทอร์เน็ต | T-007 |
| Human verification | ยังไม่มีตัวแปร | ผ่านเสมอใน mock และห้ามเปิดใน production `[ASSUMED]` | T-007 |
| Object storage | `S3_*` | MinIO ผ่าน S3 interface เดียวกับ GCS | T-002 |
| Gmail | `GMAIL_SERVICE_ACCOUNT_JSON_PATH`, `GMAIL_IMPERSONATE_USER` | recorded fixtures + Pub/Sub emulator | T-102 |
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
- **Full-text search ภาษาไทย (R-1.8):** parser `simple` ของ Postgres ตัดคำไทยไม่ได้ เสนอ `pg_trgm` ใน T-005 ต้องทดสอบกับข้อความไทยจริง
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

- `[ASSUMED]` **logic ที่ทั้ง api และ worker ใช้** (เช่น สร้าง ticket จาก inbound) ห้าม import ข้าม app จึงต้องอยู่ใน package เสนอ: pure logic เช่นคำนวณ SLA อยู่ `shared`, งาน transaction อยู่ `db` ใน Phase 0 ถ้าโตเกินค่อยแยก `packages/domain` ด้วย ADR ใหม่
- `[ASSUMED]` **`apps/worker` ไม่มีเจ้าของใน BACKLOG Phase 0:** T-002 สร้างใน compose แต่ scope เขียนแค่ `apps/api` ให้ T-002 สร้างโครง worker ด้วย เพราะ T-007 ต้องส่งอีเมลผ่าน queue
- `[ASSUMED]` **ที่อยู่ของ client read-only ของ GCP, BigQuery, GitHub:** `packages/ai` เก็บแค่ interface ส่วน implement อยู่ app หรือ package ใหม่ ตัดสินตอน T-108
- `[ASSUMED]` **eval runner:** PRD §12 ให้อยู่ใน `packages/ai` แต่ `CLAUDE.md` วาง `evals/runner` ซึ่งไม่อยู่ใน workspace glob · ตอนนี้ `pnpm eval` ชี้ `packages/ai` ตัดสินตอน T-302
- `[ASSUMED]` Node 22 ตาม brief, TypeScript 6.0 เพราะ `typescript-eslint` 8.72 ประกาศ peer `<6.1.0` จึงยังใช้ TypeScript 7 ไม่ได้
