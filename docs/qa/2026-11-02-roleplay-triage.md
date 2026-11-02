# Role-play QA บน stack จริง (POC) — 2026-11-02

> ผู้ตรวจ: agent 5 บทบาท (L1 agent, lead→head, ลูกค้าบน portal, ux-designer, security-reviewer) ใช้ระบบจริงผ่าน headless Chrome (dev login, AI จริงผ่าน `claude -p` ADR-017, Gmail จริงแต่ห้ามแตะ) · รวมรายการและจัดลำดับโดย `po` · main thread ตรวจข้อเท็จจริงบางข้อกับ audit log/โค้ด
> รายงานดิบอยู่นอก repo (scratchpad ของ session) — ที่นี่เก็บเฉพาะผลที่ใช้ตัดสินใจ

## พบและแก้แล้วในคืนเดียวกัน
| เรื่อง | หลักฐาน | commit |
|---|---|---|
| Redactor ใส่ placeholder ชื่อ ("Smoke **Customer**") ลงใน system prompt ของเราเอง → enum `new_customer_issue` กลายเป็น `new_[NAME_2]_issue` → AI brief ล้ม `model_output_invalid` 2/3 ครั้ง · Evidence panel แสดง `[NAME_3] Org` | `ai_run.output` จริงกับ model จริง | merge `d3faac1` (ผ่าน security review 2 รอบ: รอบแรก "do not merge" เพราะ fix เดิมทำให้ชื่อเพื่อนร่วมงานจาก `similar_tickets` หลุดเข้า draft ลูกค้า → แก้เป็น audience `'staff'`) |
| `GET /v1/tickets/stats` 500 ทุก staff role เมื่อไม่มี filter (WHERE ว่าง) | security role-play | `659d032` |
| หน้า 404 โลโก้ทับหัวข้อ | QC บน stack จริง | `92471b3` |
| integration test ของ worker รันข้าง dev stack ไม่ได้ (S3/SMTP ตายตัว) | QC | `7d3f802` |

## รายการรวม (po) — bucket
**A ทำใน session นี้:** QA-01 แถวคิว (เลข OPS, SLA badge + "No SLA", เรียง SLA→priority ในกลุ่ม, "Needs you" เฉพาะของฉัน, assignee บนแถว) · QA-04 Reply บน channel ที่ส่งออกไม่ได้ (ปิดล่วงหน้า + แสดงข้อความจาก API) · QA-06 เตือนก่อนตั้ง "รอลูกค้า" ถ้ายังไม่ได้ถามอะไร · QA-07 AI card (เหตุผลเมื่อล้ม, intent แหล่งเดียว, relevance เป็นคำ + ตัวเลข, ลิงก์ org 404) · QA-09 ค้นด้วยเลข/อีเมล + Enter เปิด + go-to ใน palette · QA-11 สร้าง intent ใน UI (blocker) + คำอธิบาย stage 0–3 · QA-12 assignee picker ของ lead · QA-19a ชื่อ rail ภาษาไทยซ้ำ (Alerts/Notifications) · QA-22 portal: ETA + ขั้นต่อไป, 404 ของลูกค้า, copy หน้า login

**B ใส่ BACKLOG:** T-138 … T-149 (ดู `docs/BACKLOG.md` หัวข้อ "จาก role-play QA 2026-11-02")

**C ให้เจ้าของตัดสิน `[ASK-HUMAN]`:**
1. QA-30 (N4) ชื่อคนที่ไม่อยู่ใน dictionary หลุดถึง LLM (known gap ADR-008) — po เสนอ name-cue patterns TH/EN + ชื่อ requester ใน dictionary และเขียน DPIA note · ต้องตัดสินก่อน T-115
2. QA-02/QA-03 คิวจัดกลุ่มตาม AI state และ AI summary เป็นชื่อเรื่อง (ขอไว้ใน T-128) แต่ L1 บอกว่าบังความเร่งด่วน — po เสนอให้ P1/breached ลอยข้ามกลุ่ม และ subject เป็นบรรทัดแรก
3. QA-08 ปุ่มไอคอนล้วน (T-129/T-133) ผู้ใช้ 2 บทบาทสับสน — po เสนอ label สั้นเฉพาะ action หลักใน AI card
4. QA-20 สีใน rail/ชิปกะ — ผูกกับ redesign "Soft Beacon" ที่รออนุมัติ
5. QA-23 บัญชีลูกค้าจาก portal (magic link ไม่ส่งให้คนที่ไม่ใช่ client user เพื่อกัน enumeration — ตั้งใจ)

## คำตัดสิน bucket C — po ตัดสินแทนเจ้าของ (เจ้าของมอบอำนาจ 2026-11-02)
| ข้อ | คำตัดสิน | ทำที่ไหน |
|---|---|---|
| QA-30 | ไม่ยอมรับ gap แบบเงียบ ไม่แก้ถ้อยคำ N4 (po ไม่มีสิทธิ์) · เพิ่ม name-cue detector TH/EN + dictionary ต้องมี requester/contact ของ org + notice ในมุมมอง dev · residual = ชื่อไม่มี cue และไม่อยู่ใน dictionary · NER ไป T-153 · gate T-115 | ADR-008 แก้ไข 2026-11-02 · `ai-engineer` session นี้ |
| QA-02/03 | คงกลุ่มตาม AI state (T-128) แต่ "Needs you" ต้องรวม P1 + SLA breached/at-risk ทุกใบ (ตาม `ai-first-workspace.md:21` อยู่แล้ว) และเรียง breached → at-risk → priority → due · ชื่อเรื่อง = subject ของคน, AI summary เป็นบรรทัดสองพร้อมป้าย AI (N5) | FE-1 (แถว), FE-2 (header + brief) · แก้ design doc ด้วย |
| QA-08 | action ที่ตัดสินใจ (AI card: Approve/Send, Edit, Regenerate, Send to dev · composer Reply/Note · แท็บ right pane) ต้องมี label สั้นคู่ไอคอน · chrome รองยังเป็นไอคอน + tooltip · แท็บ default คงที่ | FE-2 · `less-text-ai-assistant.md` |
| QA-20 | กฎ "สีบอกสถานะเท่านั้น" ใช้ทันที (rail กลาง ๆ, tile ค่า 0 ไม่แดง) · ส่วนการรับ Soft Beacon ทั้งชุดยังรอเจ้าของ (นอกขอบเขตที่มอบ) · ชิปกะ + toast → T-151 | FE-1 (rail), FE-3 (tiles) |
| QA-23 | ไม่สร้างบัญชีลูกค้าอัตโนมัติจาก portal (อีเมลยังไม่ยืนยัน, PDPA, anti-enumeration) · เพิ่ม "ส่งลิงก์คำขอของฉันทางอีเมล" + session view ของ client → T-152 · ตอนนี้แก้ copy ชี้ไปที่ tracking link | FE-3 (copy), T-152 |

## ข้อที่รายงานแต่เป็นพฤติกรรมที่ตั้งใจ
- ลูกค้าขอ magic link แล้วไม่มีเมล: กัน enumeration (ตั้งใจ) — ที่ต้องแก้คือ copy
- "รอคำตอบจากคุณ" ทั้งที่ไม่มีคำถาม: staff ตั้งเอง (audit log ยืนยัน) — ขาด guardrail (QA-06)
- CSAT ไม่มาใน 15 นาที: R-10.1 หน่วง 1 ชม.
- SLA "FR 4h" แต่ due อีก 14 ชม.: business hours ตาม R-1.6 — ขาดคำอธิบาย
- ไม่มี top bar: T-124 ตัดออก → UI-SPEC §3.1 ต้องอัปเดต (spec drift)
- เมลที่ส่งถึงตัวเองไม่กลายเป็น ticket: มี label `SENT` → sync ข้ามโดยตั้งใจ

## ผ่านแล้ว (ทดสอบจริง)
RBAC 70 GET + 30 mutation route ต่อ role · customer อ่านข้าม org ไม่ได้ · N3 ตั้ง stage ≥ 3 ถูกปฏิเสธ · CSRF/Origin/CORS · logout + magic link ใช้ซ้ำไม่ได้ · webhook ไม่มี signature → 401/503 · XSS payload ไม่รัน · prompt injection ถูกเพิกเฉย · audit ครบพร้อม actor · Gmail push จริง → 204 → sync
