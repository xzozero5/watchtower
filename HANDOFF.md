# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-03 ~02:30 (เวลากรุงเทพ) โดย Claude Code (main thread, เครื่อง local Windows) — **POC ต่อของจริง + role-play QA + แก้ตาม feedback ทั้งคืน** (เจ้าของเข้านอน ~00:00 และมอบให้ `po` ตัดสินทุกเรื่อง)
> ฉบับก่อน `docs/handoff-archive/HANDOFF-2026-11-02-1505-v0.1.0.md` · log ต่อ task `docs/STATUS.md` · รายชั่วโมง `logs/daily/2026-11-02.md`, `logs/daily/2026-11-03.md`

## อ่านก่อน (2 นาที)
- **`main` ในเครื่องนำ `origin/main` อยู่ ~30 commit** (push ตอนจบ session นี้ถ้า gate ผ่าน — ดู §สถานะ) · tag `v0.1.0` ยังเป็นของเมื่อวาน
- **ต่อของจริงแล้วบางส่วน (POC บน localhost):** Gmail จริง (OAuth + Pub/Sub push ผ่าน tunnel), AI จริงผ่าน `claude -p` ของเจ้าของ (provider `claude-cli`, ADR-017) · ยังเป็น mock: LINE, Discord, SMTP ออกจริง (ไป Mailpit), GCP logs/BigQuery
- **UI rework "Soft Beacon" อยู่ branch แยก `claude/ui-rework-bbf2dc` ยังไม่ merge** — รอเจ้าของสั่ง merge (เจ้าของเลือก Soft Beacon เองใน session นั้น) · branch นั้น merge `main` ล่าสุดที่ `52d30c2` ต้อง `git merge main` อีกรอบก่อน (portal, ticket-details, e2e เปลี่ยนหลังจากนั้น)
- คำตัดสิน 5 ข้อ (QA-30, QA-02/03, QA-08, QA-20, QA-23) **po ตัดสินแทนเจ้าของ** ตามที่เจ้าของมอบ → `docs/qa/2026-11-02-roleplay-triage.md` §คำตัดสิน

## สถานะ
- **Gate บน `main` ล่าสุด (main thread รันเอง, service ทิ้งได้):** ดู STATUS entry 2026-11-03 สำหรับตัวเลขสุดท้ายของ `313c9ed` · ก่อน T-140: lint/typecheck/unit ผ่าน · integration api 1092, db 389, domain 454, worker 232 · web e2e 173/173 · full-stack 38/38
- **Stack จริงบนเครื่องเจ้าของ:** compose project `watchtower` (`docker compose --env-file D:\Works\secret\watchtower.env up -d --wait --build`) · dev login เปิด (Google sign-in ปิดใน env เพราะบัญชี gmail.com ไม่ใช่ Workspace) · demo stack `wt-demo` ยังรันอยู่ (port 3xxxx)
- **Process บนเครื่องที่ session นี้เปิดไว้ (หายเมื่อปิด session):** bridge `claude -p` ที่ 127.0.0.1:4317 (`node --env-file=D:\Works\secret\watchtower.env tools/claude-cli-bridge/server.mjs`), ตัวกรอง push-only ที่ 127.0.0.1:4318 (scratchpad ของ session — **ต้องมีทุกครั้งที่เปิด tunnel** เพราะ dev login เปิดอยู่) · tunnel cloudflared เจ้าของรันเองใน PowerShell → URL เปลี่ยนทุกครั้ง ต้องแก้ `GMAIL_PUSH_AUDIENCE` + push subscription ตาม
- **Container ทดสอบทิ้งได้:** `wt-qc-pg` … `wt-qc-pg4` (45432–45435), `wt-qc-redis*` (46379–46382), `wt-qc-minio` (49000), `wt-qc-mailpit` (41025/48025) — ใช้รัน integration/e2e โดยไม่แตะ DB ของ POC · ลบได้ด้วย `docker rm -f` เมื่อไม่ใช้

## ทำเสร็จ 2026-11-02 เย็น → 2026-11-03 เช้า
| งาน | ผล |
|---|---|
| GCP POC | Gmail API, Pub/Sub topic `gmail-push` + push subscription `gmail-push-sub` (OIDC, SA `watchtower-pubsub-push`), OAuth consent (External/Testing) + client `watchtower-poc-web` · secret ที่หลุดเข้าแชทถูก disable และหมุนแล้ว |
| AI ผ่าน `claude -p` (ADR-017) | bridge + provider `claude-cli`, ทดสอบจริงบน ticket (classifier/summarizer/investigator) |
| Role-play QA | 5 บทบาทใช้ stack จริง → 34 รายการ, po triage + คำตัดสิน → `docs/qa/2026-11-02-roleplay-triage.md` |
| แก้บั๊กจาก AI จริง | redactor ใส่ placeholder ใน prompt ของระบบ (brief ล้ม 2/3), `[NAME_n]` บน evidence (security review 2 รอบ) |
| QA-30 (N4) | name-cue detector TH/EN + dictionary ครบ (requester, contact, client user, ผู้ส่ง) + `dictionary_incomplete` · ADR-008 แก้ไข · security review 3 รอบ · **re-test บน stack จริง (OPS-1011) ผ่าน:** ไม่มีชื่อ/เบอร์/อีเมลดิบใน output ของ AI |
| Bucket A | คิว (เลข ticket, SLA slot, Needs you, เรียงตามความเร่งด่วน, subject + AI line), ticket pane (ตอบกลับบน channel ที่ส่งไม่ได้, เตือนรอลูกค้า, AI card เหตุผล/relevance/label, default tab Details, assignee ทุกคน), ค้นด้วยเลข/อีเมล + go-to, สร้าง intent ใน UI + stage legend, portal ขั้นต่อไป + 404 ลูกค้า, ชื่อ rail ไทย, rail สีกลาง, notice มุมมอง dev, reasonCode |
| Bucket B | T-140 แนบไฟล์ portal (security review 2 รอบ: P1 memory DoS ปิด), T-148 อีเมลตอบรับใหม่, T-150 Sync Gmail now, T-138 ข้อความ SLA |
| บั๊กอื่น | `/v1/tickets/stats` 500, ค้นอีเมลผ่าน stats ไม่ลง audit, 404 โลโก้ทับ, worker integration รันข้าง dev stack ไม่ได้ (`TEST_*`), tab ใน panel ล้นทับปุ่ม (axe) |

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] **สั่ง merge UI rework** (`claude/ui-rework-bbf2dc`) หรือไม่ — ต้อง merge `main` เข้า branch ก่อน + รัน e2e (branch นั้นปรับ e2e ด้าน layout ไว้แล้ว)
- [ ] เปิด tunnel ใหม่เมื่อจะทดสอบ Gmail push (ดู §สถานะ) · ส่งเมลทดสอบจากบัญชีภายนอก (เมลที่ส่งถึงตัวเองถูกข้ามโดยตั้งใจ เพราะมี label `SENT`) — สองครั้งที่เจ้าของส่งเมื่อคืนไม่ถึงกล่องเลย ให้ตรวจที่อยู่ผู้รับ
- [ ] ข้อความไทยใหม่ทั้งหมด (stop/deny list ของ redaction, copy portal/อีเมล) ยังไม่ผ่านเจ้าของภาษา
- [ ] สแกนมัลแวร์ไฟล์แนบ (T-155) ต้องเพิ่ม dependency
- [ ] T-115 pilot: เงื่อนไขของ ADR-008 ครบแล้ว (QA-30 + re-test) แต่ยังมี T-154/T-155 และ UI rework ที่ควรเสร็จก่อน

## ขั้นต่อไป (เรียงลำดับ)
1. ถ้าเจ้าของสั่ง: merge `main` → `claude/ui-rework-bbf2dc`, รัน gate, merge เข้า `main` แล้วทำ T-156 (ลิงก์ดาวน์โหลดไฟล์แนบของ staff) บนดีไซน์ใหม่
2. T-154 (upload slot) และ T-155 (quota/retention) ก่อนเปิด portal สู่ internet
3. BACKLOG หัวข้อ "จาก role-play QA 2026-11-02": T-141 หน้าเช้าของ lead, T-142 การ์ดงบ AI, T-143 keyboard, T-144 timeline, T-145, T-146, T-147, T-149, T-151, T-152, T-157, T-158
4. role-play รอบสองหลัง UI rework (ใช้ brief เดิม `scratchpad` ไม่อยู่ใน repo — ดูรูปแบบใน `docs/qa/2026-11-02-roleplay-triage.md`)

## กติกาที่ได้เรียนรู้คืนนี้ (ใช้ต่อ)
- integration/e2e **ห้ามรันกับ DB/Redis/MinIO ของ stack ที่เปิดอยู่** (test เขียนลง DB เดียวกัน) ใช้ `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_S3_*`, `TEST_SMTP_PORT`, `MAILPIT_URL` ชี้ container ทิ้งได้ และแยกชุดต่อ agent ที่รันพร้อมกัน ไม่งั้น hook timeout 30 s
- web e2e ใช้ port 3100 ตายตัว ห้ามรันสองชุดพร้อมกัน · e2e รัน standalone build → แก้ web แล้วต้อง `pnpm build` ก่อน
- `PW_CHANNEL=chrome` บนเครื่องนี้ (ไม่ได้ดาวน์โหลด browser ของ Playwright)
- Postgres volume เดิมถูก init ด้วยรหัสเก่า: เปลี่ยน `POSTGRES_PASSWORD` แล้วต้อง `ALTER ROLE` ใน container (ไม่ต้องลบ volume)
- security review จับของจริงได้ทุกรอบ (P1 ชื่อเพื่อนร่วมงานหลุดเข้า draft, P1 memory DoS) — งานที่แตะ redaction/upload/auth ต้องผ่าน reviewer คนละตัวก่อน merge เสมอ (N7)

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- ข้อความ "Counted in business hours" / "นับเฉพาะเวลาทำการ" ในอีเมลและ ticket `[ASSUMED]` ว่า calendar ของ policy เป็น business hours
- recall ของ name-cue กับข้อความลูกค้าจริง `[UNVERIFIED]` (T-302)
- ลูกค้าบนมือถือจริงกับปุ่มเลือกไฟล์ (iOS/Android picker) `[UNVERIFIED 80%]`
- memory ของ upload วัดใน harness ไม่ใช่ container production `[UNVERIFIED]`
