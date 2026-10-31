# ADR-001 — Tech stack และเป้าหมาย deployment

- **Status:** Accepted (เจ้าของเคาะ 2026-10-31 21:01) `[CONFIRMED]`
- **Context:** Watchtower ต้องเป็น open source, self-hosted, enterprise-grade, AI-first และถูก build ด้วย AI coding session เป็นหลัก (PRD §12) — ต้องการภาษาเดียวทั้ง repo, ecosystem AI SDK ที่ดี, และโครงที่ย้ายจาก local ไป cloud ได้โดยไม่เขียนใหม่

## Decision
| ชั้น | เลือก | หมายเหตุ |
|---|---|---|
| ภาษา/โครง | **TypeScript ทั้ง repo**, monorepo **pnpm + Turborepo** | สลับ web/api/worker โดยไม่เปลี่ยน context |
| Frontend | `apps/web` **Next.js (App Router)** + React + Tailwind + shadcn/ui + TanStack Query + WebSocket client + **PWA** | PWA = สะพานก่อน native app (Phase 4) |
| Backend | `apps/api` **NestJS** — REST (OpenAPI), WebSocket gateway, **MCP server endpoint** | modular ตาม domain: auth, tickets, channels, alerts, kb, ai, shifts, metrics, admin |
| Worker | `apps/worker` **BullMQ** | ingestion, AI runs, schedulers (Gmail watch renew, SLA, CSAT, metrics, briefs) |
| DB | **Postgres 16 + pgvector** ผ่าน **Drizzle ORM** (migrations ใน `packages/db`) | time-series partition รายเดือน |
| Cache/queue/realtime | **Redis** | BullMQ + pub/sub สำหรับ WS fan-out |
| Object storage | **S3-compatible interface** — local = **MinIO**, GCP = **GCS** (ผ่าน S3 interop หรือ adapter) | attachment, LINE media, exports |
| AI | **Vercel AI SDK** provider abstraction → Anthropic (API หรือ Vertex-hosted Claude) / Vertex AI Gemini; embeddings เลือก provider ได้ | เลือกจากหน้า admin (PRD §6.7); ห้าม hardcode model — `config/models.yaml` |
| Reverse proxy/TLS | **Caddy** (local/compose) | บน GCP ใช้ load balancer/Cloud Run ingress แทน |
| Observability | OpenTelemetry + Prometheus endpoint + structured JSON logs | บน GCP ส่งเข้า Cloud Logging/Monitoring |
| Tests | Vitest (unit/integration), Playwright (e2e), AI eval runner (`evals/`) | |
| CI | GitHub Actions | lint, typecheck, test, build image |

### Deployment target `[CONFIRMED]`
1. **Phase 0–1: รันบน Docker Compose บนเครื่อง local** (`docker compose up`: web, api, worker, postgres, redis, minio, caddy) — เป็นวิธี deploy มาตรฐานของ open source ด้วย
2. **Production จริง: GCP** — mapping ที่ตั้งใจไว้ `[ASSUMED — เขียน ADR-00x ตอนทำจริง]`:
   - web / api / worker → **Cloud Run** (container เดียวกับ compose, scale-to-zero สำหรับ web/api; worker ตั้ง min instance ≥ 1 เพราะต้องรับ Pub/Sub และ scheduler)
   - Postgres → **Cloud SQL for PostgreSQL** (รองรับ pgvector) · Redis → **Memorystore** · MinIO → **GCS**
   - secrets → **Secret Manager** · service account แยกต่อ service, least privilege ตาม PRD §8.2
   - ingress → Cloud Run + Cloud Load Balancer + managed TLS
   - ข้อดีเพิ่ม: Pub/Sub (Gmail push, Monitoring alerts), Logging, BigQuery อยู่ project เดียวกัน → latency/IAM ง่าย
3. กฎเพื่อให้ย้ายได้โดยไม่เขียนใหม่: **12-factor** (config ผ่าน env เท่านั้น), ไม่มี local filesystem state, storage ผ่าน interface เดียว, scheduler ใน worker ไม่พึ่ง cron ของ OS, health endpoints ทุก service, image เดียวกันทั้ง compose และ Cloud Run

## Options considered
- **Go backend** — เร็ว/เบา แต่ต้องสลับภาษากับ frontend, AI SDK ecosystem ด้อยกว่า → ไม่เลือก
- **Python backend (FastAPI)** — ดีด้าน AI แต่แยกภาษาจาก frontend, type sharing ยาก → ไม่เลือก
- **Fork Chatwoot / Zammad** — Rails monolith, AI ของ Chatwoot อยู่ใน enterprise license, ไม่มี shift/investigation/autonomy → ไม่เลือก (ยืม pattern แทน, PRD §14)
- **Fastify/Hono แทน NestJS** — เบากว่า แต่ NestJS ให้โครง module/DI/guards ที่เหมาะ RBAC + audit ของ enterprise → เลือก NestJS; เปลี่ยนได้ด้วย ADR ใหม่ถ้าพิสูจน์ว่าช้าเกินไป
- **Prisma แทน Drizzle** — Drizzle เบากว่า, SQL-first เหมาะ pgvector/partition → เลือก Drizzle
- **GKE แทน Cloud Run** — ยังไม่จำเป็นในสเกลทีมเดียว; Helm chart เป็นงาน Phase 4

## Consequences
- ต้องมี `docker-compose.yml` ที่รันครบตั้งแต่ Phase 0 และ CI build image เดียวกับที่จะขึ้น Cloud Run
- ทุก integration ต้องมี mock/sandbox mode เพื่อรัน local โดยไม่มี credential จริง (`[ASK-HUMAN]` ก่อนต่อของจริง)
- การเบี่ยงจากตารางนี้ต้องเขียน ADR ใหม่ก่อนแก้โค้ด (N10)

## Links
- PRD §8.1, §12 · `docs/00-START-HERE.md` · `config/models.yaml`
