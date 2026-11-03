# QA acceptance checklist

ใช้ PRD/ADR เป็นเกณฑ์ตัดสิน รายการนี้เป็น coverage matrix สำหรับผู้ตรวจคนละตัวกับผู้ผลิต (N7) ไม่ใช่ผลทดสอบสำเร็จ ผลล่าสุดดู `docs/qa/2026-11-03-po-quality-sweep.md` และ STATUS

| Stakeholder | Scenario ที่ต้องตรวจ | หลักฐานที่ควรเก็บ |
| --- | --- | --- |
| Support agent | รับเรื่อง ค้นหา มอบหมาย ตอบ/undo ส่ง internal note ปิด/reopen ticket | queue และ timeline ตรงกัน; note ไม่ออกสู่ลูกค้า; cancelled/failed reply ไม่ถือว่าตอบแล้ว |
| Support agent | อ่านหลักฐานจากไฟล์แนบ | ชื่อ/ขนาด/download, error/retry, session refresh, ป้องกันกดซ้ำ; ไม่เปิดไฟล์ inline หรือเผย bucket URL |
| Support lead | รับกะ brief/handoff และส่งต่อครบ | AC-7; acknowledgment ค้างยังเห็น; keyboard และ focus ใช้งานได้ |
| Head / lead | กดตัวเลข SLA/unassigned/คน/queue จาก Home | filter และจำนวนใช้ scope เดียวกัน; preview ไม่ปลอมเป็นยอดรวม; error/partial data ระบุชัด |
| Developer | รับงาน dev อ่าน masked data และเขียน note | raw PII/ไฟล์/คำตอบลูกค้าเข้าไม่ถึงทั้ง UI และ API; ไม่ถูกนับเป็น support assignee |
| Client / portal | ส่ง request, รับลิงก์ ตอบ ติดตาม ปิด/reopen | AC-1/R-9; org isolation, token expiry, เปิดลิงก์ใหม่ในแท็บเดิมได้, fragment ถูกล้าง |
| Client / portal | ลิงก์เปลี่ยนขณะ request ก่อนหน้ายังค้าง | late GET/POST 401 ไม่ลบสิทธิ์ใหม่; current 401 ยัง revoke ได้; ไม่มี token ใน cache key/log |
| Ops / incident commander | Alert dedup/escalation, incident/status page, investigation | AC-3/AC-5; read-only tools + rate/cost budgets; audit ของการเปลี่ยนสถานะ |
| AI reviewer | Accept/edit/reject, confidence/citations, next step | N3/N4; ไม่มี auto-send เกิน stage; “รอลูกค้า” เตือนก่อนพัก SLA เมื่อยังไม่ตอบ; cancel ไม่มี write |
| Security / privacy | RBAC, redaction, uploads, audit, secrets | integration tests กับ role จริงใน harness; source review; ห้ามใช้ mock UI เป็นข้อพิสูจน์ RBAC |

## ก่อนปิดแต่ละงาน

- [ ] ระบุ acceptance ที่เปลี่ยนกับ regression ที่เกี่ยวข้อง
- [ ] Unit/integration ตาม scope ผ่าน และ lint/typecheck ผ่าน
- [ ] Browser ผ่านเมื่อเปลี่ยน flow; ตรวจ a11y ด้วย axe, keyboard, focus และ viewport ตาม flow
- [ ] ทดสอบ error/retry, double action, stale request และ unmount ถ้าเกี่ยวข้อง
- [ ] Reviewer ไม่ใช่ producer; ข้อพบสำคัญแก้และตรวจซ้ำ
- [ ] ระบุ expected failures/skips และสิ่งที่ mock ชัดเจน
- [ ] Update STATUS/BACKLOG/HANDOFF/daily log; มีคำสั่งทำซ้ำ

## ก่อน pilot / เปิด internet (ยังต้องตรวจแยก)

- [ ] T-154 upload admission/slow-client capacity ผ่าน load/security review
- [ ] T-155 quota/retention/orphan sweep/download streaming และ malware decision ผ่าน
- [ ] Workspace/deploy configuration ผ่าน staging runbook; ไม่ใช้ POC gmail allow-list เป็น production signoff
- [ ] External integration แต่ละตัวผ่าน sandbox และเจ้าของอนุมัติการส่งข้อความจริง
- [ ] Autonomy ≥3 ผ่าน gate และการอนุมัติเจ้าของตาม PRD/ADR-011

ช่องที่ยังไม่ติ๊กไม่ได้แปลว่าล้มเหลวทั้งหมด แต่ต้องมีหลักฐานก่อนอ้างว่า readiness gate ผ่าน
