# Prompt: ทำต่อ Watchtower บนเครื่อง local (หลัง pause 2026-11-01)

คัดลอกข้อความด้านล่างไปวางใน Claude Code บนเครื่อง (เปิดที่ root ของ repo)

---

ทำต่อโปรเจกต์ Watchtower บนเครื่องนี้แบบอัตโนมัติจนจบ Phase 1 ผมคือเจ้าของโปรเจกต์ งานถูก pause จาก cloud session เมื่อ 2026-11-01 11:40 (เวลากรุงเทพ)

**เริ่มต้น**
1. `git fetch origin && git checkout main && git pull` แล้วอ่านตามลำดับ: `AGENTS.md` → `HANDOFF.md` (ทั้งไฟล์) → `docs/STATUS.md` หัวข้อ "สถานะปัจจุบัน" + "กติกาจากบทเรียน" → `docs/BACKLOG.md` → `docs/00-START-HERE.md`
2. setup: `git config core.hooksPath tools/githooks` · ตั้ง `TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1` · `pnpm install` · `docker compose up -d postgres redis minio mailpit` · ตรวจว่า `.git/info/forbidden-terms` มีรายการจริง (ถ้าไม่มี ให้บันทึก `[ASK-HUMAN]` แล้วทำต่อ — ห้ามเดารายการเอง ห้ามพิมพ์รายการลง log/commit)
3. สร้าง/ต่อ `logs/daily/<วันนี้>.md` (เวลา `TZ=Asia/Bangkok date '+%H:%M'`) และ log ทุก action

**ลำดับงาน** (รายละเอียดใน `HANDOFF.md` หัวข้อ "งานค้างบน branch" และ "ทำต่อบน local")
1. **T-103b–d LINE** — branch `verify/t-103bd` พร้อม merge แล้วเหลือแค่รัน `pnpm exec turbo run test:integration --force --concurrency=1` ให้ครบ (api/worker ยังไม่มีผล) + lint/typecheck/test/e2e → ถ้าเขียว merge เข้า `main` (`--no-ff`) + STATUS/BACKLOG + เพิ่ม T-103e
2. **T-102b–d Gmail** — `wip/t-102bd`: ให้ `security-reviewer` ตรวจซ้ำ N-1..N-3 (opt-in `GMAIL_MOCK_ENABLED`) → `verify/t-102bd` จาก `main` ใหม่ → เปลี่ยนเลข migration ที่ชน (`0015_gmail_account_state` → เลขถัดไป, แก้ test ที่อ้างชื่อ migration) → suite เต็ม → merge · แก้ PRD R-2.4 ให้ scope = `gmail.readonly` + `gmail.send`
3. **T-107a–c KB** — `wip/t-107ac` (`2bcac4a` เป็น `wip:` build ไม่ผ่าน, จุดสะอาด `80e301e`): ทำ P2-A, P2-B, P3-C..F ให้จบตาม HANDOFF → security re-review → merge (เปลี่ยนเลข migration `0013_kb`)
4. ต่อ wave 3–4 ตาม `HANDOFF.md`/`docs/BACKLOG.md`: T-108, T-109, T-104, T-105, T-110, T-111, T-119, T-121, T-116c, T-123b, T-118, T-122f → T-113 → T-114 → T-125 → **หยุดที่ T-115**: เตรียม `.env.example` + คู่มือ credential แล้วปิดด้วย `/handoff`

**วิธีทำงาน**
- งานที่ไม่ขึ้นต่อกันและไม่แตะไฟล์เดียวกันรันขนานใน worktree แยก แล้ว main thread ตรวจซ้ำและ merge ทีละงาน
- ทุก merge: `git checkout -b verify/<task> main && git merge --no-ff wip/<task>` → main thread รัน `turbo run … --force` เอง (lint, typecheck, test, test:integration `--concurrency=1`, e2e, e2e:fullstack) → ห้ามเชื่อรายงานของ agent
- งานที่แตะ channel, AI, auth, RBAC, PII, credential ต้องผ่าน `security-reviewer` · finding P0/P1 ต้องแก้ก่อน merge (`po` ยกเว้นไม่ได้) · ผู้ตรวจต้องไม่ใช่ agent ที่ผลิตงาน (N7)
- เรื่องที่ปกติต้องถามผม ให้ถาม `po` แทน ติดป้าย `[ASSUMED]` และบันทึกคำถาม/คำตอบ/เหตุผลลงตาราง "PO ตัดสินแทนเจ้าของ" ใน `HANDOFF.md` (ต่อจากข้อ 27) · `po` ห้ามตรวจงานที่ตัวเองตัดสิน
- ถ้ารัน docker/integration/e2e ไม่ได้ ห้ามนับว่าผ่านและห้ามอ้างว่าผ่าน · ยังไม่ tag `v0.0.1`
- จบทุก task: commit เล็ก ๆ (prefix `web:` `api:` `worker:` `db:` `domain:` `ai:` `docs:` `infra:`) → push · อัปเดต `HANDOFF.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `logs/daily/` · push เข้า `main` เฉพาะงานที่ test ผ่าน งานที่ยังไม่ผ่านอยู่บน `wip/<task>`
- ถ้าคำสั่งถูก permission หรือ hook ปฏิเสธ ห้ามอ้อม ให้บันทึกแล้วทำงานส่วนอื่นต่อ

**ห้ามทำแทนผม แม้ `po` จะเห็นชอบ** (ข้ามงานส่วนนั้น บันทึก `[ASK-HUMAN]` ใน `HANDOFF.md` แล้วทำส่วนอื่นต่อ)
- ใช้หรือต่อ credential จริงใด ๆ — ทุก integration ต้องเป็น mock mode
- ส่งข้อความถึงลูกค้าจริง หรือเชื่อมต่อ production จริง
- ยก autonomy ของ intent ใดขึ้นเป็น stage 3 หรือสูงกว่า
- ลดกฎ Non-negotiables N1–N10, แก้ `.claude/` หรือ guard เพื่อให้งานผ่าน
- สิ่งที่ย้อนกลับไม่ได้: force push, ลบข้อมูล, แก้ history บน `main`
- เพิ่ม dependency ที่ runtime ยิงออกไปปลายทางใหม่ นอกจากที่ PRD กำหนดไว้สำหรับ integration นั้น
- ใช้เงินเกินงบใน `config/budgets.yaml`

Repo เป็น public และเป็นกลาง ห้ามมีชื่อหรือข้อมูลขององค์กรที่นำไปใช้ รวมถึงใน commit, log และข้อมูลตัวอย่าง · ตอบผมเป็นภาษาไทย โค้ด/commit/identifier เป็นภาษาอังกฤษ · จบแล้ว `HANDOFF.md` ต้องอ่านจบในไม่กี่นาที: ทำอะไรเสร็จ, อะไรล้ม/ยังไม่ยืนยัน, `po` ตัดสินอะไรแทน, ผมต้องทำอะไรก่อน pilot
