# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-03 12:30 (เวลากรุงเทพ) โดย Claude Code (main thread, เครื่อง local Windows) — **ส่งต่อให้ Codex ทำต่อ** (เจ้าของสั่ง)
> ฉบับก่อน `docs/handoff-archive/HANDOFF-2026-11-03-pre-codex.md` (รายละเอียดคืน 2–3 พ.ย.) · log ต่อ task `docs/STATUS.md` · รายชั่วโมง `logs/daily/2026-11-03.md`

## ถ้าคุณคือ Codex (หรือ AI อื่นที่ไม่ใช่ Claude Code)
- กติกาทั้งหมดอยู่ใน `AGENTS.md` (ใช้กับทุก AI) · hook ใน `.claude/` บังคับได้เฉพาะ Claude Code → **คุณต้องถือ Non-negotiables N1–N10 เอง** โดยเฉพาะ N1 (ห้ามพิมพ์/commit secret, repo ต้องไม่มีชื่อองค์กร/อีเมลส่วนตัว), N4 (redact ก่อนส่ง LLM), N7 (คนตรวจคนละตัวกับคนทำ)
- บทบาทใน `.claude/agents/*.md` และขั้นตอนใน `.claude/commands/*.md` เป็น markdown ธรรมดา ใช้เป็น prompt ของ sub-task ได้
- **AI ในระบบใช้ `claude -p` ต่อไป (เจ้าของสั่ง 2026-11-03)** ไม่ต้องย้ายไปใช้ API key หรือ provider อื่น — bridge รันบน host แยกจากเครื่องมือเขียนโค้ด: ดู `docs/runbooks/local-poc.md` §3 (ADR-017)
- **⚠️ bridge `claude -p` และตัวกรอง push-only ไม่ได้รันค้างไว้ให้** — process ที่ Claude Code เปิดไว้หยุดเมื่อ session นั้นปิด ก่อนใช้หรือทดสอบ AI ในระบบ **ต้องเปิด bridge ใหม่ใน terminal แยกแล้วปล่อยค้างไว้**:
  `node --env-file=D:\Works\secret\watchtower.env tools/claude-cli-bridge/server.mjs` (ฟัง `127.0.0.1:4317`)
  ตรวจว่าเปิดอยู่: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:4317/v1/generate` ต้องได้ `401` (ไม่มี token = bridge ตอบอยู่) ถ้าเชื่อมต่อไม่ได้ = ยังไม่เปิด · bridge ไม่เปิด → AI ทุกครั้งล้มแบบบันทึกไว้ (`provider_unavailable` ใน `ai_run`, การ์ด AI บอกเหตุผล) ไม่สลับไป mock เอง · ตัวกรอง push-only (`pnpm push-filter`) เปิดเฉพาะตอนจะใช้ tunnel ของ Gmail
- วิธีเปิดระบบทั้งหมดบนเครื่องนี้ (stack, bridge, tunnel, ผู้ใช้, การรัน test บน DB ทิ้งได้): **`docs/runbooks/local-poc.md`**

## สถานะ
- **`main` = `origin/main`** (push แล้ว) · tag `v0.1.0` = MVP เมื่อ 2 พ.ย. (ยังไม่ได้ tag รุ่นใหม่)
- **Gate ล่าสุดบน `main` (main thread รันเอง, service ทิ้งได้):** ดู STATUS entry 2026-11-03 12:30
- **ระบบจริงบนเครื่องเจ้าของ (POC, localhost):**
  - ล็อกอิน staff ด้วย **Google จริง** ผ่าน `GOOGLE_ALLOWED_EMAILS` (ADR-005 แก้ไข 2026-11-03: เฉพาะ @gmail.com/@googlemail.com, เฉพาะ APP_URL loopback, ไม่ auto-provision) · **dev login ปิด** (บัญชี `*@example.com` จาก QA ใช้ไม่ได้) · break-glass อยู่ใน env file
  - AI จริงผ่าน `claude -p` (provider `claude-cli`) · Gmail จริง (OAuth + Pub/Sub push ต้องมี tunnel + `pnpm push-filter`; ไม่มี tunnel ใช้ปุ่ม "Sync now") · LINE/Discord/SMTP ออก/GCP logs ยังเป็น mock
- **UI:** ดีไซน์ "Soft Beacon" (`docs/design/redesign-2026-11/README.md`) · shell ถาวรใน `apps/web/src/app/(console)/layout.tsx` (เปลี่ยนเมนูไม่ remount) · หน้าแรกตาม role `apps/web/src/lib/role-home.ts` (agent → `/`, lead/head → `/home`, dev → DevHome, client → `/`; ผ่าน `/start`, `next` ต้องเป็น path ภายใน) · เมนูซ้ายจำสถานะใน localStorage `wt-rail-expanded` (ค่าเริ่มต้นขยาย)

## ทำเสร็จช่วง 2–3 พ.ย. (สรุป — รายละเอียดใน archive และ STATUS)
- ต่อของจริง (GCP OAuth/Pub/Sub, Gmail, AI ผ่าน `claude -p`) · role-play QA 5 บทบาท → 34 รายการ (`docs/qa/2026-11-02-roleplay-triage.md`) · แก้ bucket A ทั้งหมด + T-140 แนบไฟล์ portal, T-148 อีเมลตอบรับ, T-150 Sync Gmail, T-138, T-151 · QA-30 redaction ชื่อ (ADR-008) · UI rework Soft Beacon · Google login (ADR-005) · แก้ UX: ไม่ reload ทั้งหน้า, shell ไม่ remount, เมนูจำสถานะ, โลโก้ → หน้าแรกตาม role, จุดสถานะเดียวใน rail, ชิปกะ "รอรับทราบ N"
- ทุกงานที่แตะ redaction / ค้นหา / upload / auth ผ่าน `security-reviewer` (รอบแรกไม่ผ่าน 3 ครั้ง: ชื่อเพื่อนร่วมงานหลุดเข้า draft, memory DoS ของ upload, allow-list ข้าม hd — แก้แล้วทั้งหมด)

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] ข้อความไทยใหม่ (stop/deny list ของ redaction, copy portal/อีเมล/rail) ยังไม่ผ่านเจ้าของภาษา
- [ ] สแกนมัลแวร์ไฟล์แนบ (T-155) ต้องเพิ่ม dependency
- [ ] T-115 pilot: เงื่อนไข ADR-008 ครบแล้ว แต่ควรปิด T-154/T-155 ก่อนเปิด portal สู่ internet และต้องย้ายจาก POC (dev/gmail.com allow-list) ไป Workspace + deploy (staging-gcp runbook ยังไม่เคยรันจริง)
- [ ] เมื่ออยากทดสอบเมลไหลเข้าเอง: เจ้าของเปิด tunnel เอง (agent ถูกระบบสิทธิ์บล็อก) แล้วอัปเดต audience + subscription ตาม runbook §4 · เมลทดสอบต้องส่งจากบัญชีภายนอก

## ขั้นต่อไป (เรียงลำดับ — ID ใน `docs/BACKLOG.md`)
1. T-156 ลิงก์ดาวน์โหลดไฟล์แนบสำหรับ staff (route API พร้อมแล้ว) · T-159 counts/history API (ปิด trend chip + กราฟแยกช่องทางบน Home)
2. T-154 (upload slot ถูกแย่ง) + T-155 (quota/retention/sweep) ก่อนเปิด portal สู่ internet
3. หน้าเช้าของ lead (T-141), การ์ดงบ AI (T-142), keyboard ตาม spec (T-143), timeline from→to (T-144), T-145, T-146 (glossary ไทย), T-147, T-149, T-152, T-157, T-158
4. T-161 หาสาเหตุ flaky: `apps/web/e2e/shift.e2e.ts` AC-7, `apps/web/e2e/keyboard.e2e.ts` (focus race), `e2e-fullstack/ac1-gmail.e2e.ts` "noise", `lib/portal/pow-core.test.ts` (timeout ใต้โหลด)
5. role-play รอบสองบน UI ใหม่ (รูปแบบใน `docs/qa/2026-11-02-roleplay-triage.md`; brief ฉบับเดิมไม่ได้อยู่ใน repo — เขียนใหม่ตามรูปแบบนั้น)

## กติกาที่ได้เรียนรู้ (ใช้ต่อ)
- integration/e2e **ห้ามชี้ DB/Redis/MinIO ของ stack ที่เปิดอยู่** — ใช้ container ทิ้งได้ (`docs/runbooks/local-poc.md` §6) · หลายงานรันพร้อมกันต้องแยกชุด
- web e2e: port 3100 ตายตัว, ต้อง `pnpm build` ก่อน, `PW_CHANNEL=chrome` บนเครื่องนี้ · full-stack สร้าง stack ของตัวเอง (ต้องตั้ง `TEST_DATABASE_URL`)
- test e2e ที่ตรวจ "ไม่ reload" ต้องตรวจทั้ง document **และ** ว่า element ของ shell ยังเป็นตัวเดิม (บทเรียนจากรอบนี้)
- หลัง pull ที่มี dependency ใหม่: `pnpm install --frozen-lockfile`
- งานที่แตะ redaction/upload/auth/การค้นหา PII: reviewer คนละตัวก่อน merge เสมอ — รอบนี้จับปัญหาจริงได้ทุกครั้ง
- อย่าเขียนสคริปต์ชั่วคราวชื่อซ้ำกันใน scratchpad ที่ใช้ร่วมกัน (มี agent รันสคริปต์ของอีกตัวผิดไฟล์)

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- ข้อความ "Counted in business hours" / "นับเฉพาะเวลาทำการ" `[ASSUMED]` ว่า calendar ของ policy เป็น business hours
- recall ของ name-cue กับข้อความลูกค้าจริง `[UNVERIFIED]` (T-302)
- ปุ่มเลือกไฟล์บนมือถือจริง `[UNVERIFIED 80%]` · memory ของ upload วัดใน harness ไม่ใช่ container `[UNVERIFIED]`
- แถวสถานะ rail ตอนมีปัญหา (reconnecting/API unreachable) ทดสอบแค่ unit ยังไม่เห็นบนจอจริง `[UNVERIFIED]`
- skeleton ตอนกลับหน้าเดิมหลัง cache เกิน 30 s ยังไม่ได้วัด `[UNVERIFIED]`
