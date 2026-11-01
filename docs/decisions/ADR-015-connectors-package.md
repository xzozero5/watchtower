# ADR-015 — workspace `packages/connectors` (read-only clients ของ GCP/Git/data) และ alert ingest (แก้ matrix ของ ADR-002, T-200/T-201)

- **Status:** Accepted (main thread 2026-11-02, security review T-201)
- **Date:** 2026-11-02 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread · ร่างโดย `integration-engineer` ตาม `docs/plans/phase-2-breakdown.md` §G ข้อ 1 และ 3
- **Context:**
  - Phase 2 ต้องมี client สำหรับระบบภายนอกที่ **อ่านอย่างเดียว**: Cloud Logging, Cloud Monitoring, BigQuery/Postgres, Git (R-5.x, N2) และ normalizer ของ alert จาก GCP/Alertmanager (R-3.1–R-3.3) ทุกตัวต้องมี fake ที่รันโดยไม่มี credential/เครือข่าย (เจ้าของสั่ง 2026-11-01: mock ก่อน, ปลายทางจริง `[ASK-HUMAN]`)
  - `packages/channels` เป็นของช่องทางสื่อสารสองทาง (`ingest/send/markRead/capabilities`, ลูกค้า) การเอา "tool ที่ AI ใช้ investigate" ไปปนจะให้ adapter ที่มี method เขียนอยู่ใน package เดียวกับ client ที่ต้องเป็น read-only ตาม N2 และทำให้ตรวจ N2 ด้วย lint/ts ไม่ได้
  - ADR-002: ทุก workspace อยู่ในตาราง `WORKSPACES` ของ `tools/eslint/boundaries.mjs` และ N10 บังคับให้เขียน ADR ก่อนแก้ matrix
  - ADR-009: `packages/domain` ทำเฉพาะ write ของ ticket/alert ห้ามเรียก HTTP/Redis และไม่รู้จัก `channels`; ADR-008: `packages/ai` ไม่รู้จัก DB/HTTP
  - บทเรียน T-122/ADR-010 §4: เวลาที่ใช้ตัดสินข้าม process ต้องเป็นนาฬิกาเดียว (ฐานข้อมูล) ไม่ใช่นาฬิกาของ process

## Decision

### 1. workspace ใหม่ `packages/connectors` (`@watchtower/connectors`)
- แถวใหม่ใน `WORKSPACES`: `allow: ['@watchtower/shared']`, `forbid: ['persistence']` (เหมือน `channels`) · **ห้าม** import `db`, `domain`, `ai`, `channels`, `api`, `worker`, `web`, `ui` · `ai` กับ `channels` ไม่รู้จัก `connectors` และกลับกัน (ไม่อยู่ใน `allow` ของทั้งสอง)
- `apps/api` และ `apps/worker` เพิ่ม `@watchtower/connectors` ใน `allow` (ผู้ประกอบ fake/live เข้ากับ port เหมือนที่ทำกับ `channels`) · `packages/domain` **ไม่** รู้จัก `connectors`: ชนิดข้อมูลที่ข้ามขอบเขต (alert ที่ normalize แล้ว) ประกาศใน `packages/shared` เป็น Zod schema เดียว ทั้ง connectors (ผู้ผลิต) และ domain (ผู้บริโภค) ใช้
- โครง: `src/<feature>/` ต่อ connector (`alerts/` ก่อน; `logs/`, `metrics/`, `data/`, `repo/` ตามมาใน T-203a) แต่ละตัวมี `index.ts`, fake ในไฟล์แยก, fixture ใน `__fixtures__/` (ไม่ถูก build)
- **N2 บังคับที่ type:** interface ของ client (`LogsClient`, `MetricsClient`, `DataQueryClient`, `RepoClient`, T-203a) มีเฉพาะ method อ่าน; test หนึ่งตัวต่อ interface เช็คว่าชื่อ method ไม่ขึ้นต้นด้วย `create|update|delete|write|post|put|patch|send|insert` (กัน drift) · ไม่มี live adapter ใน Phase 2 (T-208 `[ASK-HUMAN]`)
- ปลายทางเครือข่ายใหม่ (live) ต้องเพิ่ม dependency หรือ `fetch` ผ่าน port ที่ฉีดเข้ามา ไม่เรียกตรงจาก normalizer · normalizer เป็นฟังก์ชัน pure ไม่มี I/O

### 2. Alert ingest (T-201)
- **ที่รับ:** `apps/api` (`POST /v1/inbound/alerts/gcp` สำหรับ Pub/Sub push, `POST /v1/inbound/alerts/webhook` สำหรับ webhook ที่เซ็น HMAC) บางตามแบบ ADR-009 §1: ตรวจ authentication ก่อนอ่าน body, parse → `connectors.alerts.normalize*` → `domain.alerts.ingest` ใน transaction เดียว → ตอบ · ไม่เรียก provider
- **Authentication:** Pub/Sub ใช้ `createOidcPushVerifier` เดิม (audience + service account จาก env `ALERT_PUSH_AUDIENCE`, `ALERT_PUSH_SERVICE_ACCOUNT`; ว่าง = ตอบ 503 ไม่รับ) · webhook ใช้ HMAC-SHA256 ของ `"<t>." + raw body` ใน header `X-Watchtower-Signature: t=<unix>,v1=<hex>` ด้วย secret จาก credential store (`alerting.webhookSecret`, env ชนะ DB ตาม ADR-012) · ค่า `t` เก่า/ใหม่เกิน 5 นาทีถูกปฏิเสธ · Alertmanager เองเซ็น body ไม่ได้ (รองรับเฉพาะ basic/bearer) จึงต้องมี relay/proxy ที่เซ็น `[VERIFY]` — ถ้าต้องการ bearer โดยตรงเป็นการตัดสินใจแยก `[ASK-HUMAN]`
- **Idempotency:** `alert_event` unique `(source, provider_event_id)` — GCP: Pub/Sub `messageId` (redelivery คือ id เดิม ไม่นับ; fire จริงสองครั้งคือสอง id) · Alertmanager: `fingerprint|startsAt|status|endsAt` (repeat notification ของ firing เดิมไม่นับ) · transaction ล็อก `pg_advisory_xact_lock(hash(fingerprint))` ก่อนตรวจซ้ำ + upsert จึงไม่มี race ระหว่างสอง delivery พร้อมกัน
- **Fingerprint (R-3.5):** SHA-256 ของ JSON เรียง key ของ `[source, ชื่อ policy/alertname, ชื่อ condition, resource type, labels ทั้งหมดเรียงแล้ว]` · unique แบบ partial `(fingerprint) WHERE state <> 'resolved'` = alert ที่เปิดอยู่หนึ่งแถวต่อ fingerprint; fire ซ้ำเพิ่ม `count`, `last_seen_at` · ไม่มี "หน้าต่างเวลา" แยก: alert เปิดอยู่ตราบใดที่ provider ยังไม่ส่ง `closed`
- **`closed` ปิดเฉพาะ alert** (PRD §5.3): ไม่แตะ `incident`/`ticket` (alert มี `incident_id uuid` ไม่มี FK จนกว่า T-202a สร้างตาราง) · `closed` ที่ไม่มี alert เปิดอยู่ถูก ack และทิ้ง (ไม่สร้างแถว)
- **N4:** `alert.payload` เก็บเฉพาะ key ใน allow-list (`ALERT_PAYLOAD_KEYS` ใน `packages/shared`) และเฉพาะ label key ใน allow-list; summary ตัดที่ 500 ตัวอักษร; ขนาดรวม ≤ 8 KB · Discord (T-201d) ห้ามใส่ชื่อ org/เนื้อความลูกค้า
- **นาฬิกา:** ทุกเวลาที่ระบบเป็นคนตัดสินหรือบันทึก (`first_seen_at`, `last_seen_at`, `resolved_at`, และ `next_escalation_at` ของ T-201d) ใช้ `now()`/`clock_timestamp()` ของฐานข้อมูลเท่านั้น; เวลาจาก provider (`started_at`/`ended_at`/`startsAt`) เก็บเป็น `occurred_at` เพื่อแสดง ไม่ใช้ตัดสิน · การเทียบเวลาของ webhook (`t` เทียบ "ตอนนี้") ใช้นาฬิกา process เดียวและเป็นการตรวจความสด ไม่ใช่การตัดสินข้าม process
- **Service catalog (R-3.7):** `service` + `escalation_policy` (T-201b); alert ผูกกับ service จาก `service.match_rules` (labels/ชื่อ policy ที่ตรงกัน) ไม่เจอ = `service_id IS NULL` = "unmapped" (`GET /v1/alerts/unmapped`)

### 3. งบ rate/cost ร่วม (ตัดสินที่ T-203b)
ทุก client ใน `connectors` ที่เรียก API ที่มีโควตา (Logging 60 req/min/project) ใช้ budget เดียวต่อ project ผ่าน `rate_budget_window` และลง `tool_execution` ทุกครั้ง; ย้าย ledger ของ T-108 และ partition `tool_execution` ทำที่ T-203b ไม่ใช่ที่นี่ — ADR นี้บันทึกเพียงว่า budget เป็นของ `apps/*` ที่ฉีดเข้า client ไม่ใช่ของ `connectors` (ไม่มี DB)

## Options considered
- **A — ใส่ใน `packages/channels`** — ไม่ต้องมี workspace ใหม่ แต่ผสม adapter สองทาง (มี `send`) กับ client read-only; ตรวจ N2 แยกไม่ได้ และ `channels` forbid `persistence` อยู่แล้วจึงไม่ได้ประโยชน์อะไร
- **B — ใส่ใน `packages/ai`** — ใกล้ tool registry แต่ `ai` ห้าม HTTP/DB (ADR-008) และ alert normalizer ไม่เกี่ยวกับ AI
- **C — workspace ใหม่ `packages/connectors` (เลือก)** — boundary ชัด: pure + injected port, `domain` ไม่ผูกกับ provider, แลกกับ workspace เพิ่มหนึ่งตัวและ type ร่วมใน `shared`
- **ตัวรับ alert ใน worker แทน api** — ไม่เลือก: Pub/Sub push ต้องมี HTTP endpoint สาธารณะซึ่งเป็นหน้าที่ api (ADR-009 §1) และ idempotency ใน transaction เดียวกับการเขียนตอบเร็วกว่า

## Consequences
- workspace ใหม่ต้องอยู่ใน `WORKSPACES` (test fail ถ้าไม่) · `pnpm-lock.yaml` เปลี่ยน (workspace link เท่านั้น ไม่มี dependency ภายนอกใหม่)
- fixture ของ payload GCP/Alertmanager สร้างจากเอกสารทางการ; payload ของ log-based alert ผ่าน Pub/Sub ไม่มีตัวอย่างในเอกสารที่อ่านได้ `[VERIFY]` — ต้องตรวจกับ payload จริงก่อนเปิด live (`[ASK-HUMAN]`)
- ถ้าต่อ live: ADR ใหม่ต่อ connector (ปลายทางเครือข่ายใหม่), ไม่แก้ ADR นี้

## Links
- PRD §4.3 (R-3.1–R-3.11), §4.5, §5.3, §11 · `docs/plans/phase-2-breakdown.md` §B, §C T-201, §G · ADR-002, ADR-009, ADR-010 §4, ADR-012
- Cloud Monitoring notification options (Pub/Sub JSON v1.2) https://docs.cloud.google.com/monitoring/support/notification-options (อ่าน 2026-11-02)
- Alertmanager webhook_config (payload version 4) https://prometheus.io/docs/alerting/latest/configuration/ (อ่าน 2026-11-02)
