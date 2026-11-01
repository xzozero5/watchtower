# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-02 00:30 (เวลากรุงเทพ) โดย Claude Code (main thread, เครื่อง local) — **safe pause ตามคำสั่งเจ้าของ เพราะโควตาใกล้เต็ม ยังไม่จบ Phase 1**
> กฎขนาด ≤ 40 KB — เขียนทับสถานะ ไม่ append ประวัติ · ฉบับก่อนหน้า `docs/handoff-archive/HANDOFF-2026-11-01-0420.md` · บันทึกรายชั่วโมง `logs/daily/2026-11-01.md` · log ต่อ task `docs/STATUS.md`

## คำสั่งล่าสุดของเจ้าของ (2026-11-01 22:15)
ทำต่อด้วย mock ให้จบ Phase 2 เท่าที่เป็นไปได้มากที่สุด ให้ `po` ตัดสินแทน · ข้าม T-115 pilot ไปก่อน (ยังไม่มี credential จริง) · รายการ "ห้ามทำแทน" ยังใช้เหมือนเดิม · safe pause เมื่อโควตา 5 ชั่วโมงหรือ weekly ถึง 95%

## ทำต่อจากตรงนี้ (safe pause 2026-11-01 12:57)
- **T-103b–d LINE และ T-102b–d Gmail merge เข้า `main` แล้ว** · ลำดับถัดไป: T-104, T-107, T-111 (ตารางด้านล่าง) → T-102e OAuth กล่อง Gmail → wave 3–4 ตาม BACKLOG → หยุดที่ T-115 · migration บน `main` ถึง `0030_channel_account_disable`
- **gate บนเครื่องนี้ของ T-103 `[TESTED]`:** lint, typecheck ผ่าน · unit web 667, api 191, worker 79, domain 67, shared 257, channels 330, db 50, ai 372, ui 609, boundaries 200 · integration db 200, domain 188, api 528, worker 83 (รอบเครื่องว่าง) · e2e 134 · full-stack 23 (`PW_CHANNEL=msedge`) · ยังไม่ได้ลอง `docker compose up` ด้วย image ที่ build เอง
- **รัน integration ตอนเครื่องว่าง:** รอบที่มี agent รัน test พร้อมกัน ตกแบบหลอก 2 ข้อ (db `followups` timeout, api `portal` `no portal email`) รอบเครื่องว่างผ่านครบ
- **บั๊กจริงที่เจอเฉพาะบนเครื่องจริง แก้แล้ว:** (1) `message.created_at` ใช้นาฬิกาแอป `ticket_event` ใช้นาฬิกา DB ทำ timeline ลูกค้าเรียงผิด (2) relay ใช้นาฬิกา DB แต่ claim ใช้นาฬิกา worker ทำ reply ลูกค้าค้างราว 2 นาที · security review ของสอง fix ไม่มี P0/P1

## อ่านก่อน (สรุป 2 นาที)
- **Phase 0 เสร็จ** (CI แดงช่วงหลัง T-112a จาก MinIO หาย แก้แล้ว ดู STATUS) · ยังไม่ tag `v0.0.1` — รอเจ้าของตรวจบนเครื่อง (รายการด้านล่าง)
- **Phase 1 กำลังทำ** · บน `main` แล้ว: T-101, T-102a–d, T-103a–d, T-104, T-106a–e, T-112a, T-116a, T-117, T-122a–e, T-123a, T-126–T-129 · **ค้างบน branch 3 งาน** (LINE, Gmail, KB — ตารางด้านล่าง) ทั้งหมดผ่าน security review รอบแรกและแก้ finding ไปแล้วบางส่วน
- **กติกาที่ใช้ทั้ง session:** security finding P0/P1 ต้องแก้ก่อน merge · main thread รัน test เองบน branch `verify/<task>` (merge กับ `main` ล่าสุด) ก่อน merge เสมอ · migration เปลี่ยนเลขตอน merge
- **`po` ตัดสินแทนเจ้าของ 27 ข้อ** (ตารางด้านล่าง) ติ๊กรับ/ไม่รับได้เลย · ข้อใหม่ #26 (LINE verified), #27 (KB publish แยกหน้าที่)
- **UI:** T-124 → T-128 (AI-first board) → T-129 (มน/สี/icon, แยก status กับ tag ตาม feedback เจ้าของ) · ภาพหน้าจอส่งในแชตแล้ว (ไม่ได้ commit)

## สถานะปัจจุบัน
- **Phase:** 0 รอเจ้าของตรวจ + tag · 1 อยู่ wave 2 (`docs/plans/phase-1-breakdown.md` §H)
- **`main` (merge ล่าสุด T-129, 11:19):** main thread รัน `turbo --force` เอง: lint/typecheck ผ่าน · unit ทุก package (ui 609, web 666, api 188, worker 79, domain 63, ai 372, channels 325) · integration db 200, domain 170, api 502, worker 67 · web e2e 134 · full-stack e2e 23 `[TESTED]` บน cloud Linux
- **Migration บน `main`:** 0000–0016 (`0013_outbound_delivery`, `0014_outbound_hardening`, `0015_line_identity`, `0016_gmail_account_state`)
- **Integration จริง:** ยังไม่มี ทุกตัวเป็น mock / fake transport
- **เงิน:** Max plan (วัดเป็นดอลลาร์ไม่ได้) · token ของ sub-agent ดู daily log

## งานค้างบน branch (push ขึ้น origin แล้ว ทำต่อบนเครื่องได้เลย)
| งาน | branch | สถานะ | ต้องทำต่อ |
|---|---|---|---|

## Follow-up ที่เปิดไว้
- **T-122f** (P3 จาก re-review T-122e) — **F-1 ต้องปิดก่อนเปิด LINE push จริง:** cancel/deny ของ pinned push ที่ re-queue แล้วต้องติด `outcome_unknown`
- จาก review fix นาฬิกา เข้า T-122f: **P2 O-7** hold ใช้นาฬิกา API claim ใช้นาฬิกา worker จน undo เหลือ 0 ได้ + sweep trigger ไม่มี `notBefore` (`schedule.ts:178`, `dispatch.ts:686`) · P3 `dispatcher.ts:490`, `Retry-After` ไม่มีเพดาน (`state.ts:92`), `ingest.ts:414`, sweep lease เมื่อ skew ≥ 120 s
- ก่อนเปิด AI live: name dictionary ของ redactor ว่าง ชื่อในคำค้น KB อาจไม่ถูก redact `[UNVERIFIED 70%]`
- **T-103e** ส่งรหัสผูก LINE ไป email ที่ยืนยันแล้ว = verified (`po` #26) · อยู่ใน BACKLOG แล้ว
- **T-125** security P3 รวม + test จับเวลาที่ flaky ภายใต้โหลด (break-glass timing, ui timeout) + B-001
- **T-103e** (เพิ่มลง BACKLOG ตอน merge T-103) · ยังไม่มีโค้ดอ่าน `line_verified_at` ไปใช้ตัดสิน disclosure — ต้องทำใน T-108/T-109
- T-109 ต้องเปลี่ยน web ไปใช้ cancel endpoint ฝั่ง server + `aiDraftId`

## PO ตัดสินแทนเจ้าของ (session 2026-11-01 — เจ้าของมอบอำนาจ, รอทบทวน)
> ทุกข้อ `[ASSUMED]` เลือกทางที่ย้อนกลับง่าย · `po` ห้ามตรวจงานที่ตัวเองตัดสิน (N7) · สิ่งที่อยู่ใน "ห้ามทำแทนเจ้าของ" ไม่อยู่ในอำนาจนี้
> เจ้าของรับทั้ง 27 ข้อ 2026-11-01 21:59 · ข้อ #4: เจ้าของเลือกเพิ่ม OAuth ของกล่องเมลก่อน pilot (T-102e) เพราะโค้ดตอนนี้มีแค่ delegation

| # | คำถาม | `po` ตัดสิน `[ASSUMED]` | เหตุผล |
|---|---|---|---|
| [x] 1 | §16.1 repo/CI, GitHub App | GitHub + Actions · repo tool เป็น interface กลาง มี mock + GitHub App adapter read-only เปิดเมื่อมี credential | เป็นกลาง, N2 |
| [x] 2 | §16.2 product DB | Postgres ทั่วไป (Cloud SQL เป็นแค่ตัวอ้างอิง) · data tool = Postgres read replica + read-only role ผ่าน DSN; BigQuery `EXTERNAL_QUERY` ปิดเป็นค่าเริ่มต้น · mock = Postgres ใน compose + `examples/metrics/` · guardrail `statement_timeout`/row limit/PII mask | ไม่บังคับ GCP |
| [x] 3 | §16.3 GCP projects | config `gcp_projects[]` พร้อม environment · seed `example-prod`/`example-staging` · ไม่ migrate alert policy เดิม | เป็นกลาง |
| [x] 4 | §16.4 mailbox | 1 mailbox = 1 `channel_account` หลายกล่องได้ · ค่าเริ่มต้น OAuth ของกล่องนั้นเอง, domain-wide delegation เป็นทางเลือก · seed `support@example.com` | สิทธิ์น้อยสุด |
| [x] 5 | §16.5 LINE | plan `free` ตาม budgets · `quota_limit` ตั้งได้ ค่าเริ่มต้น 300 `[VERIFY]` เตือน 80% · rich menu ปิดด้วย flag (OA อาจใช้ร่วมทีมอื่น) | กันทับงานทีมอื่น |
| [x] 6 | §16.6 Discord | ช่องแจ้งเตือน/ประสานงาน ไม่ใช่ system of record · map channel ผ่าน config | R-3.17 |
| [x] 7 | §16.7 ทีม/กะ | seed 2 head, 2 lead, 4 agents (ครอบ "2 ต่อ role" ของ T-008) · กะ 08–17, 13–22, on-call 22–08 (Asia/Bangkok) แก้ได้ | รูปแบบทั่วไป |
| [x] 8 | §16.8 tier/SLA | ชื่อกลาง Gold/Silver/Standard ตัวเลขอยู่ใน `examples/` + seed เท่านั้น · Gold P1 15m/4h 24×7, Silver P1 30m/8h, Standard business hours | N1, N5 |
| [x] 9 | §16.10 AI provider | `AI_PROVIDER=mock` · Anthropic + Vertex adapter หลัง abstraction · PII redaction เปิดเสมอ · งบ dev ตาม `config/budgets.yaml` | ยังไม่มี key |
| [x] 10 | เอกสารขัด: START-HERE ว่า `po` "ไม่ตัดสินแทน" | ไม่แก้กฎถาวร บันทึกเป็นข้อยกเว้นของ session ใน STATUS/HANDOFF/daily log | ข้อยกเว้นชั่วคราว |
| [x] 11 | ย้าย GCP deploy มาก่อน T-115 | ย้าย → **T-118** ADR deploy GCP + IaC skeleton + runbook staging (public HTTPS สำหรับ Pub/Sub push/LINE webhook) **ไม่ apply จริง** | pilot ต้องมี webhook สาธารณะ |
| [x] 12 | generic OIDC (องค์กรไม่ใช้ Google) | เลื่อนไป Post-MVP · UI/contract ห้าม hard-code Google นอก provider config | ไม่อยู่ใน exit criteria |
| [x] 13 | MinIO `pgsty/minio` | ใช้ต่อเฉพาะ local · ปัก digest แล้ว (T-010) · production ใช้ GCS | override ได้ด้วย env |
| [x] 14 | tag `v0.0.1` | เลื่อน จนเจ้าของตรวจ compose/integration/e2e บนเครื่องตัวเอง | คำสั่งเจ้าของ |
| [x] 15 | วันหยุดไทย 2026–2027 | ข้อมูลตัวอย่างใน `examples/calendars/` ติด `[VERIFY]` โหลดเฉพาะ seed dev · production เริ่มว่าง | N5 |
| [x] 16 | permission matrix `[ASSUMED]` | ใช้ต่อจนทีมจริงทบทวนตอน T-115 | deny-by-default |
| [x] 17 | ภาษาเริ่มต้น | `en` · instance ตั้ง `th` ได้ | OSS เป็นกลาง |
| [x] 18 | Pub/Sub emulator image (T-102) | อนุญาตเฉพาะ compose local ปักเวอร์ชัน | ไม่มีปลายทาง runtime ใหม่ |
| [x] 19 | ลำดับ Phase 1 | T-101 ก่อน T-109/T-111 frontend · T-106 ก่อน T-108/T-112 · T-116 ก่อน T-118/T-115 · T-112 จำกัด stage ≤ 2 | ลด rework |
| [x] 20 | ราคา LINE | ไม่บล็อกเริ่ม Phase 1 แต่บล็อกปิด T-103 (ตรวจเอกสารทางการ บันทึกลิงก์+วันที่) | AGENTS.md |
| [x] 21 | UI spec §17 (Q1–Q11) | Undo-send 5 s ฝั่ง server · สี AI จาก seafoam ผ่าน contrast test · focus digest 15 นาที P1/P2 แทรกได้ · เสียง P1 ซ้ำทุก 60 วิ · portal แสดงชื่อต้น · 3 breakpoint · reject reason 9 รหัส · SLA at-risk ≤25% หรือ ≤30 นาที · severity map · spec เป็นอังกฤษ — `docs/06-UI-SPEC.md` §17 | ลด friction ทางปลอดภัย |
| [x] 22 | human verification ของ portal (R-9.1 ยกตัวอย่าง Turnstile/hCaptcha) | self-hosted: proof-of-work + honeypot + rate limit หลัง `HumanVerificationProvider` (ADR-007) · ผู้ให้บริการภายนอก = `[ASK-HUMAN]` (ปลายทาง network ใหม่ + ส่ง IP ผู้ใช้ไป vendor) | po อนุมัติปลายทางใหม่ไม่ได้ |
| [x] 23 | emergency switch Phase 1 | สองปุ่ม: "จำกัดทุก intent ≤ stage 2" (ไม่ยก 0/1 ขึ้น) และ kill switch "หยุด AI ทั้งหมด" · เปิด/ปิด = confirm + เหตุผล + audit | N3 |
| [x] 24 | T-011 Phase 0 | ยังไม่ปิดจนกว่า CI (T-014) เขียว · เจ้าของตรวจตาม checklist แล้วค่อย tag | DoD |
| [x] 26 | LINE link แล้วถือว่า "ยืนยันตัวตน" ไหม (T-103d) | LINE Login จาก portal session ที่ login แล้ว → verified · code ที่ staff เห็นแล้วบอกลูกค้า → ผูกได้แต่ **unverified** (disclosure policy §6.6 ยังบังคับ) · code ที่ส่งไป email ที่ยืนยันแล้วเท่านั้น (R-2.11c) → verified · เก็บสถานะ LINE แยกจาก `contact.verified_at` · staff ยืนยันเองเป็น action แยก lead+ พร้อมเหตุผล+audit (อนาคต) | staff ถูก social engineering ทางโทรศัพท์ได้ · ทางที่ verified ต้องพิสูจน์ว่าคุมทั้ง email และ LINE · ย้อนกลับง่าย |
| [x] 27 | KB publish ต้องแยกหน้าที่ไหม (T-107, ISO 27001 A.5.3/A.8.32) | ต้องผ่าน `in_review` เสมอ · ผู้อนุมัติต้องไม่ใช่ผู้เขียน version นั้น · break-glass เฉพาะ `head` ต้องมีเหตุผล + audit แยก + ธงรีวิวย้อนหลัง · AI draft ต้องมีคนอนุมัติที่ไม่ใช่ผู้สั่ง AI ใช้ break-glass ไม่ได้ · deprecate ไม่ต้องรอคนที่สอง | ตรง PRD R-4.1/R-4.4 · seed มีผู้อนุมัติ 4 คน · เป็นกฎใน domain ย้อนกลับง่าย |
| [ ] 28 | AC-7 gate ถูกเลี่ยงด้วยการ unassign/ลด priority ก่อน clock out | gate นับ P1/P2 ที่ผู้ใช้ unassign, ลด priority หรือโอนให้คนนอกกะในกะนั้นด้วย · ติดจริงใช้ override ได้และมี audit | ไม่ขวาง triage จริง |
| [ ] 29 | ack handoff โอนให้คนนอกกะ | P1/P2 ปฏิเสธ, P3/P4 อนุญาตพร้อมเตือน | ไม่งั้น "0" ของ AC-7 ไม่จริง |
| [ ] 30 | ค่าของ T-111 | รับ: override ใช้ `roster.manage`, P2 ต้องอยู่ใน handoff, handoff ไม่ระบุผู้รับเห็นได้ 36 ชม. ใครตอบก่อนได้, reopen ไม่ได้หลังมีคำตอบ, session เกิน 16 ชม. ไม่นับ on shift, clock-in ก่อน 60 นาที, grace 5 นาที, note 48 ชม., stay_with_last fallback load_balanced, เก็บแค่ consent ไม่เก็บพิกัด · แก้: "question" นับเป็น ack แต่ P1/P2 ไม่มีคำตอบ 30 นาทีต้องเตือน lead | ลดภาระ, ไม่ปล่อย P1 ไร้เจ้าของ |
| [ ] 31 | ค่าของ T-104 | รับ: ส่งเฉพาะ `ticket.created`, slot `default`/`urgent`, โพสต์ซ้ำไม่เกิน 2, retry 24 ชม., wait สูงสุด 10 นาที · โพสต์ล่าช้าต้องแสดงเวลาสร้าง ticket | ซ้ำดีกว่าหาย |
| [ ] 32 | KB metadata + งบ customer search | `intentTags`/`kind`/`sources` ของบทความ live ต้องมี approver · `lastVerifiedAt` ระดับ editor + audit · customer search มี daily cap แยก 20% ของ `app_ai_daily` เต็มแล้ว fallback keyword | ตรง #27, portal เปิดสาธารณะ |
| [x] 25 | T-011 Phase 1 scope | T-122 ingest + `packages/domain`, T-123 scaffolding, AC-4 → T-108e KB-author ขั้นต่ำ, เลื่อน Discord bot / Web Push / digest / crawler / bulk ไปหลัง T-113, worktree ≤ 3, Phase 1 ปิดที่ "done pending pilot" | credit จำกัด ทำของมีค่าก่อน |

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ชื่อ Watchtower · stack ADR-001 · Docker local ก่อน GCP ภายหลัง · feature set PRD v0.1 · repo public เป็นกลาง · SSO domain จาก env · secret infra ใน env / credential integration เข้ารหัสใน DB (ADR-004) · โลโก้ `docs/brand/` · default autonomy stage 2 · ภาษา (โค้ด/commit อังกฤษ, เอกสารไทย) — 2026-10-31
- 2026-11-01: ทำงานอัตโนมัติจนจบ Phase 1 (หยุดที่ T-115) · มอบอำนาจตัดสินใจให้ `po` ยกเว้นรายการ "ห้ามทำแทน" · งานขนานใน worktree แล้ว main thread ตรวจซ้ำ merge ทีละงาน · UI: ไม่ "ดู AI" (21st.dev แรงบันดาลใจ) → เป็น AI-driven workspace ไม่ใช่ mailbox → มนขึ้น น่ารักขึ้น ลด text ใช้สีและสัญลักษณ์ → แยก status กับ tag ให้ชัด · **11:35 สั่ง pause ไปทำต่อบน local**

- 2026-11-01 21:59: `47f2ae9` ปล่อยไว้ ไม่ล้าง history · ชื่อ git ต่อจากนี้ `xzozero5` (ตั้งใน `git config user.name` ของ clone นี้แล้ว clone ใหม่ต้องตั้งเอง) 28 commit เดิมปล่อยไว้ · เพิ่ม OAuth ของกล่อง Gmail ก่อน pilot · รับรายการตรวจก่อน tag และ `po` #1–27

## ต้องทำบนเครื่องเจ้าของก่อน tag `v0.0.1` (`[ASK-HUMAN]`)
1. `git fetch origin && git checkout main && git pull` → `git config core.hooksPath tools/githooks` → `pnpm install && pnpm lint && pnpm typecheck && pnpm test`
2. `docker compose up -d --build --wait` ทุก service healthy · `GET /health` ผ่าน Caddy (`:8080`) — บน cloud build image ไม่ได้ ยังไม่เคยรันจริง
3. `pnpm db:migrate && pnpm db:seed` บน volume ใหม่ (DB เก่าอาจ checksum ไม่ตรง → `docker compose down -v`)
4. `pnpm test:integration` · `pnpm test:e2e` · `pnpm test:e2e:fullstack` (Windows: `PW_CHANNEL=msedge`)
5. ลองมือ: `/portal` แจ้งเรื่อง → ticket → assign → ตอบ → ลูกค้าเห็นในหน้า tracking → resolve → อีเมลใน Mailpit `http://localhost:8025`
6. **รายการคำต้องห้ามจริงใน `.git/info/forbidden-terms`** (ข้อความสั่งงานมีแต่ placeholder) แล้วสแกน history · ตัดสินเรื่อง commit `47f2ae9` — agent ห้ามแก้ history
7. ติ๊กการตัดสินใจของ `po` (#1–27) · feedback UI T-129
8. tag เอง: `git tag v0.0.1 && git push origin v0.0.1`

## ทำต่อบน local — ขั้นตอนแนะนำ
1. `git fetch origin` แล้วดู branch `verify/t-103bd`, `wip/t-102bd`, `wip/t-107ac` (worktree ของ cloud ไม่ตามไป มีแต่ branch)
2. env: `TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1` · ตรวจด้วย `turbo run … --force` เสมอ (dist ของ `shared`/`domain` ที่ cache ไว้ทำให้ผลหลอกได้) · integration ใช้ `--concurrency=1`
3. ลำดับ: merge T-103 → Gmail (re-review + renumber) → KB (P2-A/P2-B ให้จบ + re-review) → W3: **T-108** investigator/drafter + KB-author ขั้นต่ำ, T-109 AI sidebar จริง, T-104 Discord webhook, T-105 notifications, T-110 CSAT, T-111 shifts, T-119, T-121, T-116c, T-123b, T-118 → W4: T-113 QA → T-114 security → T-125 → **หยุดที่ T-115** (`.env.example` + คู่มือ credential, `/handoff`)
4. ทุก merge: `git checkout -b verify/<task> main && git merge --no-ff wip/<task>` → renumber migration ถ้าชน (แก้ test ที่อ้างชื่อ migration ด้วย, ใช้ `migrationsAfter`) → suite เต็ม → `git checkout main && git merge --no-ff verify/<task>` → STATUS + BACKLOG + daily log → push

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] รายการตรวจก่อน tag ข้างบน
- [ ] integration จริงทุกตัว (T-115) และการทดสอบ live ครั้งแรก: Gmail (service account + domain-wide delegation, scope readonly + send, `format=raw` ใต้ readonly `[VERIFY]`, JWKS ของ push `[VERIFY]`), LINE (pricing `[VERIFY]`, อายุ retry key ~24 ชม. `[VERIFY]`), AI provider, embedding provider (ตอนนี้ mock เท่านั้น — ตั้งเป็นอย่างอื่นแล้ว boot ไม่ขึ้นโดยตั้งใจ)
- [ ] รับทราบ: approver ที่ไม่ใช่ผู้เขียนหนึ่งคนขยายผู้อ่านบทความ live ได้ทันที ไม่ต้องมีคนที่สอง (ไม่ขัดกฎ `po` #27 แต่ควรรู้)
- [ ] hosted CAPTCHA / Web Push / KB crawl live — ปลายทาง network ใหม่
- [ ] ยก autonomy ของ intent ใด ≥ 3 — ห้าม agent ทำ

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- `docker compose up` ด้วย image ที่ build เอง · Google OIDC จริง `[UNVERIFIED 60%]` · permission matrix `[ASSUMED]`
- live transport ของ Gmail/LINE ไม่เคยคุยกับปลายทางจริง (ทดสอบด้วย scripted fetch เท่านั้น)
- อายุ retry key LINE 20 ชม. `[ASSUMED]` · heartbeat Gmail 120 นาทีทำการ, full sync 7 วัน/500 ฉบับ `[ASSUMED]` · ขนาด chunk/similarity floor ของ KB `[ASSUMED]` · Thai trigram ทดสอบบน collation `en_US.utf8` เท่านั้น `[UNVERIFIED]`
- วันหยุดไทย 2026–2027 `[VERIFY]` · CSP ยัง `unsafe-inline` → T-125 · Caddy override + digest MinIO `[VERIFY]`

## วันตรวจซ้ำ
- LINE pricing/feature: ก่อนปิด T-103 · Google managed MCP: ก่อน T-203 · วันหยุดราชการไทยปีถัดไป: ธันวาคม 2026

## ปิด session (local, 2026-11-01 12:47)
- เครื่อง: Windows · compose postgres/redis/minio/mailpit รันอยู่ · `.git/info/forbidden-terms` มีรายการจริงแล้ว hook ใช้ได้ (ยังไม่ได้สแกน history)
- **เว็บยังไม่ได้เปิดให้ดู** ที่เจ้าของถาม: รอจังหวะไม่มี test แล้ว `pnpm db:migrate && pnpm db:seed && pnpm dev` ที่ `http://localhost:3000`
- ยังไม่ได้เริ่ม: T-108, T-109, T-105, T-110, T-119, T-121, T-116c, T-123b, T-118, T-122f, T-113, T-114, T-125, T-115
- scan N1 ทั้ง diff ของ T-107 ถูก `guard.py` บล็อกตอน review จึงไม่ได้รัน ไม่ได้อ้อม · อ่าน `examples/kb` แล้วไม่พบชื่อองค์กรจริง
- บทเรียน: gate ต้องใส่ `--continue` ไม่งั้น turbo หยุดงานอื่นตอนตัวแรกตก · อย่ารัน integration พร้อม agent ที่รัน test หนัก
