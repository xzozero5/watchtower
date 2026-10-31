---
description: ปิด session — อัปเดต HANDOFF.md, daily log, STATUS, ADR แล้ว commit
---
1. อ่าน `HANDOFF.md` ปัจจุบัน, `git status`, `git log --oneline -20` ของ session นี้
2. เขียน `HANDOFF.md` ใหม่ตาม `docs/templates/HANDOFF.template.md` — เขียนทับสถานะ ไม่ append ประวัติ, ≤ 40 KB; เรื่องที่จบย้ายไป `docs/handoff-archive/HANDOFF-<ช่วงวันที่>.md`
3. append `logs/daily/$(TZ=Asia/Bangkok date '+%F').md` ให้ครบ (รวม token/ต้นทุนถ้ามี) + หัวข้อ "สถานะตอนจบ"
4. อัปเดต `docs/STATUS.md` (entry ต่อ task + ตารางสถานะปัจจุบัน + Open questions) และติ๊ก `docs/BACKLOG.md`
5. การตัดสินใจสำคัญที่ยังอยู่แค่ในบทสนทนา → ADR ใหม่ (`docs/templates/adr.template.md`) + เพิ่มใน `docs/decisions/README.md`
6. ทดสอบในใจ: session ใหม่ (หรือ AI อื่น) ที่อ่านแค่ `AGENTS.md` + `HANDOFF.md` รู้ไหมว่าต้องทำอะไรต่อ ที่ไฟล์ไหน ด้วยคำสั่งอะไร
7. test/lint ผ่าน → commit (`docs: handoff <วันที่>` + งานอื่นแยก commit) → `git push` ถ้ามี remote
