# STATUS — สถานะโปรเจกต์ (main thread อัปเดตทุกครั้งที่ปิด task)

รูปแบบ entry: `## YYYY-MM-DD HH:MM (Asia/Bangkok) — <ใคร/agent> — <phase/task>` แล้วตามด้วย ทำอะไร / ไฟล์ที่แตะ / test / ค้าง / ไม่ยืนยัน
snapshot สั้นสำหรับ cold start อยู่ที่ `HANDOFF.md` — ไฟล์นี้คือ log ต่อ task + open questions

## สถานะปัจจุบัน
| Phase | สถานะ (2026-10-31) | ค้าง |
|---|---|---|
| 0 Foundation | 🔄 กำลังทำ (cloud session) | T-006 → T-012, T-013 |
| 1 Inbox + AI 0–2 + Shifts | ⬜ | — |
| 2 Reliability + Usage | ⬜ | — |
| 3 Autonomy + Learning | ⬜ | — |
| 4 Mobile + Scale | ⬜ | — |

- Test ล่าสุด: ยังไม่มีโค้ด
- Blockers: ไม่มี · `[ASK-HUMAN]` ค้าง: credential, PRD §16

## Open questions / `[UNVERIFIED]` / `[ASSUMED]` ที่ยังค้าง
- PRD §16 (Cloud SQL replica, GCP projects, mailbox + delegation, LINE plan/volume, Discord, ทีม/กะ, SLA tiers, AI provider/budget) — ข้อ 9 ปิดแล้ว: public, Apache-2.0, เป็นกลางไม่ผูกกับองค์กรใด `[CONFIRMED 2026-10-31]`
- `[CONFIRMED 2026-10-31]` Google Workspace domain ของ SSO อ่านจาก env ค่าตัวอย่าง `example.com`
- `[ASSUMED]` งบ `build_ai` $10/session วัดไม่ได้บน Max plan จึงดู % plan limit แทน
- `docs/brand/watchtower-logo.svg` รุ่น 22:09 สีตรงกับ PNG แล้ว แต่รูปทรงเป็นแบบย่อ: ไม่มีหน้าต่างบนตัวประภาคาร, ซี่ราวระเบียง, ซี่กรอบโคมไฟ และคลื่นคนละทรง (ตรวจจาก source) → UI ยังใช้ PNG เป็นโลโก้ และใช้ hex ใน `docs/brand/README.md` เป็น token
- `[CONFIRMED 2026-10-31]` secret ของ infra อยู่ใน env เท่านั้น, credential ของ integration อยู่ใน env หรือ DB เข้ารหัส ตั้งผ่าน admin UI (ADR-004, งาน T-116) · `docs/04-ARCHITECTURE.md` §5 ต้องปรับถ้อยคำตามหลัง T-004
- `[ASK-HUMAN]` deploy ขึ้น GCP อยู่ใน Post-MVP แต่ pilot T-115 ต้องมีข้อมูลจริงและ webhook สาธารณะ → เสนอย้ายมาก่อน T-115, ให้ `po` พิจารณาใน T-011
- `WT_MAIN_THREAD=1` ใน `.claude/settings.local.json` (เจ้าของตั้งเอง) ปลดการป้องกัน HANDOFF/STATUS/BACKLOG ให้ sub-agent ด้วย → main thread ตรวจ diff ของสามไฟล์นี้หลัง agent ทุกตัว; `guard.py` ควรแยก sub-agent จาก hook input แทน env (เสนอ ยังไม่ทำ)
- LINE TH pricing/quota `[VERIFY]` · LINE mark-as-read `[VERIFY]` · Google managed MCP availability `[VERIFY]`
- วันหยุดราชการไทย 2026–2027 สำหรับ business calendar `[VERIFY]` (T-008)
- งบ API: ยังไม่ตั้ง (`config/budgets.yaml` ค่า default `[ASSUMED]`)

## กติกาจากบทเรียน (เติมเมื่อเจอ)
- (ยืมจากโปรเจกต์ก่อน) ตรวจซ้ำรายงาน agent ก่อน commit · ห้าม `git stash/checkout` ขณะ agent แก้ไฟล์เดียวกัน · test ห้ามเขียนลง data จริง · ไฟล์ที่มี backslash แก้ด้วย Edit tool · ห้ามพิมพ์ secret ออก stdout แม้เพื่อตรวจ
- `TZ=Asia/Bangkok date` บน Git Bash (Windows) ให้เวลา GMT ผิด 7 ชม. → ใช้ `TZ=ICT-7 date` `[TESTED]`
- `grep -i` (โดยเฉพาะ `-F -i`) abort บน Git for Windows เครื่องนี้ → lowercase ด้วย `tr` แล้วค่อย match และ script ตรวจความปลอดภัยต้อง block เมื่อ grep error `[TESTED]`
- บรรทัดใน `.gitignore` ห้ามมี comment ต่อท้าย pattern

## Log

## 2026-11-01 07:10 (Asia/Bangkok) — frontend-dev + main thread — T-007 ปิด (หน้า portal)
- ทำอะไร: `/portal` (ฟอร์มแจ้งเรื่อง, PoW ใน Web Worker ด้วย `crypto.subtle` + fallback, honeypot ซ่อน, รอ `minFillSeconds`, จัดการ 400/429), `/portal/submitted`, `/portal/tickets/[key]` (อ่าน token จาก fragment แล้วลบด้วย `replaceState`, ส่ง `X-Portal-Token`, timeline สาธารณะ, ตอบกลับ, สถานะแบบคำลูกค้า, merged → ลิงก์ ticket หลัก, ลิงก์หมดอายุ → ขอใหม่) · `/portal/*` no-store + no-referrer · `sw.js` ข้าม `/portal` และ `/v1` · มุมมอง client ใน workspace ใช้ `customerStatus()` (P2-4 จาก review T-006) · i18n แยกไฟล์ `portal.{en,th}.ts` · `SessionProvider` ไม่เรียก session ใต้ `/portal`
- test: main thread รันเองบน main + `wip/t-007-web`: lint, typecheck, test (web 425 + ทุก package) ผ่าน · e2e 95 ผ่าน (portal 28 รวม PoW จริง, axe light/dark) `[TESTED]` · main thread แก้ชื่อบุคคลจริงในข้อมูลทดสอบเป็นชื่อสมมติ (N1)
- ไม่ยืนยัน: Web Worker บน Safari/Firefox · full-stack กับ API จริง (T-009) `[UNVERIFIED]` · header ของ portal ยังใช้สีพื้นเดิม รอ token ใหม่จาก T-124

## 2026-11-01 06:15 (Asia/Bangkok) — backend-dev + main thread — T-007 ฝั่ง API/worker (หน้าเว็บยังทำอยู่)
- ทำอะไร: ADR-007 (Proposed) human verification แบบ self-hosted: PoW SHA-256 แบบ HMAC-signed + single-use ใน Redis, honeypot `website`, เวลากรอกขั้นต่ำ, rate limit ต่อ IP/email/org (429 + audit) ไม่มี dependency ใหม่ · endpoint public `/v1/portal/{challenge,tickets,tickets/:key,tickets/:key/replies,track/resend}` + staff revoke · tracking token HMAC เก็บแค่ hash, TTL 90 วัน `[ASSUMED]`, header `X-Portal-Token`, ทุกความล้มเหลวตอบ 401 เดียวกัน (กัน enumeration) · อีเมลยืนยัน/ตอบกลับ/สถานะ/merge (R-1.5) ผ่าน outbox → worker → SMTP (Mailpit) TH/EN · migration `0004_portal`
- test: main thread รันเองบน main + `wip/t-007-api`: lint, typecheck, test (api 144, shared 122, worker 28 …) ผ่าน · `test:integration` api 351 (portal 36), db 101, worker 16 ผ่าน `[TESTED]`
- ค้าง: หน้า portal (web) — `frontend-dev` ทำใน `wip/t-007-web` · security review ใน T-010
- ไม่ยืนยัน `[ASSUMED]`: map category→intent, urgency→priority (ผู้ส่งที่ไม่รู้ org จำกัดไม่เกิน P2), ความยาก PoW 18 bit (ยังไม่วัดบนมือถือ), ตัวเลข rate limit, ภาษาเริ่มต้น EN · ไม่ได้ทดสอบ HTML email กับ mail client จริง · ลิงก์ติดตามอยู่ใน `outbox.payload` ระหว่าง pending (→ T-010)

## 2026-11-01 05:30 (Asia/Bangkok) — frontend-dev + main thread — T-120 ปิด
- ทำอะไร: ปิด single-key shortcut ได้ (WCAG 2.1.4) · ล้าง cache + draft ตอน session หมดอายุผ่าน routine เดียวกับ sign out, query key ผูก user · keyboard map กรองตาม permission · F6 / Alt+1..3, `[` `]`, `g q`, Enter/O · < 768 px เป็นแท็บ · throttle live region 30 s · status copy key camelCase · queue เป็น listbox + `aria-selected` · หัว ticket ไม่ถูกตัดตอนเปิด, แถบบนไม่ล้นที่ 768–1023 px (จากภาพที่ส่งเจ้าของ)
- test: main thread รันเอง: lint, typecheck, test (web 318, ui 125 + ทุก package), e2e 67 ผ่าน `[TESTED]`
- review: เป็นการแก้ finding ของ `po` จาก T-006 → ตรวจรวมใน T-011 (ไม่เรียก `po` แยกเพื่อประหยัด credit)
- ไม่ยืนยัน: remap shortcut ยังไม่มี (ปิดได้อย่างเดียว) `[ASSUMED]` ว่าพอสำหรับ 2.1.4 · ยังไม่ได้ทดสอบกับ screen reader จริงและ iOS/Android จริง

## 2026-11-01 04:20 (Asia/Bangkok) — backend-dev + main thread — T-013 + T-008 ปิด
- ทำอะไร (T-013): audit `contact.create` ตอนสร้าง contact อัตโนมัติ · child ที่ย้ายตอน merge ได้ event `ticket.reparented` + audit `ticket.reparent` · `@AuditPiiRead` บน `GET /v1/tickets` · `q` ขั้นต่ำ 2 ตัว · ลบ queue/contact ที่ยังถูกอ้าง → 409 (FK RESTRICT) · migration `0003_followups_outbox`: `org_tier` แทน CHECK, `message` ไม่มี DELETE และ UPDATE ได้เฉพาะ `delivery_status, body_redacted`, index FK, ตาราง `outbox` · transactional outbox: api เขียนแถวใน tx เดียวกับงาน, relay อยู่ใน worker (SKIP LOCKED, backoff, dead หลัง 30 ครั้ง) · ADR-006 (Proposed) · `TICKET_KEY_PREFIX` ตั้งได้ (default `OPS`)
- ทำอะไร (T-008): `pnpm db:seed` idempotent + additive, ปฏิเสธ `NODE_ENV=production` ถ้าไม่มี `--allow-production` · calendar Bangkok + 24×7, วันหยุดไทย 2026–2027 จาก `examples/calendars/` (`[VERIFY]` ทุกวัน, วันตามจันทรคติ/วันชดเชย `[UNVERIFIED]`), SLA จาก `examples/sla/` (po #8, ตัวเลขอื่น `[ASSUMED]`), 3 orgs (gold/silver/standard), contacts 8, staff 2 head/2 lead/4 agent + client 1 คนต่อ org, 3 queues, intents 11 ตัว stage 2, 30 tickets ครบทุกสถานะ (TH/EN, internal note) · ยังไม่ seed กะ (ยังไม่มีตาราง → T-111)
- ไฟล์ที่แตะ: `packages/db/{migrations/0003_*,src/outbox.ts,src/seed/**,src/seed-cli.ts,README.md}`, `apps/worker/src/outbox-relay.ts`, `apps/api/src/{orgs,tickets,team-queues,auth,config}/**`, `packages/shared/src/{ticketing,directory,seed-data}.ts`, `examples/{calendars,sla}/`, `docs/decisions/ADR-006-outbox.md`, `docs/04-ARCHITECTURE.md` §2/§11, `.env.example`, `docker-compose.yml`
- test: main thread รันเองบน main + wip/t-013: lint, typecheck, test (shared 110, db 47, api 113, worker 20, web 252, ui 125, boundaries 94) ผ่าน · `test:integration` db 98 (3 รอบติด หลังแก้ assertion ที่ไปเจอ "502" ใน UUID สุ่ม), api 315, worker 15 ผ่าน · e2e 53 ผ่าน `[TESTED]` · main thread แก้เพิ่ม: comment ใน `tickets.service.ts` ให้ตรง ADR-006, `seed-cli` normalise prefix ด้วย `ticketKeyPrefixSchema`
- review: `po` ACCEPT WITH FOLLOW-UPS ไม่มี P0 · P1 = เอกสาร (entry นี้) + ADR-006 ต้องให้ `architect` ตรวจก่อน Accepted (ทำใน T-010 ร่วมกับ `security-reviewer`) + api integration (ผ่าน 315 แล้ว) · P2/P3 → T-010, T-102, T-111, T-121 (ใหม่)
- ไม่ยืนยัน: วันหยุดเทียบประกาศ ครม. ยังไม่ได้ทำ `[UNVERIFIED 70%]` · พฤติกรรม `jobId` ของ BullMQ `[VERIFY]` · outbox เป็น at-least-once อีเมลอาจซ้ำในหน้าต่างเล็ก
- ข้อสังเกต: เปลี่ยน FK เป็น RESTRICT ใน `0003` — DB local ของเจ้าของที่มีข้อมูลทดสอบจะ migrate ได้ตราบที่ไม่มีแถวอ้างค่าที่ผิด FK ใหม่ (`org_tier`) `[UNVERIFIED 80%]`

## 2026-11-01 03:10 (Asia/Bangkok) — frontend-dev + main thread — T-006 ปิด
- ทำอะไร: workspace three-pane จริง (queue + filters/saved views ใน browser, J/K, pill "N new" จาก realtime, timeline แยก public/internal, composer + template/ตัวแปร + reply & set status, ticket detail/edit, AI sidebar placeholder, keyboard map `?`), login (SSO จาก provider config, magic link, break-glass, dev-login เฉพาะ mock + non-production), `/login/magic` อ่าน token จาก fragment, refresh single-flight + Web Locks ข้ามแท็บ (ADR-005), WS client backoff/4401/4403/4429, PWA manifest + `sw.js` (same-origin GET, ไม่ cache HTML/API, offline page), `packages/ui` เพิ่ม Input/Select/Textarea/Skeleton/Alert · layout 3 ระดับตาม UI spec §3.2
- ไฟล์ที่แตะ: `apps/web/**`, `packages/ui/src/components/*`
- test: main thread รันเองบน main + wip/t-006: lint, typecheck, test (web 252, ui 125 + ทุก package) ผ่าน · e2e 53 ผ่านด้วย API จำลอง (`page.route`/`routeWebSocket`) หลังแก้ test J/K ที่ flaky (repeat-each=4 → 124/124) `[TESTED]`
- review: `po` merge ได้ ไม่มี P0 · P1 = WCAG 2.1.4 (ปิด single-key shortcut ไม่ได้) → T-120 ก่อน T-011 · P2/P3 → T-120, T-007, T-105, T-119, T-102, T-111
- ค้าง: T-120
- ไม่ยืนยัน: ยังไม่ได้ทดสอบกับ API จริง (T-009) `[UNVERIFIED]` · Web Locks ข้ามแท็บทดสอบด้วย lock manager จำลองเท่านั้น `[UNVERIFIED]` · SLA at-risk ฝั่ง UI ใช้ due − createdAt ไม่ใช่ business time `[ASSUMED]`
- หมายเหตุ: `guard.py` บล็อกคำสั่ง shell ที่มีคำว่า `set` ตามด้วยคำว่า token ในข้อความเอกสาร (false positive ของกฎ N1) → เขียน entry นี้ด้วย Edit tool แทน ไม่ได้แก้ guard

## 2026-11-01 02:20 (Asia/Bangkok) — ux-designer + po + main thread — T-101 UI spec
- ทำอะไร: `ux-designer` เขียน `docs/06-UI-SPEC.md` (§0–§17, ชี้ token ในโค้ดแทนการคัดลอกค่า) ล่วงหน้าเพื่อให้ T-006/T-007 และ Phase 1 ใช้อ้างอิง · `po` ตัดสิน open questions §17 (Q1–Q11) แทนเจ้าของ `[ASSUMED]` · main thread แก้ §6.5 (cap ไม่ใช่ set stage 2), §10 (human verification self-hosted, สถานะ merged ที่ลูกค้าเห็น)
- ไฟล์ที่แตะ: `docs/06-UI-SPEC.md`, `HANDOFF.md` (PO ตัดสิน #21–23), `docs/BACKLOG.md` (T-101, T-007)
- test: เอกสาร — prettier ผ่าน, ตรวจ forbidden terms ผ่าน
- ข้อเบี่ยง `[ASSUMED]`: R-9.1 ยกตัวอย่าง Turnstile/hCaptcha แต่ทำแบบ self-hosted เพราะผู้ให้บริการภายนอกเป็นปลายทาง network ใหม่ (`[ASK-HUMAN]`)
- ไม่ยืนยัน: ค่า severity ของ GCP Monitoring `[VERIFY]` · library PoW ยังไม่เลือก

## 2026-11-01 01:55 (Asia/Bangkok) — backend-dev + main thread — T-005 ปิด
- ทำอะไร: ตรวจงานค้างบน `wip/t-005` ด้วย `explorer` (agent เดิมถูกหยุดก่อนรายงาน) → ครบ schema/REST/WS/client scoping/`CLIENT_ORG_RESOLVER`/FK `users.org_id` · `backend-dev` แก้ส่วนที่ขาด: SLA recompute ไม่นับเวลา pause, `deliveryStatus` ตาม channel, round-robin ไม่ข้ามคน, event `ticket.reopened`/`sla.recalculated`, `GET /v1/tickets/:id/duplicates` (R-1.5), CRUD test ของ SLA/calendar/queue · main thread แก้ cleanup ของ test DB (57P01) และ test ที่ commit คำต้องห้ามไว้ในโค้ด
- ไฟล์ที่แตะ: `packages/db/migrations/0002_ticketing*.sql`, `packages/db/src/{schema/ticketing.ts,seed/intents.ts,testing.ts}`, `packages/shared/src/{sla,ticketing,realtime,directory,channels,common}.ts`, `apps/api/src/{orgs,intents,sla,team-queues,tickets,realtime}/**`, `examples/intents/`, `docs/04-ARCHITECTURE.md` §7, §9, §11
- test: main thread รันเอง: lint, typecheck, test (api 110, shared 106, db 19, worker 19, ui 121, web 60, boundaries 94, ai 1, channels 2) ผ่าน · `test:integration` api 285, db 52, worker 10 ผ่านบน compose Postgres+pgvector/Redis · e2e smoke 22 ผ่าน `[TESTED]`
- review: `po` ACCEPT WITH FOLLOW-UPS (ไม่มี P0, P1 = เอกสาร DoD ซึ่ง entry นี้ปิดแล้ว) · `architect` merge ได้ ไม่มี P0/P1 · P2/P3 → T-013, T-119, T-007, T-111
- การตัดสินใจ (main thread): search ใช้ trigram `ILIKE` ไม่ใช้ tsvector (Postgres FTS ตัดคำไทยไม่ได้) · attachment text ค้นหลัง T-102 · R-1.7 load-balanced/stay-with-last-handler อยู่ T-111 · เปลี่ยน calendar ไม่คำนวณ due ของ ticket ที่เปิดอยู่ใหม่ `[ASSUMED]` · ข้อความขาเข้า `deliveryStatus = not_applicable`
- ค้าง: T-013 (follow-up ก่อน T-007) · DB local ของเจ้าของที่ apply `0002` เวอร์ชันเก่าไปแล้ว: `0002` ไม่ได้แก้ใน session นี้ จึงไม่ต้อง reset ถ้า checksum ตรงกับ `wip/t-005` เดิม `[UNVERIFIED 80%]`
- ไม่ยืนยัน: performance trigram กับข้อมูลมาก `[UNVERIFIED 70%]` · locale DB บน Cloud SQL ต้องไม่ใช่ `C` `[ASSUMED]` · permission ของ `queue/intent/workflow.manage` ไม่อยู่ใน PRD §2.2 `[ASSUMED]`
- ข้อสังเกต N1: commit `47f2ae9` (ประวัติของ `wip/t-005`) มีคำในรายการ test ที่บอกใบ้ธุรกิจของ deployment หนึ่ง แก้แล้วใน commit ถัดไป แต่ประวัติยังอยู่เพราะห้ามแก้ history `[ASK-HUMAN]` ถ้าต้องการล้าง

## 2026-11-01 00:55 (Asia/Bangkok) — main thread — cloud session: environment check
- ทำอะไร: ตรวจเครื่องมือบน cloud session ตามคำสั่งเจ้าของก่อนทำต่อ
- ผล `[TESTED]`:
  - Docker: CLI 29.9 มี แต่ daemon ไม่ได้รันตอนเริ่ม และ `service docker start` ล้ม (ulimit) → สั่ง `dockerd` ตรงได้ · Docker Hub ตอบ `429 Too Many Requests` เป็นช่วง ๆ ต้อง pull ซ้ำทีละ image
  - Postgres (pgvector): OS มี Postgres 16 แต่ไม่มี extension pgvector → ใช้ image `pgvector/pgvector:0.8.7-pg16-trixie` ผ่าน compose ได้
  - Redis: OS มี `redis-server` · ใช้ `redis:7.4-alpine` ผ่าน compose
  - Playwright: มี Chromium revision 1243 ที่ `/opt/pw-browsers` แต่ `@playwright/test` ที่ pin ต้องการ 1248 → เพิ่ม `PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium` ใน `apps/web/playwright.config.ts` · e2e smoke 22 เคสผ่านบน Linux ครั้งแรก
- คำสั่งเตรียมบน cloud: `(nohup dockerd > /tmp/dockerd.log 2>&1 &)` → `docker compose up -d --wait postgres redis minio minio-init mailpit`
- ข้อขัดกันที่บันทึกตามคำสั่งเจ้าของ: `docs/00-START-HERE.md` บอกว่า `po` "เสนอ ไม่ตัดสินแทนเจ้าของ" แต่ session นี้เจ้าของมอบอำนาจให้ `po` ตัดสินแทน (คำถามก่อน phase, scope, เอกสารขัดกัน, PRD §16) โดยทุกข้อติด `[ASSUMED]` และอยู่ใน `HANDOFF.md` หัวข้อ "PO ตัดสินแทนเจ้าของ" · branch: ระบบของ session กำหนด branch `claude/pensive-feynman-cazrkg` แต่เจ้าของสั่ง merge เข้า `main` และเก็บงานไม่ผ่านไว้ที่ `wip/<task>` → ทำตามเจ้าของ และ sync branch ของ session ให้เท่ากับ `main`
- รายการคำต้องห้ามที่เจ้าของจะวาง ไม่มาในข้อความ (เหลือแต่ placeholder) → ตั้ง `.git/info/forbidden-terms` ด้วยคำที่ main thread อนุมานเองไว้ก่อน (local ไม่ commit) และตรวจ diff ด้วยตาตาม N1 · `[ASK-HUMAN]` เจ้าของใส่รายการจริง

## 2026-10-31 22:05 (Asia/Bangkok) — main thread — Brand Design
- ทำอะไร: ออกแบบ Brand Identity และ Logo ประจำโปรเจกต์ Watchtower ตามคำสั่งเจ้าของ คัดเลือกและปรับแต่งรูปทรง Sea Lighthouse จนสรุปที่ Option 3B-3 (Midnight Navy Dome Roof + Warm Coral Red & Ivory Body Stripes) สบายตา อบอุ่น และสื่อถึงการเฝ้าระวัง Tech Ops
- ไฟล์ที่แตะ: `docs/brand/*`, `docs/brand/README.md`, `HANDOFF.md`, `logs/daily/2026-10-31.md`
- test: สร้างไฟล์ภาพความละเอียดสูง Master PNG (`watchtower-logo.png`), App Icon 512x512 (`watchtower-icon.png`), Favicon 64x64 (`favicon.png`) และ Vector SVG ทั้งหมดพร้อมใช้งาน `[TESTED]`
- ปรับปรุง 22:09: วัดค่าสีจริงจาก PNG ด้วย Pillow สรุปโค้ดสีตรงเป๊ะ (#E5594A, #F7F0D4, #1D2739, #B2E4D8), เขียน `watchtower-logo.svg` ใหม่ให้ตรงกับ PNG 100% (ลบ badges/คำโปรยออกหมด, ฟอนต์สีเดียว #363839), บันทึก Alert Discipline (สีแดงใช้เฉพาะโลโก้ ปุ่มหลักใช้ Midnight Navy เพื่อไม่ชนกับ P1 Alert)
- ค้าง: —
- ไม่ยืนยัน: —


## 2026-11-01 00:25 (Asia/Bangkok) — main thread — พักงาน, T-005 ยังไม่เสร็จ
- ทำอะไร: เจ้าของสั่งพักเพื่อย้ายไป cloud session จึงหยุด `backend-dev` กลางคัน เก็บงานทั้งหมดบน branch `wip/t-005` แล้ว push · หยุด compose โดยไม่ลบ volume
- ไฟล์ที่แตะ: `HANDOFF.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `logs/daily/2026-11-01.md` บน `main` · โค้ด T-005 บน `wip/t-005`
- test บน `wip/t-005`: lint, typecheck, unit test ผ่าน `[TESTED]` · `test:integration` และ e2e ยังไม่ได้รัน
- ค้าง: ตรวจข้อส่งมอบ T-005 ที่ยังขาด (agent ถูกหยุดก่อนรายงาน)
- ไม่ยืนยัน: cloud session มี Docker หรือไม่ `[VERIFY]`

## 2026-10-31 23:35 (Asia/Bangkok) — backend-dev + main thread — T-004
- ทำอะไร: Google OIDC + PKCE พร้อม mock mode, magic link, break-glass, session JWT + refresh rotation, CSRF สามชั้น, RBAC deny-by-default + permission table, audit log immutable แบบ partition, migration `0001`, ADR-005 (Proposed รอ T-010)
- ไฟล์ที่แตะ: `apps/api/src/{auth,audit,rbac,users,queue,cli,testing}`, `apps/worker/src/{mailer,processors}`, `packages/db`, `packages/shared/src/{auth,rbac,config,queues}`, `docker-compose.yml`, `.env.example`, `docs/04-ARCHITECTURE.md`
- test: main thread รันซ้ำแบบ `--force`: lint, typecheck, test (api 80, worker 19, db 11, shared 39, web 60, ui 121), build ผ่าน; `test:integration` api 155, db 24, worker 9 ผ่าน; ลองแก้ `audit_log` บน DB จริงด้วย owner และลบด้วย `watchtower_app` ถูกปฏิเสธ แถวยังอยู่ `[TESTED]`
- ค้าง: ทดสอบ magic link ครบวงจรผ่าน `curl` ไม่ได้รัน (`guard.py` บล็อกบรรทัดที่มีคำว่า token) แต่มี integration test ครอบ และจะอยู่ใน e2e T-009 · ลบ token หมดอายุ → T-117
- ไม่ยืนยัน: flow กับ Google จริง ทดสอบกับ fake OIDC เท่านั้น `[UNVERIFIED 60%]` · permission matrix `[ASSUMED]` · web/api same-site `[ASSUMED]` · production บังคับต้องมี Google OIDC จึงยังไม่รองรับองค์กรที่ไม่ใช้ Google `[ASSUMED]`
- ข้อมูลทดสอบ: `audit_log` ของ stack หลักมีแถวจากการทดสอบ 9 แถวที่ลบไม่ได้โดยการออกแบบ (DB local เท่านั้น)

## 2026-10-31 22:32 (Asia/Bangkok) — backend-dev + main thread — T-002
- ทำอะไร: `apps/api` (health, Zod config, OpenAPI, pino, OTel, CORS allow-list), `apps/worker` (BullMQ + health), `packages/db` (migration runner แบบ up/down + checksum), `docker-compose.yml`, Dockerfile ของ api/worker, `Caddyfile`, `.env.example` ฉบับครบ, ADR-003
- ไฟล์ที่แตะ: ตามรายการใน merge `cc220fb`
- test: main thread รันซ้ำหลัง merge: `--force` lint/typecheck/test/build ผ่าน; `docker compose up -d --wait` ครบทุก service healthy รวม web; `/health` ของ web, api, worker = 200; caddy `/` และ `/api/health` = 200, `/metrics` ผ่าน caddy = 404; CORS ตอบเฉพาะ origin ของ `APP_URL`; ทุก port bind `127.0.0.1`; `test:integration` 19 เคส ผ่าน; e2e 22 เคส ผ่าน `[TESTED]`
- ค้าง: worker ยังไม่มี OTel/`/metrics` · CORS ยังไม่เปิด `credentials` ต้องกำหนดพร้อม CSRF ใน T-004
- ไม่ยืนยัน: image `pgsty/minio` เป็นของบุคคลที่สาม (ADR-003) `[VERIFY]` · ชื่อ metric ไม่มี suffix `_seconds`

## 2026-10-31 22:25 (Asia/Bangkok) — frontend-dev + main thread — T-003
- ทำอะไร: `apps/web` Next.js + Tailwind + TanStack Query, `/health`, API URL ตอน runtime, design tokens ใน `packages/ui` พร้อม contrast test, three-pane เปล่า, command palette stub, i18n TH/EN, Dockerfile, ใช้โลโก้ PNG และ palette จาก `docs/brand/README.md`
- ไฟล์ที่แตะ: `apps/web/**`, `packages/ui/**`, `eslint.config.mjs`, root `package.json`, `turbo.json`, `.prettierignore`, `pnpm-lock.yaml`
- test: main thread รันซ้ำหลัง merge แบบ `--force`: lint, typecheck, test (web 60, ui 121, shared 6, channels 2, db 1, ai 1), build, e2e 22 passed ด้วย `PW_CHANNEL=msedge`; เปิดหน้าจอจริงดู dark/light + ⌘K ถูกต้อง `[TESTED]` · docker image รายงานโดย frontend-dev ยังไม่ได้ตรวจซ้ำ (จะตรวจตอน compose ครบหลัง T-002)
- ค้าง: PWA manifest/service worker ยังไม่ทำ ตาม ADR-001 ต้องมี → ย้ายไป T-006 · ไม่มี `eslint-plugin-jsx-a11y` เพราะ peer ไม่รองรับ ESLint 10 ใช้ axe ใน e2e แทน
- ไม่ยืนยัน: สี link/focus และ surface ที่ palette ไม่ได้กำหนด `[ASSUMED]` · ภาษาเริ่มต้น `en` `[ASSUMED]` · e2e ใช้ Edge บนเครื่องนี้ CI ต้อง `playwright install` (ดาวน์โหลดจาก `cdn.playwright.dev` ตอน dev/CI เท่านั้น) และยังไม่ได้ทดสอบบน Linux `[UNVERIFIED 80%]`

## 2026-10-31 21:50 (Asia/Bangkok) — architect + main thread — T-001
- ทำอะไร: monorepo pnpm + Turborepo, placeholder 5 package, boundary lint, `docs/04-ARCHITECTURE.md` ร่าง, ADR-002
- ไฟล์ที่แตะ: root config, `tools/eslint/`, `packages/*`, `docs/04-ARCHITECTURE.md`, `docs/decisions/ADR-002-boundary-enforcement.md`, PRD §12
- test: main thread รันซ้ำแบบ `--force` lint/typecheck/test/build และยืนยันว่าไฟล์ละเมิดใน `packages/ai` ทำ lint fail `[TESTED]`
- ค้าง: `pnpm test:e2e` ยังไม่มี test จริง (T-003) ห้ามนับเป็นผ่าน
- ไม่ยืนยัน: boundary test บน Linux/CI `[UNVERIFIED 90%]` · `eslint-config-next` กับ ESLint 10 `[UNVERIFIED 70%]` · drizzle-kit กับ `PARTITION BY` `[VERIFY]`
- `[ASK-HUMAN]` Turbo telemetry เปิดอยู่บนเครื่อง dev: เจ้าของปิดเองด้วย `turbo telemetry disable`; CI/Docker ตั้ง `TURBO_TELEMETRY_DISABLED=1`

## 2026-10-31 21:35 (Asia/Bangkok) — main thread — T-000
- ทำอะไร: git init ต่อจาก `origin/main` (`f848253`, LICENSE Apache-2.0) ให้ push เป็น fast-forward, เปิด hooks, แก้ `.gitignore`, เพิ่ม `.gitattributes` (LF), ทำเอกสารให้เป็นกลางตามคำสั่งเจ้าของ, แก้ pre-commit ให้ fail closed
- ไฟล์ที่แตะ: `.gitignore`, `.gitattributes`, `tools/githooks/pre-commit`, `AGENTS.md`, `FIRST_PROMPT.md`, `HANDOFF.md`, `docs/01-PRD.md` §0/§1/§2/§3/§4/§13/§16/§17, `docs/00-START-HERE.md`, `docs/claude-project-instructions.md`, `.claude/agents/{po,security-reviewer,integration-engineer}.md`
- test: pre-commit 6 กรณีใน scratch repo ผ่าน `[TESTED]`
- ค้าง: —
- ไม่ยืนยัน: intent taxonomy ใหม่ใน PRD §3.1 `[ASSUMED]`

## 2026-10-31 21:05 (Asia/Bangkok) — Claude (claude.ai planning session) — Pre-Phase 0
- ทำอะไร: research, PRD v0.1, ชุดไฟล์วิธีทำงาน (AGENTS, CLAUDE, START-HERE, BACKLOG, HANDOFF, templates, agents, commands, hooks, ADR-001, FIRST_PROMPT)
- ไฟล์ที่แตะ: ทั้งชุด kickoff
- test: —
- ค้าง: T-000
- ไม่ยืนยัน: ดูหัวข้อ Open questions
