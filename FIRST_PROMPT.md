# FIRST PROMPT — ใช้เปิด session แรกของ AI ที่จะ build Watchtower

> วิธีใช้: unzip ชุดนี้ลง `D:\Works\watchtower` (หรือโฟลเดอร์ที่ต้องการ) → เปิด AI coding agent ในโฟลเดอร์นั้น (Claude Code / Codex / Gemini CLI / Cursor …) → วางข้อความใต้เส้นทั้งหมดเป็นข้อความแรก
> ข้อความนี้เขียนแบบ model-agnostic: AI ที่ไม่มี sub-agent/slash command ให้ทำตามคำอธิบายใน `docs/00-START-HERE.md` ด้วย session แยกต่อ role แทน

---

คุณกำลังจะเริ่มสร้างโปรเจกต์ **Watchtower** — open-source AI command center สำหรับทีม Tech Operations ผมคือเจ้าของโปรเจกต์และผู้ตัดสินใจสุดท้าย

โฟลเดอร์นี้มีแผนครบแล้ว **ห้ามเขียนโค้ดก่อนอ่านตามลำดับนี้:**
1. `AGENTS.md` — กติกากลาง, Non-negotiables N1–N10, แผนที่เอกสาร, ป้ายกำกับ claim, เมื่อไรต้องหยุดถามผม
2. `HANDOFF.md` — สถานะปัจจุบัน (ยังไม่มีโค้ด; Phase 0 เริ่มที่ T-000)
3. `docs/00-START-HERE.md` — phase, role/sub-agent, Definition of Done, `[ASK-HUMAN]`
4. `docs/01-PRD.md` — product spec (อ่าน §0–§3, §4.1, §4.9, §7, §8, §12, §15 ให้จบสำหรับ Phase 0; ส่วนอื่นอ่านเมื่อถึง phase นั้น)
5. `docs/decisions/ADR-001-stack.md` — stack และ deployment (Docker local ก่อน → GCP ทีหลัง) **ตัดสินใจแล้ว ห้ามเปลี่ยนโดยไม่มี ADR ใหม่**
6. `docs/BACKLOG.md` — งาน Phase 0: T-000 … T-012

เมื่ออ่านครบ ให้ทำสิ่งนี้ **ก่อนลงมือ**:
- สร้าง `logs/daily/<วันนี้ เวลากรุงเทพ>.md` จาก `docs/templates/daily-log.template.md` แล้ว log ทุก action ระหว่างทำ (ไม่ใช่รวบตอนจบ; shell remote อาจเป็น UTC → ใช้ `TZ=Asia/Bangkok date`)
- ตอบผมสั้น ๆ (≤ 20 บรรทัด): (ก) คุณเข้าใจว่าจะสร้างอะไรใน Phase 0 และ exit criteria คืออะไร (ข) สิ่งที่คุณจะตัดสินใจเองแบบ `[ASSUMED]` ใน Phase 0 (ค) คำถามที่เปลี่ยนทิศทางงานได้จริง **ไม่เกิน 5 ข้อ** — ถ้าผมยังไม่ตอบ ให้ใช้ค่า `[ASSUMED]` ใน PRD §16/ADR-001 แล้วบันทึกใน `docs/STATUS.md` → Open questions
- ยืนยันว่าคุณจะไม่ต่อ credential จริงใด ๆ (ทุก integration = mock mode) และจะไม่ push ไป remote จนกว่าผมจะให้ URL

จากนั้นเริ่ม **Phase 0** ตาม `.claude/commands/phase-0-bootstrap.md` (Claude Code: รัน `/phase-0-bootstrap`; AI อื่น: ทำตามขั้นตอนในไฟล์นั้นเอง โดยเปิด session แยกต่อ role ตาม `.claude/agents/<role>.md`):
- T-000 คุณทำเอง (git init, hooks, commit แผน)
- งาน implement ส่ง role ที่กำหนด (`architect`, `backend-dev` ∥ `frontend-dev`, `qa-engineer`, `security-reviewer`, `po`) — คุณเป็น main thread: ตัดสินใจ, เขียน docs/ADR/STATUS/HANDOFF, **ตรวจซ้ำผลของทุก role ก่อน commit** (รัน test เอง ไม่เชื่อคำบอก)
- ผู้ตรวจ (`po`, `qa-engineer`, `security-reviewer`) ต้องไม่ใช่ตัวที่ผลิตงานนั้น
- ทุก task ปิดด้วย DoD ใน `docs/00-START-HERE.md`: test + lint + typecheck ผ่าน, STATUS/BACKLOG อัปเดต, ป้าย `[ASSUMED]`/`[UNVERIFIED]` ครบ, ADR ถ้ามีการตัดสินใจใหม่
- Phase 0 ถือว่าเสร็จเมื่อ: `docker compose up` ขึ้นครบ, auth + RBAC + audit log + org/contact/ticket core + portal channel + three-pane shell + seed ทำงาน, e2e **AC-1 (portal path)** ผ่าน, `security-reviewer` และ `po` review ผ่าน, แล้วรัน `/handoff` (อัปเดต `HANDOFF.md`, daily log, `docs/STATUS.md`, `CHANGELOG.md` 0.0.1, tag `v0.0.1`)

กติกาสั้น ๆ ที่ผมจะถือเคร่งครัด: ไม่มี secret ใน repo/log/transcript · แยกยืนยันแล้วกับเดา · ค้นก่อนสร้าง · งานไม่เสร็จจนกว่าจะเขียนกลับ `HANDOFF.md` + daily log + STATUS · หยุดถามผมตามรายการ `[ASK-HUMAN]` ใน `AGENTS.md` และ `docs/00-START-HERE.md` นอกนั้นตัดสินใจเองแล้วบันทึกเหตุผล

ตอบเป็นภาษาไทย ศัพท์เทคนิคคงอังกฤษ · โค้ด/commit/identifier เป็นอังกฤษ · เริ่มได้
