# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-01 04:20 (เวลากรุงเทพ) โดย Claude Code (main thread, cloud session ทำงานอัตโนมัติ เจ้าของมอบอำนาจตัดสินใจให้ `po`)
> กฎขนาด ≤ 40 KB — เขียนทับสถานะ ไม่ append ประวัติ · ฉบับก่อนหน้าอยู่ `docs/handoff-archive/HANDOFF-2026-10-31_2026-11-01-pause.md` · บันทึกรายชั่วโมงอยู่ `logs/daily/`

## อ่านก่อน (สรุป 2 นาที)
- **Phase 0 เสร็จแล้ว** (T-005…T-014 + T-120, T-124 UI ใหม่) · **CI run #1 บน GitHub เขียวครบ 4 job รวม compose build/up/health** · เหลือ **เจ้าของตรวจบนเครื่องตามรายการด้านล่างก่อน tag `v0.0.1`**
- **Phase 1 เริ่ม wave 0** (T-101 UI spec เสร็จ, T-123a scaffolding กำลังทำ) แผนอยู่ `docs/BACKLOG.md` หัวข้อ Phase 1 + `docs/plans/phase-1-breakdown.md`
- **การตัดสินใจที่ `po` ทำแทนเจ้าของ 25 ข้อ** อยู่ในตารางด้านล่าง ติ๊กรับ/ไม่รับได้เลย
- **UI ถูกทำใหม่ตามคำขอเจ้าของ** ("ดู AI เกินไป → ศึกษา 21st.dev") · ทิศทาง `docs/design/ui-refresh-2026-11.md` · ใช้ 21st.dev เป็นแรงบันดาลใจเท่านั้น ไม่คัดลอกโค้ด (Terms ไม่อนุญาต) · ภาพหน้าจอส่งในแชตแล้ว (ไม่ได้ commit)

## สถานะปัจจุบัน
- **Phase:** 0 รอ CI + เจ้าของตรวจ · 1 wave 0
- **Build/Test (`main`, 2026-11-01 04:05, `turbo --force`):** lint, typecheck ผ่าน · unit shared 148, api 164, worker 33, db 47, ui 256, web 470, boundaries 94 · integration api 387, db 107, worker 19 · e2e (API จำลอง) 99 · full-stack e2e (web+api+worker จาก source + Postgres/Redis/Mailpit จริง) 22 `[TESTED]` บน cloud Linux
- **ยังไม่เคยรัน:** `docker compose up` ด้วย image ที่ build เอง (บน cloud build ไม่ได้: Docker Hub 429 + corepack ไม่เชื่อ CA ของ proxy) · CI บน GitHub
- **Repo:** `xzozero5/watchtower` public, Apache-2.0, เป็นกลาง `[CONFIRMED 2026-10-31]`
- **Credential ที่มีแล้ว:** ไม่มี ทุก integration เป็น mock mode
- **เงิน:** Max plan วัดเป็นดอลลาร์ไม่ได้ · token ของ sub-agent ดู daily log

## ต้องทำบนเครื่องเจ้าของก่อน tag `v0.0.1` (`[ASK-HUMAN]`, จาก `po` T-011)
1. `git pull` → `git config core.hooksPath tools/githooks` → `pnpm install && pnpm lint && pnpm typecheck && pnpm test` เขียว
2. CI run แรกบน GitHub เขียว (หลัง T-014 merge)
3. `docker compose up -d --build --wait` ทุก service healthy · `GET /health` ผ่าน Caddy (`:8080`)
4. `pnpm db:migrate && pnpm db:seed` บน volume ใหม่ — DB เก่าที่เคย apply `0002` รุ่นก่อนอาจ checksum ไม่ตรง → `docker compose down -v` แล้วขึ้นใหม่ (ข้อมูลทดสอบหาย)
5. `pnpm test:integration` บนเครื่องที่มี Docker
6. `PW_CHANNEL=msedge pnpm test:e2e` และ `pnpm test:e2e:fullstack` ทั้งแบบ source และ `E2E_STACK=external` กับ image ของ compose (`apps/web/e2e-fullstack/README.md`)
7. ลองมือ: `/portal` แจ้งเรื่อง → ticket มี org/intent/SLA → assign → ตอบ → ลูกค้าเห็นในหน้า tracking → resolve → อีเมลใน Mailpit `http://localhost:8025`
8. **ใส่รายการคำต้องห้ามจริงใน `.git/info/forbidden-terms`** (ข้อความสั่งงานมีแต่ placeholder ไม่มีรายการ — session นี้ใช้รายการที่ main thread อนุมานเองไว้ก่อน) แล้วสแกนทั้ง history · ตัดสินเรื่อง commit `47f2ae9` (test มีคำที่บอกใบ้ธุรกิจของ deployment หนึ่ง แก้แล้วใน commit ถัดไป แต่อยู่ในประวัติ `main` ที่ public) — agent ห้ามแก้ history
9. ไม่บล็อก tag: Google OIDC จริงด้วย OAuth client ของตัวเอง · `docker-compose.proxy.yml` กับ Caddy · digest ของ MinIO `[VERIFY]`
10. ติ๊กการตัดสินใจของ `po` ด้านล่าง · ให้ feedback UI ใหม่ (T-124)
11. tag เอง: `git tag v0.0.1` แล้ว `git push origin v0.0.1` (agent ไม่ tag)

## PO ตัดสินแทนเจ้าของ (session 2026-11-01 — เจ้าของมอบอำนาจ, รอทบทวน)
> ทุกข้อ `[ASSUMED]` เลือกทางที่ย้อนกลับง่าย · `po` ห้ามตรวจงานที่ตัวเองตัดสิน (N7) · สิ่งที่อยู่ใน "ห้ามทำแทนเจ้าของ" ไม่อยู่ในอำนาจนี้
> ติ๊ก `[x]` = เจ้าของรับ · ถ้าไม่รับ เขียนเหตุผลไว้ข้าง ๆ

| # | คำถาม | `po` ตัดสิน `[ASSUMED]` | เหตุผล |
|---|---|---|---|
| [ ] 1 | §16.1 repo/CI, GitHub App | GitHub + Actions · repo tool เป็น interface กลาง มี mock + GitHub App adapter read-only เปิดเมื่อมี credential | เป็นกลาง, N2 |
| [ ] 2 | §16.2 product DB | Postgres ทั่วไป (Cloud SQL เป็นแค่ตัวอ้างอิง) · data tool = Postgres read replica + read-only role ผ่าน DSN; BigQuery `EXTERNAL_QUERY` ปิดเป็นค่าเริ่มต้น · mock = Postgres ใน compose + `examples/metrics/` · guardrail `statement_timeout`/row limit/PII mask | ไม่บังคับ GCP |
| [ ] 3 | §16.3 GCP projects | config `gcp_projects[]` พร้อม environment · seed `example-prod`/`example-staging` · ไม่ migrate alert policy เดิม | เป็นกลาง |
| [ ] 4 | §16.4 mailbox | 1 mailbox = 1 `channel_account` หลายกล่องได้ · ค่าเริ่มต้น OAuth ของกล่องนั้นเอง, domain-wide delegation เป็นทางเลือก · seed `support@example.com` | สิทธิ์น้อยสุด |
| [ ] 5 | §16.5 LINE | plan `free` ตาม budgets · `quota_limit` ตั้งได้ ค่าเริ่มต้น 300 `[VERIFY]` เตือน 80% · rich menu ปิดด้วย flag (OA อาจใช้ร่วมทีมอื่น) | กันทับงานทีมอื่น |
| [ ] 6 | §16.6 Discord | ช่องแจ้งเตือน/ประสานงาน ไม่ใช่ system of record · map channel ผ่าน config | R-3.17 |
| [ ] 7 | §16.7 ทีม/กะ | seed 2 head, 2 lead, 4 agents (ครอบ "2 ต่อ role" ของ T-008) · กะ 08–17, 13–22, on-call 22–08 (Asia/Bangkok) แก้ได้ | รูปแบบทั่วไป |
| [ ] 8 | §16.8 tier/SLA | ชื่อกลาง Gold/Silver/Standard ตัวเลขอยู่ใน `examples/` + seed เท่านั้น · Gold P1 15m/4h 24×7, Silver P1 30m/8h, Standard business hours | N1, N5 |
| [ ] 9 | §16.10 AI provider | `AI_PROVIDER=mock` · Anthropic + Vertex adapter หลัง abstraction · PII redaction เปิดเสมอ · งบ dev ตาม `config/budgets.yaml` | ยังไม่มี key |
| [ ] 10 | เอกสารขัด: START-HERE ว่า `po` "ไม่ตัดสินแทน" | ไม่แก้กฎถาวร บันทึกเป็นข้อยกเว้นของ session ใน STATUS/HANDOFF/daily log | ข้อยกเว้นชั่วคราว |
| [ ] 11 | ย้าย GCP deploy มาก่อน T-115 | ย้าย → **T-118** ADR deploy GCP + IaC skeleton + runbook staging (public HTTPS สำหรับ Pub/Sub push/LINE webhook) **ไม่ apply จริง** | pilot ต้องมี webhook สาธารณะ |
| [ ] 12 | generic OIDC (องค์กรไม่ใช้ Google) | เลื่อนไป Post-MVP · UI/contract ห้าม hard-code Google นอก provider config | ไม่อยู่ใน exit criteria |
| [ ] 13 | MinIO `pgsty/minio` | ใช้ต่อเฉพาะ local · ปัก digest แล้ว (T-010) · production ใช้ GCS | override ได้ด้วย env |
| [ ] 14 | tag `v0.0.1` | เลื่อน จนเจ้าของตรวจ compose/integration/e2e บนเครื่องตัวเอง | คำสั่งเจ้าของ |
| [ ] 15 | วันหยุดไทย 2026–2027 | ข้อมูลตัวอย่างใน `examples/calendars/` ติด `[VERIFY]` โหลดเฉพาะ seed dev · production เริ่มว่าง | N5 |
| [ ] 16 | permission matrix `[ASSUMED]` | ใช้ต่อจนทีมจริงทบทวนตอน T-115 | deny-by-default |
| [ ] 17 | ภาษาเริ่มต้น | `en` · instance ตั้ง `th` ได้ | OSS เป็นกลาง |
| [ ] 18 | Pub/Sub emulator image (T-102) | อนุญาตเฉพาะ compose local ปักเวอร์ชัน | ไม่มีปลายทาง runtime ใหม่ |
| [ ] 19 | ลำดับ Phase 1 | T-101 ก่อน T-109/T-111 frontend · T-106 ก่อน T-108/T-112 · T-116 ก่อน T-118/T-115 · T-112 จำกัด stage ≤ 2 | ลด rework |
| [ ] 20 | ราคา LINE | ไม่บล็อกเริ่ม Phase 1 แต่บล็อกปิด T-103 (ตรวจเอกสารทางการ บันทึกลิงก์+วันที่) | AGENTS.md |
| [ ] 21 | UI spec §17 (Q1–Q11) | Undo-send 5 s ฝั่ง server · สี AI จาก seafoam ผ่าน contrast test · focus digest 15 นาที P1/P2 แทรกได้ · เสียง P1 ซ้ำทุก 60 วิ · portal แสดงชื่อต้น · 3 breakpoint · reject reason 9 รหัส · SLA at-risk ≤25% หรือ ≤30 นาที · severity map · spec เป็นอังกฤษ — `docs/06-UI-SPEC.md` §17 | ลด friction ทางปลอดภัย |
| [ ] 22 | human verification ของ portal (R-9.1 ยกตัวอย่าง Turnstile/hCaptcha) | self-hosted: proof-of-work + honeypot + rate limit หลัง `HumanVerificationProvider` (ADR-007) · ผู้ให้บริการภายนอก = `[ASK-HUMAN]` (ปลายทาง network ใหม่ + ส่ง IP ผู้ใช้ไป vendor) | po อนุมัติปลายทางใหม่ไม่ได้ |
| [ ] 23 | emergency switch Phase 1 | สองปุ่ม: "จำกัดทุก intent ≤ stage 2" (ไม่ยก 0/1 ขึ้น) และ kill switch "หยุด AI ทั้งหมด" · เปิด/ปิด = confirm + เหตุผล + audit | N3 |
| [ ] 24 | T-011 Phase 0 | ยังไม่ปิดจนกว่า CI (T-014) เขียว · เจ้าของตรวจตาม checklist แล้วค่อย tag | DoD |
| [ ] 26 | LINE link แล้วถือว่า "ยืนยันตัวตน" ไหม (T-103d) | LINE Login จาก portal session ที่ login แล้ว → verified · code ที่ staff เห็นแล้วบอกลูกค้า → ผูกได้แต่ **unverified** (disclosure policy §6.6 ยังบังคับ) · code ที่ส่งไป email ที่ยืนยันแล้วเท่านั้น (R-2.11c) → verified · เก็บสถานะ LINE แยกจาก `contact.verified_at` · staff ยืนยันเองเป็น action แยก lead+ พร้อมเหตุผล+audit (อนาคต) | staff ถูก social engineering ทางโทรศัพท์ได้ · ทางที่ verified ต้องพิสูจน์ว่าคุมทั้ง email และ LINE · ย้อนกลับง่าย |
| [ ] 25 | T-011 Phase 1 scope | T-122 ingest + `packages/domain`, T-123 scaffolding, AC-4 → T-108e KB-author ขั้นต่ำ, เลื่อน Discord bot / Web Push / digest / crawler / bulk ไปหลัง T-113, worktree ≤ 3, Phase 1 ปิดที่ "done pending pilot" | credit จำกัด ทำของมีค่าก่อน |

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ชื่อ Watchtower · stack ADR-001 · Docker local ก่อน GCP ภายหลัง · feature set PRD v0.1 · repo public เป็นกลาง · SSO domain จาก env · secret infra ใน env / credential integration เข้ารหัสใน DB (ADR-004) · โลโก้ `docs/brand/` · default autonomy stage 2 · ภาษา (โค้ด/commit อังกฤษ, เอกสารไทย) — 2026-10-31
- 2026-11-01: ทำงานอัตโนมัติจนจบ Phase 1 (หยุดที่ T-115) · มอบอำนาจตัดสินใจให้ `po` ยกเว้นรายการ "ห้ามทำแทน" · งานขนานใน worktree แล้ว main thread ตรวจซ้ำ merge ทีละงาน · UI ต้องไม่ "ดู AI" — ศึกษา 21st.dev

## ทำเสร็จใน session นี้ (2026-11-01)
| งาน | ผล | ไฟล์หลัก |
|---|---|---|
| Env | cloud: dockerd เอง, compose infra, Chromium ติดตั้งแล้ว, hook + forbidden terms ทดสอบแล้ว | `docs/STATUS.md` 00:35 |
| T-005 | ticket core ครบ + แก้ B1–B4, duplicates 72h, CRUD tests | `apps/api/src/{tickets,sla,team-queues,orgs,realtime}` |
| T-013 | follow-up review T-005, outbox ADR-006, `org_tier`, prefix ตั้งได้ | migration `0003`, `packages/db/src/outbox.ts` |
| T-008 | `pnpm db:seed` idempotent, วันหยุดไทยเป็นข้อมูลตัวอย่าง `[VERIFY]` | `packages/db/src/seed/`, `examples/{calendars,sla}` |
| T-101 | UI spec + คำตัดสิน `po` §17 | `docs/06-UI-SPEC.md` |
| T-006 / T-120 | workspace three-pane, login, realtime, PWA / a11y + keyboard + session cache | `apps/web` |
| T-124 | UI ใหม่ตาม 21st.dev (แรงบันดาลใจ) | `docs/design/ui-refresh-2026-11.md`, `packages/ui`, `apps/web` |
| T-007 | portal: PoW self-hosted (ADR-007), tracking link, อีเมลผ่าน outbox, หน้า portal | `apps/api/src/portal`, `apps/web/src/app/portal`, migration `0004` |
| T-010 | security review → แก้ C-1…C-16, ADR-005/006/007 Accepted | migration `0005`, `docs/09-SECURITY.md` |
| T-009 | full-stack e2e AC-1 + magic link + RBAC | `apps/web/e2e-fullstack`, `tools/e2e-stack` |
| T-011 | `po` review Phase 0 + scope Phase 1 | `docs/BACKLOG.md`, `docs/plans/phase-1-breakdown.md` |

## ค้าง / ติดอะไร
- **T-014 CI** (`qa-engineer`, worktree `wip/t-014`) + ขั้น assign ใน full-stack e2e — กำลังทำ · push ครั้งแรกจะสั่ง CI บน GitHub จริง
- **T-123a scaffolding** (`backend-dev`, `wip/t-123a`) — กำลังทำ · ต่อด้วย T-123b (i18n แยก namespace)
- T-012 `/handoff` ปิด Phase 0 + `CHANGELOG.md` 0.0.1 (ไม่ tag)
- งาน Phase 1 ตาม waves ใน `docs/BACKLOG.md` · **หยุดที่ T-115** (credential จริง + ทีมจริง)
- bug B-001 (P3) portal tracking ไม่ refetch เมื่อ fragment เปลี่ยน → T-125

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] รายการตรวจก่อน tag ข้างบน (ข้อ 1–11)
- [ ] รายการคำต้องห้ามจริง + เรื่อง commit `47f2ae9`
- [ ] feedback UI ใหม่ (T-124)
- [ ] ผู้ให้บริการ human verification แบบ hosted (Turnstile/hCaptcha) ถ้าต้องการ — ปลายทาง network ใหม่ (ADR-007)
- [ ] Web Push / KB crawl แบบ live — ปลายทาง network ใหม่
- [ ] credential จริงทุกตัว (T-115) — `.env.example` + คู่มือจะเตรียมให้ตอนจบ Phase 1
- [ ] ยก autonomy ของ intent ใด ≥ 3 — ห้าม agent ทำ

## ขั้นต่อไป (เรียงลำดับ)
1. ตรวจซ้ำ + merge T-014 (CI) และ T-123a → T-123b → T-012 (CHANGELOG 0.0.1, ไม่ tag)
2. Phase 1 W1: T-122a ADR + T-122b `packages/domain` ∥ T-106a→d (AI core, PII redaction ก่อน) ∥ T-102a/T-103a (adapter pure + fake) ∥ T-116a, T-117 — worktree ≤ 3
3. W2–W4 ตาม `docs/BACKLOG.md` → T-113 → T-114 → T-125 → **หยุดที่ T-115**

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- Google OIDC จริง (ทดสอบกับ fake OIDC) `[UNVERIFIED 60%]` · permission matrix `[ASSUMED]`
- วันหยุดไทย 2026–2027 ใน `examples/calendars/` `[VERIFY]` (วันตามจันทรคติ/ชดเชย `[UNVERIFIED]`)
- ตัวเลข SLA ตัวอย่าง, rate limit portal, PoW 18 bit บนมือถือ `[ASSUMED]`
- CSP เว็บยัง `unsafe-inline` + `connect-src` แบบ build-time → T-125
- Caddy override + digest MinIO `[VERIFY]` · LINE pricing `[VERIFY]` ก่อนปิด T-103 · Pub/Sub emulator รองรับ push `[VERIFY]`
- `docs/brand/watchtower-logo.svg` เป็นแบบย่อของ PNG — UI ใช้ PNG

## วันตรวจซ้ำ
- LINE pricing/feature: ก่อนปิด T-103 · Google managed MCP: ก่อน T-203 · วันหยุดราชการไทยปีถัดไป: ธันวาคม 2026
