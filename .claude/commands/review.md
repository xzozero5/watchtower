---
description: ให้ po + architect (+ security-reviewer ถ้าเกี่ยว) review งานล่าสุดก่อน commit
argument-hint: [T-xxx หรือ path]
---
Review งาน $ARGUMENTS:
1. `git diff --stat` และ `git status` ดูไฟล์ที่เปลี่ยน
2. เรียก `po` ตรวจ AC/requirement + Non-negotiables; เรียก `architect` ถ้าแตะ `packages/db`, boundary ของ `packages/ai`/`channels`, หรือ compose/infra; เรียก `security-reviewer` ถ้าแตะ auth, secret, webhook, AI tool handlers, PII, network
3. รวม findings เรียง severity → แก้ P0/P1 ก่อน commit (มอบ dev agent ที่ไม่ใช่ผู้ตรวจ); P2 ลง BACKLOG
4. main thread รัน test/lint เองให้ผ่าน แล้วค่อยเสนอข้อความ commit (scope prefix)
