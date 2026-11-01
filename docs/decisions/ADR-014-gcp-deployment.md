# ADR-014 — Deploy บน GCP: Cloud Run + Cloud SQL + Memorystore + GCS (T-118)

- **Status:** Proposed (รอเจ้าของยืนยัน: region, โดเมน, งบ, การเปิด project จริง — ทุกข้อเป็น `[ASK-HUMAN]` ก่อนมี resource ใด ๆ ถูกสร้าง)
- **Date:** 2026-11-02 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของ (ผู้เขียน: `backend-dev` ตาม T-118; ผู้ตรวจ: `architect` + `security-reviewer` ตาม N7)
- **Context:** ADR-001 ระบุว่า production = GCP แบบ `[ASSUMED — เขียน ADR ตอนทำจริง]` งานนี้ทำให้เป็นการตัดสินใจจริงก่อน T-115 (Phase 1 exit) โดย **ไม่สร้าง resource และไม่เรียก cloud ใด ๆ** (`infra/terraform/` เป็น skeleton ที่ไม่เคย `init`/`apply`) ข้อจำกัดที่ขับการตัดสินใจ:
  1. Gmail ส่ง push ผ่าน **Pub/Sub push subscription** และ LINE ส่ง **webhook** → api ต้องมี public HTTPS URL ที่เสถียร (PRD §11, ADR-009)
  2. SMTP relay ขาออกของเจ้าของ allow-list ด้วย **IP ต้นทาง** (T-130: `SMTP_RELAY_HOST`) → worker ต้องออกอินเทอร์เน็ตด้วย IP คงที่
  3. cookie access = `SameSite=Lax`, refresh = `SameSite=Strict`, และชื่อมี `__Host-` (`apps/api/src/auth/cookies.ts`) + CORS อนุญาต origin เดียว (`APP_URL`) → **web และ api ต้องอยู่ใน site เดียวกัน** (registrable domain เดียวกัน) ใช้ `*.run.app` สองชื่อไม่ได้ เพราะ `run.app` อยู่ใน Public Suffix List `[VERIFY]` ทำให้เป็นคนละ site
  4. redirect URI ถูกสร้างด้วย `new URL('/v1/auth/google/callback', API_URL)` (`google-oidc.service.ts`) และ `lineWebhookPath()` เป็น path เต็มที่ขึ้นต้น `/` → ถ้า `API_URL` มี path prefix (เช่น `/api`) prefix จะ**หาย** ดังนั้นห้ามใช้ path routing แบบ Caddy (`/api/*` ตัด prefix) บน GCP ต้องใช้ **hostname แยกสำหรับ api**
  5. image ต้องเป็นตัวเดียวกับ compose (ADR-001 กฎ 12-factor); api/worker รับ `$PORT` ได้แล้ว (`apps/*/src/config*.ts`) `[TESTED]` (worker: `config.test.ts` "lets PORT (Cloud Run) win over WORKER_PORT")

## Decision

### 1. Compute = Cloud Run (ยืนยันข้อเสนอเดิมของ ADR-001) พร้อมรายละเอียด

| Service | ingress | scaling | หมายเหตุ |
|---|---|---|---|
| `web` | `internal-and-cloud-load-balancing` | min 0, max 3 | `PORT=3000`, probe `GET /health` |
| `api` | `internal-and-cloud-load-balancing` | min 0 (staging) / **1 (production)**, max 3 | probe `GET /health/ready`; request timeout 3600 s สำหรับ WebSocket `/v1/realtime` (client reconnect ทุก ≤ 15 นาทีอยู่แล้ว, 04-ARCH §realtime) |
| `worker` | `internal` (ไม่มีใครเรียกจากภายนอก) | **min 1 = max 1 ที่ staging**, ≥ 1 ที่ production, **instance-based billing (CPU always allocated)** | ต้อง always-on เพราะ BullMQ consumer + scheduler + outbox relay poll 1 s (ไม่มี request มากระตุ้น) · probe `GET /health/ready` บน `$PORT` (ทำแล้ว) |
| `migrate` | — | Cloud Run **Job** | รัน `node node_modules/@watchtower/db/dist/cli.js up` ด้วยสิทธิ์ schema owner ก่อน deploy revision ใหม่ (เทียบเท่า service `migrate` ใน compose) |

- ingress ของ web/api ปิดการเข้าตรงที่ `*.run.app`: ทุก request ผ่าน **external Application Load Balancer** (serverless NEG) → ใช้ Cloud Armor, managed TLS, และ Pub/Sub/LINE เรียกผ่านชื่อ custom domain ได้
- **worker รัน 2 instance ซ้อนกันได้ชั่วคราว** (rolling revision): outbox relay ใช้ `FOR UPDATE SKIP LOCKED` (`packages/db/src/outbox.ts`), BullMQ lock ต่อ job, schedule เป็น `upsertJobScheduler` (idempotent) `[ASSUMED จากการอ่านโค้ด — ยังไม่ได้ทดสอบ 2 instance พร้อมกัน; ใส่ในรายการตรวจ staging]`
- Cloud Run ส่ง SIGTERM แล้วให้เวลาปิดสั้น (ค่าเริ่มต้น 10 s `[VERIFY]`) → job ที่ค้างจะถูก BullMQ ดึงกลับ (stalled) และรันซ้ำ: ปลอดภัยเพราะ job มี idempotency key (ADR-006) และการส่งถึงลูกค้าเป็น at-most-once (ADR-010)

### 2. Network และ egress IP คงที่ (สำหรับ SMTP relay)

- VPC เดียว + subnet ใน region เดียวกับ Cloud Run; Cloud Run ต่อ VPC ด้วย **Direct VPC egress** (ไม่ใช้ Serverless VPC Access connector เพื่อลดชิ้นส่วนและค่าใช้จ่าย `[VERIFY ว่า GA แล้วใน region ที่เลือก]`)
- **Cloud Router + Cloud NAT + static external IP (1 ที่อยู่, `MANUAL_ONLY`)** = IP ขาออกคงที่ → เจ้าของเอา IP นี้ไปขอ allow-list ที่ SMTP relay (output `egress_ip` ของ Terraform)
- `worker` ตั้ง `egress = ALL_TRAFFIC` (ส่ง SMTP, เรียก LINE/Discord/Anthropic ผ่าน IP คงที่); `api` และ `web` ตั้ง `PRIVATE_RANGES_ONLY` (ต้องการแค่ Cloud SQL/Redis ใน VPC) — NAT จึงรับ traffic เฉพาะ worker
- subnet เปิด Private Google Access ไว้เพื่อให้ Google APIs ไม่ต้องผ่าน NAT เมื่อเป็นไปได้
- `SMTP_RELAY_PORT` = 465 (implicit TLS) หรือ 587 (STARTTLS) ตามที่ relay กำหนด · **พอร์ต 25 ขาออกจาก GCE/VM ถูกบล็อกเป็นค่าเริ่มต้น `[VERIFY]` จึงห้ามพึ่งพอร์ต 25** · `NODE_ENV=production` บังคับ TLS + `SMTP_USER`/`SMTP_PASSWORD` (`mailer.ts`) · ถ้า relay ของเจ้าของยืนยันตัวตนด้วย IP อย่างเดียวไม่มี credential ต้องตั้ง `SMTP_ALLOW_INSECURE=true` ซึ่งปิด `requireTLS` ด้วย → เป็นการยอมรับความเสี่ยงที่ต้องบันทึกและให้เจ้าของ/`security-reviewer` เห็นชอบก่อน `[ASK-HUMAN]` (ทางที่ควรกว่า: ขอ credential + TLS จากเจ้าของ relay)

### 3. ข้อมูลและ state

| ชั้น | บริการ | การตั้งค่าที่ตัดสินใจ |
|---|---|---|
| Postgres 16 + pgvector | **Cloud SQL for PostgreSQL**, **private IP เท่านั้น** (private services access), ไม่มี public IP | `ZONAL` ที่ staging / `REGIONAL` (HA) ที่ production · backup อัตโนมัติ + PITR · `deletion_protection=true` · `ssl_mode=ENCRYPTED_ONLY` และให้ `DATABASE_URL` ใส่ `?sslmode=require` `[VERIFY]` เวอร์ชัน `pg` ที่ใช้อาจตีความ `require` เป็น `verify-full` ซึ่งไม่ผ่านเพราะ certificate ของ Cloud SQL ไม่ตรงกับ IP — ทดสอบ `uselibpqcompat=true` ใน staging (runbook §5) · `CREATE EXTENSION vector` ทำโดย migration 0000 ด้วย schema owner ซึ่งต้องมีสิทธิ์พอ `[VERIFY ว่า Cloud SQL อนุญาต extension นี้ให้ user ที่สร้างเอง ไม่ใช่เฉพาะ postgres]` |
| Redis | **Memorystore for Redis** (non-cluster, `STANDARD_HA` ที่ production, `BASIC` ที่ staging) | `maxmemory-policy=noeviction` (BullMQ ห้ามถูก evict key), `auth_enabled=true`, `transit_encryption_mode=DISABLED` ที่ staging เพราะ `REDIS_URL` เป็น `redis://` และยังไม่มีการตั้ง CA ของ server (ดู Consequences) · เข้าถึงได้ใน VPC เท่านั้น |
| Object storage | **GCS** bucket เดียวต่อ environment ผ่าน **S3 interoperability (HMAC key)** | `S3_ENDPOINT=https://storage.googleapis.com`, `uniform_bucket_level_access`, `public_access_prevention=enforced`, ไม่เปิด versioning ที่ staging · `createS3ObjectStore` เป็น SigV4 แบบ path-style เขียนเอง (`apps/worker/src/ingest/object-store.ts`) ซึ่งตรงกับ interop `[VERIFY ด้วย smoke test จริง: ค่า region ที่ GCS ยอมรับ (ลอง `auto` ก่อน `us-east-1`), header `x-amz-content-sha256`]` |
| Secrets | **Secret Manager** | Terraform สร้างเฉพาะ "ภาชนะ" ของ secret + IAM · **ค่า secret ห้ามผ่าน Terraform/state** (ใส่ด้วย `gcloud secrets versions add` จาก stdin ตามรันบุ๊ก) · Cloud Run อ่านเป็น env หรือ mount เป็นไฟล์ (`GMAIL_SERVICE_ACCOUNT_JSON_PATH`) |

- **รหัสผ่าน DB ไม่อยู่ใน Terraform state**: รันบุ๊กสร้าง schema owner (`gcloud sql users create` ด้วยรหัสสุ่ม) แล้วเก็บ `MIGRATION_DATABASE_URL`, `DATABASE_URL` (role `watchtower_api` ที่ `migrate` สร้างให้), `APP_DB_PASSWORD` ลง Secret Manager โดยตรง
- **HMAC key ของ GCS ก็สร้างด้วย `gcloud` ในรันบุ๊ก ไม่ใช้ `google_storage_hmac_key`** (secret จะเข้า state) · เป็น long-lived credential จึงหมุนตามตารางใน `docs/09-SECURITY.md` และเป็นเหตุผลให้มี follow-up adapter แบบ ADC (ดู Consequences)
- `APP_ENCRYPTION_KEY` / `JWT_SECRET` / `PORTAL_TOKEN_SECRET` สร้างด้วยตัวสุ่มระดับ crypto ในรันบุ๊ก ห้าม reuse ข้าม environment

### 4. Public HTTPS และ URL ที่เจ้าของต้องใช้ (คู่มือ credential อ้างอิงตารางนี้)

โดเมนตัวอย่าง `example.com` (เจ้าของแทนด้วยโดเมนจริงของ instance ตัวเอง **ใน tfvars/Secret Manager ไม่ใส่ใน repo**). Staging ตัวอย่าง: `APP_URL=https://app.staging.example.com`, `API_URL=https://api.staging.example.com` (ทั้งคู่อยู่ใต้ `staging.example.com` = site เดียวกัน)

| ใช้กับ | URL (แทนที่ `API_URL` / `APP_URL`) | ตั้งที่ไหน | ที่มา |
|---|---|---|---|
| Google OIDC (staff login) — **Authorized redirect URI** | `${API_URL}/v1/auth/google/callback` | Google Cloud Console → OAuth client (Web application) | `google-oidc.service.ts#redirectUri` |
| Google OIDC — Authorized JavaScript origins | ไม่ต้องใส่ (code flow ฝั่ง server) `[ASSUMED]` | — | — |
| LINE Login — **Callback URL** | `${API_URL}/v1/line/login/callback` | LINE Developers → LINE Login channel | `line-identity.service.ts#redirectUri` |
| LINE Messaging API — **Webhook URL** | `${API_URL}/v1/inbound/line/{channelAccountId}` | LINE Developers → Messaging API channel | `lineWebhookPath()` · `{channelAccountId}` เป็น UUID ที่เกิดหลัง `POST /v1/admin/channel-accounts` (หรือ `channel-accounts` CLI) ซึ่งตอบ `webhookUrl` ที่สมบูรณ์ให้คัดลอก — **จึงรู้ URL ได้หลังรอบแรกของ deploy เท่านั้น** |
| Gmail Pub/Sub — **push endpoint** ของ subscription | `${API_URL}/v1/inbound/gmail/push` | Pub/Sub subscription (Terraform `pubsub.tf` หรือ console) | `gmail-push.controller.ts` |
| Gmail push — **OIDC audience** (`GMAIL_PUSH_AUDIENCE`) | ค่าเดียวกับ push endpoint ข้างบน (ตั้ง `audience` ของ subscription ให้ตรง) | env ของ api + subscription | `push-verifier.ts` |
| Gmail push — service account (`GMAIL_PUSH_SERVICE_ACCOUNT`) | อีเมลของ SA ที่ผูกกับ push subscription (`wt-<env>-gmail-push@<project>.iam.gserviceaccount.com`) | env ของ api + subscription | Terraform output `gmail_push_service_account` |
| Gmail Pub/Sub — topic | `projects/<project>/topics/<topic>`; ต้องให้ `gmail-api-push@system.gserviceaccount.com` เป็น **Publisher** | Pub/Sub topic IAM | PRD §11 `[CONFIRMED]` · env `PUBSUB_PROJECT_ID`, `PUBSUB_TOPIC` |
| Gmail API (domain-wide delegation) | ไม่มี URL; ต้องให้ Workspace admin อนุญาต scope ของ SA | Workspace Admin → API controls | `service-account.ts` |
| Discord | **ไม่มี inbound URL ใน Phase 1** (webhook ขาออก + bot token; ยังไม่มี interactions endpoint ในโค้ด) | — | `grep` ไม่พบ route `interactions` |
| Magic link (ลูกค้า) | `${APP_URL}/login/magic?...` (api เป็นผู้สร้างลิงก์จาก `APP_URL`) | — | `magic-link.service.ts` |
| Portal / ติดตามเรื่อง / CSAT | `${APP_URL}/portal`, `${APP_URL}/portal/tickets/{key}`, `${APP_URL}/csat` | — | `portalTrackingPath`, `CSAT_LANDING_PATH` |
| Health (LB/uptime check) | `${API_URL}/health`, `${API_URL}/health/ready`; web `${APP_URL}/health` | Cloud Run probes (ไม่ผ่าน LB) | worker ตอบ path เดียวกันบน `$PORT` |

กฎ path ที่ **ต้องไม่หลุดสู่สาธารณะ**: `/metrics` (ไม่มี auth, `metrics.controller.ts`) → Cloud Armor rule `deny(404)` ที่ LB เทียบเท่า `@internal` ใน `Caddyfile`; `/docs*` ปิดเองเมื่อ `NODE_ENV=production` (`docsEnabled = DOCS_ENABLED ?? !production`) — ห้ามตั้ง `DOCS_ENABLED=true` บน staging/production โดยไม่มีเหตุผล

ค่า env เฉพาะ GCP ที่ต่างจาก compose: `NODE_ENV=production`, `APP_URL`, `API_URL` (https), `TRUST_PROXY_HOPS=2` (ดู Consequences), `S3_*` ชี้ GCS, `DATABASE_URL`/`REDIS_URL` มาจาก Secret Manager, `SMTP_RELAY_*`, `GMAIL_*`, `PUBSUB_*`, ทุกตัวที่เหลือยังมีค่า default เหมือน compose (ตาราง `x-app-env` ใน `docker-compose.yml` คือรายการที่โค้ดอ่าน; test `packages/shared/src/compose-env.test.ts` กัน drift)

### 5. IAM และ service account

- 1 SA ต่อ service: `wt-<env>-web`, `wt-<env>-api`, `wt-<env>-worker`, `wt-<env>-migrate`, และ `wt-<env>-gmail-push` (ใช้เซ็น OIDC token ของ push subscription เท่านั้น ไม่มีสิทธิ์อื่น)
- สิทธิ์ขั้นต่ำ: `secretAccessor` เฉพาะ secret ที่ service ใช้ (ระดับ secret ไม่ใช่ project) · `cloudsql.client` เฉพาะ migrate/api/worker เมื่อใช้ Cloud SQL connector (ไม่ใช้เมื่อต่อ private IP ตรง — ไม่ต้องให้) · bucket: `objectAdmin` เฉพาะ bucket นี้ให้ SA ที่ผูกกับ HMAC key · Cloud Logging writer ติดมากับ runtime
- Pub/Sub service agent ต้องมี `roles/iam.serviceAccountTokenCreator` บน `wt-<env>-gmail-push` เพื่อสร้าง OIDC token `[VERIFY]`
- **ไม่มี key file ของ SA ใน repo/state**; SA ของ Gmail domain-wide delegation เป็นเรื่องแยก (key ถูกเก็บเป็น secret `GMAIL_SERVICE_ACCOUNT_JSON`, mount อ่านอย่างเดียว) — ตามสถานะ ADR-012 ถ้าเก็บใน credential store ของ DB ก็ไม่ต้องมี secret ตัวนี้

### 6. Environment

- สอง environment: `staging` (สร้างก่อน, ใช้ซ้อม T-115) และ `production` (ยังไม่สร้าง) แยก **GCP project คนละอัน** (ไม่ใช้ workspace/prefix ใน project เดียว) เพื่อให้ IAM, billing และ blast radius แยกกัน · Terraform root เดียว, ค่าต่างกันผ่าน `*.tfvars`, state อยู่ GCS bucket ต่อ project (`backend "gcs"` แบบ partial config)
- CI/CD (build image → Artifact Registry → deploy revision ด้วย Workload Identity Federation จาก GitHub Actions) **ยังไม่อยู่ในงานนี้** — ระหว่างนี้รันบุ๊กสั่งด้วยมือ

## Options considered

- **A. Cloud Run + Cloud SQL + Memorystore + GCS (เลือก)** — ใช้ image เดียวกับ compose, ไม่ต้องดูแล OS/Kubernetes, scale-to-zero ของ web/api, IAM อยู่ project เดียวกับ Pub/Sub/Logging/BigQuery · ข้อเสีย: worker ต้องจ่ายแบบ always-on, WebSocket ถูกตัดตาม request timeout (รับได้เพราะ client reconnect), egress IP คงที่ต้องผ่าน VPC + NAT (มีค่าใช้จ่ายคงที่)
- **B. GCE VM เดียว + Docker Compose + Caddy** (สำเนา local) — ง่ายและถูกที่สุด, IP คงที่ได้ตรง ๆ, ไม่มี NAT · ข้อเสีย: จุดล้มเดียว, ต้องดูแลระบบปฏิบัติการ/patch/disk เอง (ขัดแนว ISO 27001 ของเจ้าของ), ไม่มี HA, backup ของ Postgres/Redis ต้องทำเอง · **ไม่เลือก** เก็บไว้เป็นทางหนีไฟถ้างบหรือทักษะ ops ไม่พอ (compose ใช้ได้เลยโดยไม่ต้องแก้โค้ด)
- **C. GKE (Autopilot)** — ยืดหยุ่นสุด, worker แบบ non-HTTP ได้ตรง ๆ, egress IP จัดการง่าย · ข้อเสีย: เกินสเกลทีมเดียว, ค่าคงที่และ ops สูง; ADR-001 ตัดสินแล้วว่าเป็นงาน Phase 4 (Helm) → **ไม่เลือก** ทบทวนเมื่อมี > 1 instance ต่อ service เป็นปกติหรือต้องการ sidecar
- **D. Cloud Run worker pools สำหรับ worker** — ตรงกับงาน background ที่ไม่มี HTTP · ข้อเสีย: ความพร้อม/GA ของฟีเจอร์ในเดือนนี้ไม่ได้ยืนยัน `[VERIFY]` และเรามี health server บน `$PORT` อยู่แล้ว → ใช้ service ที่ min instance = 1 ไปก่อน; ย้ายได้ภายหลังโดยไม่แตะโค้ด
- **E. Cloud Memorystore for Valkey/Cluster แทน Redis** — ไม่เลือก: BullMQ ต้องการ key ที่ hash-tag เมื่อใช้ cluster และโค้ดใช้ non-cluster ioredis · ทบทวนเมื่อ Memorystore for Redis (non-cluster) ถูกยุติ `[VERIFY]`
- **F. path routing บน host เดียว (`/api/*` เหมือน Caddy)** — ไม่เลือก: ชน `new URL('/v1/...', API_URL)` (prefix หาย) และ LINE/Gmail ต้องการ URL คงที่ (ข้อจำกัดข้อ 4)
- **G. ใช้ `*.run.app` ตรง ๆ ไม่มี LB/โดเมน** — ไม่เลือก: คนละ site ทำให้ cookie `SameSite` ใช้ไม่ได้, ไม่มี Cloud Armor, URL เปลี่ยนเมื่อสร้างใหม่ (ทำ redirect URI/webhook พัง)
- **H. Pub/Sub pull แทน push** (worker ดึง) — ตัด public endpoint ของ Gmail ได้ แต่ LINE ยังต้องมี public webhook อยู่ดี และโค้ดฝั่ง push/verify ทำเสร็จแล้ว (T-102b/c) → ใช้ push; pull (`PUBSUB_SUBSCRIPTION`) ยังเป็นทางสำรอง

## Consequences

- **ค่าใช้จ่าย (ประมาณคร่าว ๆ สำหรับ staging, `[ASSUMED]` ยังไม่ได้ตรวจราคาปัจจุบัน → `[VERIFY]` ด้วย Pricing Calculator ก่อนอนุมัติงบ):** ค่าคงที่ที่ใหญ่สุดคือ worker always-on (1 vCPU/512 MiB instance-based), Cloud SQL ขนาดเล็ก, Memorystore 1 GB, forwarding rule ของ LB, static IP + NAT · ประมาณรวม **~150–300 USD/เดือน** (ช่วงกว้างเพราะราคา region, ชนิด instance และ traffic ยังไม่ยืนยัน) · production (HA ของ SQL/Redis, api min 1) คาดสูงกว่า staging ราว 2–3 เท่า `[ASSUMED]` · ต้องตั้ง budget alert ที่ billing account ก่อน apply (รันบุ๊ก §1) · งบ AI/API แยกใน `config/budgets.yaml`
- **`TRUST_PROXY_HOPS` ต้องตั้งให้ตรง hop จริง** — คาดว่า `2` (Cloud Run front end + external LB เติม `X-Forwarded-For`) แต่ `[UNVERIFIED 60%]`; ถ้าผิด audit log และ rate limit จะเห็น IP ของ LB หรือเชื่อ IP ปลอมได้ → ขั้นตรวจใน staging: ยิง request จากเครื่องที่รู้ IP แล้วเทียบกับ IP ใน audit log (api ก็เตือน `proxyHint` เมื่อเห็น XFF ขณะค่า = 0) ก่อนเปิด webhook
- **Redis ไม่เข้ารหัสระหว่างทาง (ภายใน VPC) ที่ staging** — `REDIS_URL` เป็น `redis://`; ถ้าจะเปิด `SERVER_AUTHENTICATION` ต้องให้ client เชื่อ CA ของ Memorystore (อาจใช้ `NODE_EXTRA_CA_CERTS` โดยไม่แก้โค้ด `[VERIFY]` รวมการตรวจชื่อ host/IP) → เป็นเงื่อนไขของ production ที่ต้องปิดก่อน T-115 หรือรับความเสี่ยงอย่างเป็นทางการ (`docs/09-SECURITY.md`)
- **HMAC key ของ GCS เป็น credential ระยะยาว** — ทางเลือกที่ดีกว่าคือ adapter native ที่ใช้ ADC/Workload identity (ไม่มี key) ซึ่งต้องเพิ่ม dependency ใหม่ไป Google Storage client → ต้องผ่าน `[ASK-HUMAN]` (AGENTS.md) จึงยังไม่ทำ; เสนอเป็น task ใหม่หลัง staging ผ่าน
- **Cloud Armor** ใช้เพียง rule ปิด `/metrics` และ rate-based ban แบบพื้นฐานที่ LB; rate limit ในแอป (`GMAIL_PUSH_RATE_PER_MINUTE`, portal limits) ยังเป็นด่านหลัก ไม่ใช่ WAF เต็มรูป
- **สิ่งที่ยังไม่ยืนยัน:** (1) provider schema ของ Terraform — เขียนจากความจำและ**ไม่เคยรัน `init`/`validate`/`plan`** จึงอาจมีชื่อ argument ผิด (2) ชื่อ region/สเปกเครื่อง/ราคา `[ASSUMED]` `asia-southeast1` (3) ความพร้อมของ Direct VPC egress / worker pools ใน region (4) SigV4 กับ GCS interop (5) hops ของ proxy (6) quota ของ Cloud Logging 60 req/min (PRD §11) ที่ใช้ร่วมกับ investigation tools
- **ต้องตรวจซ้ำ:** เมื่อ T-115 เริ่ม (เลือก production หรือไม่), เมื่อ Google เปลี่ยนสถานะ Memorystore for Redis / Cloud Run worker pools, เมื่อเพิ่ม integration ที่ต้องมี inbound ใหม่ (Discord interactions → เพิ่มแถวในตาราง §4 และ Cloud Armor)
- **งานต่อเนื่องที่เสนอ (ยังไม่อยู่ใน BACKLOG — main thread ตัดสินใจ):** CI build+push image ไป Artifact Registry ด้วย WIF · adapter GCS แบบ ADC · เปิด TLS ของ Redis · monitoring/uptime check + alert policy ผ่าน Terraform · `terraform validate` ใน CI (ต้อง `[ASK-HUMAN]` เพราะ `init` โหลด registry)

## Links

- ADR-001 (deployment target), ADR-004/012 (credential), ADR-006 (outbox), ADR-009 (ingestion, webhook บางใน api), ADR-010 (outbound at-most-once)
- PRD §11 (Gmail/LINE/Discord/GCP constraints), `docs/04-ARCHITECTURE.md` §8 (ความพร้อมย้ายไป GCP), `docs/09-SECURITY.md`
- BACKLOG T-118, T-130 (SMTP relay), T-102b/c (Gmail push), T-103 (LINE webhook)
- รันบุ๊ก: `docs/runbooks/staging-gcp.md` · IaC: `infra/terraform/`
- เอกสารภายนอก (อ้างจากความจำ **ยังไม่ได้เปิดตรวจรอบนี้** — `[VERIFY]` ก่อนใช้ตัดสินใจเรื่องเงิน/ความปลอดภัย): Cloud Run (ingress, Direct VPC egress, min instances, CPU allocation), Cloud NAT static IP, Cloud SQL private IP + pgvector, Memorystore for Redis (`maxmemory-policy`, AUTH, TLS), GCS XML API interoperability + HMAC, Pub/Sub push authentication, Secret Manager กับ Cloud Run
