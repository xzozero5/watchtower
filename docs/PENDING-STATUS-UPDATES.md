# PENDING — ข้อความรอลง STATUS / BACKLOG / HANDOFF

> ไฟล์ชั่วคราว: `guard.py` บล็อก Edit ของ `docs/STATUS.md`, `docs/BACKLOG.md`, `HANDOFF.md` เพราะ `WT_MAIN_THREAD` ไม่ถูกตั้ง และการตั้งผ่าน `.claude/settings.local.json` โดย agent ถูก auto mode ปฏิเสธ (self-modification) — รอเจ้าของตัดสิน `[ASK-HUMAN]`
> เมื่อปลดแล้ว main thread ย้ายเนื้อหานี้เข้าไฟล์จริงแล้วลบไฟล์นี้

## BACKLOG — ติ๊ก
- [x] T-000

## STATUS — สถานะปัจจุบัน
- 0 Foundation: 🟨 กำลังทำ · push รอเจ้าของ (repo เป็น public)

## STATUS — Open questions (เพิ่ม)
- `[CONFIRMED 2026-10-31]` repo เป็น public และเป็นกลาง ไม่ผูกกับองค์กรใด — บริษัทที่ใช้จะ fork ไปใส่ข้อมูลตัวเอง
- `[ASK-HUMAN]` เจ้าของอนุมัติให้ยกเว้น `.env.example` จาก `permissions.deny` `Read(**/.env.*)` แต่ agent แก้ `.claude/settings.json` ไม่ได้ (auto mode: self-modification) → เจ้าของแก้เอง ระหว่างนี้ append section ใหม่โดยไม่อ่าน
- `[ASK-HUMAN]` `WT_MAIN_THREAD` ต้องตั้งให้ main thread เขียน STATUS/BACKLOG/HANDOFF ได้ และตัวแปรเดียวกันจะปลดให้ sub-agent ด้วย
- `[CONFIRMED 2026-10-31]` Google Workspace domain ของ SSO: อ่านจาก env ค่าตัวอย่าง `example.com`
- `[ASSUMED]` งบ `build_ai` $10/session วัดไม่ได้บน Max plan → ดู % plan limit แทน

## STATUS — กติกาจากบทเรียน (เพิ่ม)
- `TZ=Asia/Bangkok date` บน Git Bash (Windows) ให้เวลา GMT ผิด 7 ชม. เพราะไม่มี zoneinfo → ใช้ `TZ=ICT-7 date` `[TESTED]`
- บรรทัดใน `.gitignore` ห้ามมี comment ต่อท้าย pattern (`/data/ # ...` ไม่ match อะไรเลย)

## STATUS — Log
### 2026-10-31 21:30 (Asia/Bangkok) — main thread — T-000
- ทำอะไร: git init ต่อจาก `origin/main` (`f848253`, LICENSE Apache-2.0) เพื่อให้ push ภายหลังเป็น fast-forward, เปิด hooks, แก้ `.gitignore`, เพิ่ม `.gitattributes` (LF), commit แผน
- ไฟล์ที่แตะ: `.gitignore`, `.gitattributes`, `AGENTS.md`, ทั้งชุดแผน
- test: pre-commit hook รันตอน commit
- ค้าง: push (ดู Open questions)
