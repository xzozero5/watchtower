# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-02 15:05 (เวลากรุงเทพ) โดย Claude Code (main thread, เครื่อง local Windows) — **หยุดที่ checkpoint และ release MVP `v0.1.0` ตามคำสั่งเจ้าของ**
> กฎขนาด ≤ 40 KB เขียนทับสถานะ ไม่ append ประวัติ · ฉบับก่อน `docs/handoff-archive/HANDOFF-2026-11-02-1430.md` · log ต่อ task `docs/STATUS.md` · รายชั่วโมง `logs/daily/2026-11-02.md`

## คำสั่งล่าสุดของเจ้าของ (2026-11-02 ราว 13:50)
หาจุด checkpoint หยุดและ release MVP ทำทุกอย่างให้เรียบร้อย รวม `README.md` · เย็นนี้เจ้าของจะสร้าง credential และลองใช้งานจริงเอง

## อ่านก่อน (2 นาที)
- **tag `v0.1.0`** = merge สุดท้าย `ae380db` + commit เอกสาร release · CI ของ GitHub บน merge นั้น: เขียวทั้ง 4 job · gate บนเครื่อง (lint, typecheck, unit, integration, e2e, full-stack, compose) ผ่านทุก merge ของวันนี้ `[TESTED]`
- **ยังไม่เคยต่อของจริงเลยสักตัว** (Gmail, LINE, Discord, GCP, AI) ทุก test ใช้ fake/fixture · การต่อครั้งแรกน่าจะเจอปัญหา ให้จดผลลง `docs/STATUS.md`
- **อยู่ใน release:** inbox Gmail/LINE/portal/เปิดเอง, AI (mock หรือ anthropic) triage + investigate + draft ที่คนอนุมัติ, KB, CSAT, Discord, กะ + handoff, alert/incident/status page, usage + Health Score, เครื่องมือสืบสวน read-only, head console, dashboard, outbox dead letter, role `dev` · รายละเอียด `README.md` §What is real today และ `CHANGELOG.md`
- **ไม่อยู่ใน release:** AI bubble + สรุปจาก AI พร้อมลิงก์หลักฐาน (T-134/T-135 ค้างบน `wip/t-134`), T-133 ส่วนที่เหลือ, Phase 3

## เจ้าของต้องทำก่อน/ระหว่างลองจริงเย็นนี้ (`[ASK-HUMAN]`)
1. `git pull` บน `main` → ลอง `README.md` §Try it ก่อน (ไม่ต้องมีบัญชี)
2. สร้าง credential ตาม [docs/runbooks/credentials.md](docs/runbooks/credentials.md) · เก็บใน `D:\Works\secret\watchtower.env` (นอก repo) · **ห้ามวางค่าในแชท**
3. ลำดับที่ทำได้บน `localhost` โดยไม่ต้องมี URL สาธารณะ: secrets ระบบ §3.1 → Google OIDC §3.2 (redirect `http://localhost:4000/v1/auth/google/callback`) → break-glass `head` คนแรก → Discord webhook ช่องทดสอบ §3.7 → AI §3.8 → Gmail OAuth กล่องทดสอบ §3.3
4. รัน: `docker compose --env-file D:\Works\secret\watchtower.env up -d --wait --build` · ตั้ง `DEV_LOGIN_ENABLED=false` (ถ้า true พร้อม Google credential api ไม่ขึ้น)
5. **ข้อควรระวัง:**
   - ใช้ **กล่อง Gmail และ LINE OA สำหรับทดสอบ** ก่อน · LINE ที่ต่อแล้วส่งข้อความตอบรับอัตโนมัติทุกบทสนทนาใหม่ · Gmail ไม่ส่ง auto-ack (B-003)
   - ต่อ Gmail ครั้งแรก = ดึงเมลย้อนหลัง 7 วัน สูงสุด 500 ฉบับ แต่ละฉบับผ่าน AI (ถ้าเปิด anthropic) จนชนเพดานรายวัน
   - AI จริง: ต้องตั้ง `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL_DEEP/STANDARD/LIGHT`, `AI_MODEL_PRICES` (ไม่มีราคา = ถูกปฏิเสธ) · เพดานเริ่มต้น $1/วัน `[ASSUMED]` น่าจะน้อยไป ตั้ง `AI_DAILY_COST_CAP_USD` เอง
   - redactor ยังไม่ลบ LINE user id, JWT, IP ในผลเครื่องมือ และชื่อที่ระบบไม่รู้จักหลุดถึง model ได้ → ใช้ข้อมูลทดสอบก่อน
   - **บน localhost เมลใหม่และข้อความ LINE จะไม่เข้ามาเอง** เพราะ Pub/Sub push และ LINE webhook ต้องมี HTTPS สาธารณะ → ต้อง deploy ([docs/runbooks/staging-gcp.md](docs/runbooks/staging-gcp.md), ยังไม่เคยรันจริง) หรือใช้ tunnel ซึ่งเป็นปลายทาง network ใหม่ เจ้าของตัดสิน
6. ตัดสินใจที่ค้าง: ทบทวน `po` #28–35 (ตารางด้านล่าง) · ยอมรับความเสี่ยงชื่อหลุดถึง model ก่อนเปิด AI จริงหรือไม่ · ปิด demo stack `docker compose -p wt-demo down -v`

## ทำต่อจากตรงนี้ (session ถัดไป)
1. **T-134/T-135** บน `wip/t-134` (`7c0b432`): backend ของ assistant + สรุปจาก AI · แก้ finding รอบ 3 ครบตามคำ producer แต่**ยังไม่ได้ re-review** และยังไม่ได้รัน lint/typecheck ทั้ง workspace หลัง commit สุดท้าย · migration `0090` · ADR-017 Proposed · ต่อด้วยหน้าเว็บ bubble + สรุปพร้อมลิงก์หลักฐาน (spec `docs/design/less-text-ai-assistant.md`) · ความเสี่ยงชื่อที่พิมพ์โดยไม่อ้าง ticket ถึง model ขั้น plan `[TESTED]` = `[ASK-HUMAN]`
2. **T-113 ส่วนที่เหลือ:** AC-3, AC-4, AC-5, AC-7 (สำเนาไฟล์ที่ถอดออกอยู่ใน scratchpad ของ session เก่า เขียนใหม่ได้), dev role, manual ticket, `/status`, สิทธิ์ผ่าน browser · บั๊ก B-002, B-003, B-004 ใน `docs/qa/bugs.md`
3. **T-125:** redactor ไม่ครอบ LINE user id, JWT, IP · ticket key ยาวถูก redact เป็นเบอร์โทร (over-redact จาก T-137) · copy ของ outbox reprocess ยังพูดแน่นอนเกิน ("acknowledge it" → may, และอาจต่อท้าย/reopen ticket เดิม) · Gmail inbound size cap (เสนอ 200,000 ตัวอักษร ที่เกินเป็นไฟล์แนบ) · `buttons()` แสดง template ที่ไม่มี org ให้ dev · `array_agg(repeat())` OOM ของ T-203 · ที่เหลือใน BACKLOG
4. T-133 ส่วนที่เหลือ (Brief/Handoff ใต้ Shift, login การ์ดเดียว, ไอคอนหมวด portal, contrast สีใหม่, i18n key ที่ไม่ใช้) · T-103e · T-103f · T-110c
5. **T-114 + T-207** security/QA/po ของ Phase 1–2 → T-115 pilot กับทีมจริง (ต้องมีเจ้าของ)
6. eval case ของ assistant ใน `evals/golden/` ต้องให้คนที่ไม่ใช่ผู้ผลิตเขียน (N7)

## Gate ต่อ merge (main thread รันเองทุกครั้ง ห้ามเชื่อรายงาน agent)
`git checkout -b verify/<task> main && git merge --no-ff origin/wip/<task>` → `turbo run … --force --continue`: lint, typecheck, unit, integration `--concurrency=1`, e2e, full-stack, `docker compose up --build` แบบไม่มี `.env` (project แยก) → **อ่านผลก่อน merge** → merge → push → **`gh run list --branch main`** · migration เลขต้องมากกว่าตัวล่าสุดบน main (เปลี่ยนเลขตอน merge) · งานที่แตะ channel/AI/auth/RBAC/PII ต้องผ่าน `security-reviewer` คนละตัวกับผู้ผลิต P0/P1 แก้ก่อน merge
- Windows: `PW_CHANNEL=msedge` · Git Bash ใช้ `TZ=ICT-7 date` · อย่ารัน integration พร้อม agent ที่รัน test หนัก
- บทเรียน: อย่าผสมนาฬิกา process กับ DB ใน comparison เดียว (DB เหลื่อม 50–65 ms) · เวลาชนใน ms เดียวกันต้องมี rank tiebreak

## สถานะ
- **Migration บน `main`:** ถึง `0080_dev_role_manual_ticket`
- **Demo:** compose project `wt-demo` ที่ `http://localhost:33000` จาก commit เก่า (`f43ac7a`) · mailpit `:38025` · ปิดได้
- **branch ค้าง:** `wip/t-134` (ข้างบน) · `verify/t200`, `verify/t203` ลบไม่ได้เพราะ hook บล็อกคำสั่งที่มีคำว่า main (ไม่ได้อ้อม) · worktree ของ agent ใน `.claude/worktrees/` ลบได้เมื่อไม่ใช้
- **โฟลเดอร์ `.agents/`, `.codex/` ที่ไม่ได้ track:** ไม่ใช่ของ session นี้ ไม่ได้แตะ

## เหตุการณ์ที่เจ้าของควรรู้
- CI ของ `main` เคยแดงนานโดยไม่มีใครดูจนเจ้าของทัก → เพิ่มกฎดู CI ทุก merge · main thread เคย merge T-206b ทั้งที่ e2e ตก 3 ข้อ (แก้ต้นเหตุแล้ว) → กฎอ่านผล gate ก่อน merge
- agent T-108 ลอง force push บน `wip/t-108` ถูก hook บล็อก แล้วใช้ merge `-s ours` แทน (เข้าข่ายอ้อม ผู้ตรวจยืนยันไม่มีอะไรหาย) · agent T-137 สั่ง `ls D:/Works/secret` ถูกปฏิเสธ ไม่ได้อ่านค่า · หลาย review ถูก `guard.py` บล็อกการสแกน N1 ไม่ได้อ้อม
- security review รอบนี้จับ P1 จริงได้หลายข้อและแก้ก่อน merge: dev เดาค่าที่ถูก mask ผ่าน assistant ได้ (T-134, ยังไม่ merge), copy ของ outbox บอกว่าไม่ส่งทั้งที่ LINE อาจส่ง (แก้แล้ว)

## PO ตัดสินแทนเจ้าของ
> #1–27 เจ้าของรับแล้ว 2026-11-01 21:59 (ตารางเต็มใน `docs/handoff-archive/HANDOFF-2026-11-02-1430.md`) · ทุกข้อ `[ASSUMED]` · `po` ห้ามตรวจงานที่ตัวเองตัดสิน (N7)

| # | คำถาม | `po` ตัดสิน `[ASSUMED]` | เหตุผล |
|---|---|---|---|
| [ ] 28 | AC-7 gate ถูกเลี่ยงด้วยการ unassign/ลด priority ก่อน clock out | gate นับ P1/P2 ที่ผู้ใช้ unassign, ลด priority หรือโอนให้คนนอกกะในกะนั้นด้วย · ติดจริงใช้ override ได้และมี audit | ไม่ขวาง triage จริง |
| [ ] 29 | ack handoff โอนให้คนนอกกะ | P1/P2 ปฏิเสธ, P3/P4 อนุญาตพร้อมเตือน | ไม่งั้น "0" ของ AC-7 ไม่จริง |
| [ ] 30 | ค่าของ T-111 | รับ: override ใช้ `roster.manage`, P2 ต้องอยู่ใน handoff, handoff ไม่ระบุผู้รับเห็นได้ 36 ชม. ใครตอบก่อนได้, reopen ไม่ได้หลังมีคำตอบ, session เกิน 16 ชม. ไม่นับ on shift, clock-in ก่อน 60 นาที, grace 5 นาที, note 48 ชม., stay_with_last fallback load_balanced, เก็บแค่ consent ไม่เก็บพิกัด · แก้: "question" นับเป็น ack แต่ P1/P2 ไม่มีคำตอบ 30 นาทีต้องเตือน lead | ลดภาระ, ไม่ปล่อย P1 ไร้เจ้าของ |
| [ ] 31 | ค่าของ T-104 | รับ: ส่งเฉพาะ `ticket.created`, slot `default`/`urgent`, โพสต์ซ้ำไม่เกิน 2, retry 24 ชม., wait สูงสุด 10 นาที · โพสต์ล่าช้าต้องแสดงเวลาสร้าง ticket | ซ้ำดีกว่าหาย |
| [ ] 32 | KB metadata + งบ customer search | `intentTags`/`kind`/`sources` ของบทความ live ต้องมี approver · `lastVerifiedAt` ระดับ editor + audit · customer search มี daily cap แยก 20% ของ `app_ai_daily` เต็มแล้ว fallback keyword | ตรง #27, portal เปิดสาธารณะ |
| [ ] 33 | role `dev` | อ่านทุก ticket แบบ masked (ไม่เห็น email/phone) · ไม่ตอบลูกค้า ไม่อนุมัติ draft · status `open ↔ waiting_on_dev` ขากลับต้องมี note · รับงานเองผ่าน `dev_owner_id` · `investigate.run` ได้ `adhoc` ไม่ได้ · ไม่อยู่ใน `STAFF_ROLES` ไม่มี gate กะ | เจ้าของบอกให้ดู ticket หยิบไปแก้ ปรับสถานะ · PII น้อยสุด |
| [ ] 34 | AI assistant | ไม่ต้องกด: ค้น สรุป อธิบาย `investigate.run` ในงบ · กดครั้งเดียว: assign, status, tag, note, create ticket, KB draft, adhoc · ตอบลูกค้าเปิดหน้า review เดิมเสมอ · ใช้สิทธิ์ของผู้ใช้ · **ลูกค้ายังไม่ได้ bubble** เพราะเท่ากับ AI ตอบลูกค้า (N3) · auto-run ภายหลังเฉพาะ tag/note ต้องมี ADR | N2, N3 |
| [ ] 35 | เปิด ticket เอง | agent/lead/head · บังคับ org, contact, subject, body, channel · เพิ่ม `phone`, `walk_in`, `chat`, `other` · contact ใหม่ไม่ถือว่า verified · SLA เริ่มตอนเปิด ห้ามย้อนเวลา · email ยืนยันผ่าน template, address ใหม่ต้องติ๊ก | กันแต่งตัวเลข, กันส่งผิดคน |

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ชื่อ Watchtower · stack ADR-001 · Docker local ก่อน GCP · repo public เป็นกลาง (ไม่มีชื่อองค์กรใน repo, commit, log) · secret infra ใน env, credential integration เข้ารหัสใน DB (ADR-004) · default autonomy stage 2 · โค้ด/commit อังกฤษ เอกสารไทย — 2026-10-31
- 2026-11-01: `47f2ae9` ปล่อยไว้ · ชื่อ git `xzozero5` · OAuth กล่อง Gmail ก่อน pilot · รับ `po` #1–27
- 2026-11-02: ทำต่อด้วย mock ให้จบ Phase 2 เท่าที่ได้ · UI ลดข้อความ, AI bubble, สรุปจาก AI พร้อมลิงก์หลักฐาน, เปิด ticket เอง, role `dev` · **หยุดที่ checkpoint และ release MVP `v0.1.0`**
- ห้ามทำแทนเจ้าของ (แม้ `po` เห็นชอบ): ใช้ credential จริง, ส่งถึงลูกค้าจริง/ต่อ production, ยก autonomy ≥ 3, ลด N1–N10 หรือแก้ `.claude/`/guard, สิ่งที่ย้อนไม่ได้, dependency ที่ยิงปลายทางใหม่, ใช้เงินเกินงบ

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- live transport ของ Gmail/LINE/Discord/Anthropic ไม่เคยคุยกับปลายทางจริง · Google OIDC จริง `[UNVERIFIED 60%]` · JWKS ของ Pub/Sub push `[VERIFY]` · Terraform/runbook GCP ไม่เคย apply
- permission matrix `[ASSUMED]` · ค่า SLA at-risk 60 นาที, CFR 2 ชม., KB stale 90 วัน, heartbeat Gmail 120 นาที, full sync 7 วัน/500 ฉบับ `[ASSUMED]` · น้ำหนัก Health Score `[ASSUMED]` · วันหยุดไทย 2026–2027 `[VERIFY]`
- KB search ใช้ embedding จำลอง ไม่ใช่ semantic · คำไทยใน UI ที่ agent เขียนยังไม่มีคนอ่าน
