# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-05 08:30 (เวลากรุงเทพ) โดย Claude Code main thread — ปิด Phase 1–3 (code) ตามคำสั่งเจ้าของ 2026-11-04
> ฉบับก่อน: `docs/handoff-archive/HANDOFF-2026-11-03-1550-owner-requests.md` · บันทึกรายชั่วโมง `logs/daily/2026-11-04.md`, `logs/daily/2026-11-05.md`

> ⚠️ **local `main` นำ `origin/main` (`ae3effd`) อยู่ ~280 commit และยังไม่ push** — เจ้าของสั่งให้รอ OK ก่อน push และก่อน deploy POC · POC (`watchtower`, :3000) ยังรัน image 2026-11-03 (ก่อน migration 0084+)

## สถานะปัจจุบัน
- **Phase:** 1 = done pending pilot · 2 = done pending live (GCP/Discord จริง) · 3 = code + e2e ครบ, PO T-306c บอกยังไม่ "done pending live gate" จนปิดงานค้างด้านล่าง · LINE = feature ภายหลัง · Phase 4: ดึง T-152 (ลิงก์ "คำขอของฉัน" ทางอีเมล) + Web Push live มาทำแล้ว
- **Build/Test บน local main `[TESTED]` (main thread รันเอง):** typecheck 18/18, lint 19/19, unit ทั้ง repo ผ่าน (web 1655, ui 809, shared 1130, ai 819, api 462, worker 193, domain 228, db 86, channels 592, connectors 146, eval-runner 25) · integration บน container ทิ้ง: db 509/509, worker 361/361, domain 506/508 → 2 ตกจาก clock skew ใน test (แก้ `23b6778`), api 1389/1391 → roster-plan (แก้ `ac79142`, 15 รอบผ่าน) · เหลือ flake api 2 ตัว → T-306l (กำลังทำ)
- **Migration ล่าสุด:** 0110 (`record_ai_grade` อ่าน `coalesce(response_model, model)`) · ไม่มีเลข 0100 (ข้ามเลข ไม่กระทบ migrator) · T-306k อาจเพิ่ม 0111
- **Deployment:** POC local compose `watchtower` (image 2026-11-03) · pilot = instance ใหม่ตาม `docs/runbooks/pilot-instance.md` (เจ้าของ deploy เอง)
- **Flag:** `AI_AUTOSEND_ENABLED` **ห้ามตั้ง** บน POC/production จนเจ้าของสั่ง (ADR-025) · ตั้งได้เฉพาะ stack ทิ้งของ e2e (`E2E_AUTOSEND_FLAG=on`)
- **Credential ที่มี (ชื่อเท่านั้น):** env ของเจ้าของ `D:\Works\secret\watchtower.env` (agent ห้ามอ่าน) · Gmail push SA `watchtower-pubsub-admin` · `claude -p` ผ่าน `claude-bridge`
- **เงิน:** ผลิตภัณฑ์ไม่มี external AI/cloud call ระหว่าง build (mock / stack ทิ้ง) · build agent ไม่มี meter รวม

## การตัดสินใจของเจ้าของที่มีผลอยู่ (`[CONFIRMED]`)
- 2026-11-04: ใช้ `claude -p` อัตโนมัติกับข้อมูลลูกค้าได้ · ADR-021 ยอม claude-cli นอก loopback เมื่อ `CLAUDE_CLI_ALLOW_REMOTE=true` · ADR-023 residual (ชื่อลูกค้าที่พิมพ์ใน assistant ถึง model ตอน plan) = Accept · redact เฉพาะเลข passport (ที่เหลือเปิด) · ข้อความไทยตาม glossary ไปก่อน เจ้าของตรวจตอนจบ
- 2026-11-04: เกณฑ์ปิด phase (ด้านบน) · pilot = instance ใหม่ · PDF export (ADR-028) + NER local (ADR-027) ทำใน Phase 3 · LINE เลื่อน
- ADR-025 (stage 3): approver คนเดียวกันได้แต่ตรวจเพิ่ม (step-up + confirmKey) · grader = คนละ model vendor เดียวกันพอ · rollback: violation ทันที, อื่น ๆ ≥ 2 ใน 20 · footer AI เปิดเป็นค่าเริ่มต้น
- golden: Accept + hook เข้ม (`evals/GOLDEN-REVIEW.md` ต้องแก้คู่กัน, guard บล็อก shell ที่แตะ `evals/golden`) · B-007 zip ใหญ่: ปฏิเสธตอน upload · weekly brief: ใน app ได้ อีเมลไม่ · T-152 + Web Push live: ทำได้เลย
- push/deploy: รอ OK ของเจ้าของ

## ทำเสร็จรอบนี้ (2026-11-04 → 05) — รายละเอียด `docs/STATUS.md` entry 2026-11-05 07:30
| งาน | ผล |
| --- | --- |
| Phase 1/2 ค้าง | T-114a, T-125a, T-155a, T-171a, T-173…T-183, T-207a ฯลฯ ปิด (ดู BACKLOG) |
| Phase 3 | T-301a–f, T-302a–c,e,g, T-303a–f, T-304a–g, T-305a–f, T-306a,b,e–j (grader, eval/replay/golden, procedures + simulation, stage 3 gate + shadow + rollback + report, CEO view, weekly brief, PDF, roster planner, NER) |
| Security | T-306a (1 P1 → แก้), T-306j ตรวจซ้ำ: ไม่มี P0/P1, C-15 P2 ใหม่ → T-306k |
| QA | T-306b e2e full-stack stage 3 (flag OFF shadow, flag ON fake-live ส่งจริง + ระงับ 6 เหตุผล, rollback ×2, eval gate + step-up) · บั๊ก B-009/B-010/B-011 แก้แล้ว |
| Test isolation | integration config ปฏิเสธรันนอก CI ถ้าไม่ตั้ง `TEST_*` (เคยรั่วเข้า POC — ล้างแล้วด้วยอนุญาตเจ้าของ) |

## ค้าง / ติดอะไร
- **T-306k** (backend-dev กำลังทำ): C-15 placeholder org ใน golden + gate, C-16 staff เขียน `requesterVerified`, C-17 `/.//evil.com` ใน returnTo, C-18 sampled grade ซ้ำ, C-19 `"pass":"true"`, C-11, C-2 ส่วนถูก — ต้องปิด C-15 ก่อนเปิด flag ที่ใด
- **T-306l** (backend-dev กำลังทำ): flake `auth/session` absolute lifetime (200 แทน 401 — ตรวจว่าเป็นบั๊ก security หรือไม่), `outbound` undo hold timing
- **Residual P3 ยอมรับไว้ก่อน (main thread):** C-4 replay ผูก alias + เชื่อตัวเลขผู้เรียก, C-6 app role ทำ gate report เขียวผ่าน DEFINER ได้, C-9 app role INSERT `ai_run` ปลอม grade ได้, C-14 web ไม่แสดง reviewers — เหตุผล: flag ปิด + ต้องมี L0 (env) + L3 (owner approve) ก่อนส่งจริง · ทบทวนก่อนเปิด flag
- T-302d: replay อัตโนมัติเมื่อเปลี่ยน prompt/model/procedure ยังสั่งมือ (`eval-runner record`)
- T-305: CEO §9.2 ข้อ 2,3,5,6, ตั้งเวลา weekly brief ใน admin, e2e/axe หน้า cost ยังไม่ทำ (PO T-306c)
- T-207 (Phase 2 QA/po review + handoff) ยังไม่ติ๊กใน BACKLOG ทั้งที่เกณฑ์ปิดถือว่าผ่าน — ให้ po ยืนยันแล้วติ๊ก
- container `wt-main-*` (pg/redis/minio/mailpit) ค้างจาก agent ก่อนหน้า — ไม่ใช่ stack เจ้าของ ลบได้เมื่อไม่ใช้
- ไม่แก้/commit `.agents/` และ `.codex/`

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] OK ให้ push `main` (~280 commit) แล้วดู CI · OK ให้ deploy POC (ต้อง backup DB ก่อน, migrate 0084–0110+)
- [ ] เลือก intent แรกสำหรับ stage 3 เมื่อมีข้อมูลจริง — po เสนอ `feature_question`, `incident_inquiry`, `workspace_config` (ไม่แนะนำ `account_access`, `billing_report`, `result_dispute`)
- [ ] รับรอง: drafter stage 2 ใช้ `contact.verifiedAt` เดิม (เข้มน้อยกว่า gate stage 3 ที่ใช้ `requesterVerified`)
- [ ] อนุมัติ eval เคส 7 ข้อของ T-301f เข้า `evals/golden/` (ลูกค้าปฏิเสธ/ยืนยัน TH+EN)
- [ ] ก่อน pilot: VAPID `pnpm push:vapid --out D:\Works\secret\vapid.env` + ตั้ง `WEB_PUSH_*` · `CLAUDE_CLI_BRIDGE_URL=http://claude-bridge:4317` · `WEEKLY_BRIEF_RECIPIENT_DOMAINS` · grader model ต่างจาก drafter (เช่น `AI_AGENT_MODEL_GRADER=opus`) · ให้สิทธิ์ `ai.autonomy.owner_approve` ผ่าน CLI · ตั้งเตือน rotate key `watchtower-pubsub-admin` ทุก 90 วัน
- [ ] ทดสอบ step-up ด้วย Google จริง (Google ใส่ `auth_time` เมื่อส่ง `max_age` หรือไม่ — ถ้าไม่ approve ไม่ได้เลย, fail closed)
- [ ] ทดสอบ grader จริงต่อ prompt injection · ตัดสินดาวน์โหลด model NER ขั้น 2 · ตรวจข้อความภาษาไทย

## ขั้นต่อไป (เรียงลำดับ)
1. รับรายงาน T-306k, T-306l → ตรวจ diff + รัน typecheck/lint/unit + integration ครบ 4 ชุดเอง (script แบบ container ทิ้ง: pg/redis/minio/mailpit พอร์ต 47xxx/48xxx/49xxx/41xxx, ตั้ง `TEST_DATABASE_URL` `TEST_REDIS_URL` `REDIS_URL` `TEST_S3_ENDPOINT` `TEST_S3_ACCESS_KEY` `TEST_S3_SECRET_KEY` `TEST_SMTP_PORT` `MAILPIT_URL`) → merge
2. ADR-025 + ADR-026 → Accepted (บันทึก residual P3), ติ๊ก T-306c/T-301–T-305 umbrella เมื่อ po ยืนยัน
3. web e2e + full-stack e2e ครบชุดก่อน push (`apps/web/e2e-fullstack/README.md`, stage 3 ใช้ ~10 นาที)
4. รอ OK เจ้าของ → push → CI เขียว → deploy POC ตาม `docs/runbooks/local-poc.md`
5. หลัง pilot: T-302d replay อัตโนมัติ, T-305 ส่วนที่เหลือ, LINE

## ยังไม่ยืนยัน
- claude-cli คืน `response_model` จริงหรือไม่ (ถ้าไม่ independence เทียบ alias) `[UNVERIFIED 50%]`
- step-up กับ Google จริง `[UNVERIFIED 70%]` · C-17 เป็น open redirect จริงหรือไม่ `[UNVERIFIED 30%]`
- คำว่า "ยัง" ถูกนับเป็นลูกค้าปฏิเสธกว้างไป (ลด class เท่านั้น) · grader เห็นแค่ข้อความลูกค้าแรก+ล่าสุด `[ASSUMED]`
- T-306h: ticket ที่คนอื่นยื่นด้วยอีเมลลูกค้าก่อนลูกค้าคลิกลิงก์จะถูก verify ด้วย (คำตอบยังไปกล่องจริง) `[ASSUMED ยอมรับได้]`

## วิธีเปิดระบบและทดสอบต่อ
- `docs/runbooks/local-poc.md` §6 (integration ต้องชี้ service ทิ้ง — config ปฏิเสธถ้าไม่ตั้ง `TEST_*`) · `docs/07-TESTING.md` · `apps/web/e2e-fullstack/README.md`
- หลัง merge ที่เพิ่ม dependency workspace ให้ `pnpm install --offline` · ก่อน integration ให้ `pnpm turbo run build --filter=@watchtower/api^... --filter=@watchtower/worker^...`
- ห้ามพิมพ์ค่า env/credential · ห้ามแตะ stack `watchtower` ของเจ้าของ (port 5432/6379/9000/1025/3000/4000)

## วันตรวจซ้ำ
- rotate key `watchtower-pubsub-admin`: 2027-02-01 (90 วันจากสร้าง 2026-11-03)
- ทบทวน residual P3 (C-4, C-6, C-9, C-14) ก่อนเปิด `AI_AUTOSEND_ENABLED` ที่ใด
