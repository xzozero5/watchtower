# PO takeover + stakeholder QA — 2026-11-03

## ขอบเขตและเหตุผล

เจ้าของมอบให้ PO รับช่วง ทำความเข้าใจ ทดสอบจากหลาย stakeholder และเลือกปรับปรุงตามคุณค่า เริ่มจาก AGENTS/HANDOFF/STATUS/BACKLOG/PRD และ source จริง ใช้ agent จำลองมุมมอง support agent, lead/head, developer, ลูกค้า portal และ operations ร่วมกับ independent QA/security reviewer ไม่ได้เชิญหรือสัมภาษณ์ผู้ใช้จริงรอบนี้

ตัดสินใจแก้เส้นทางรับเรื่อง–อ่านหลักฐาน–ติดตามงานก่อน Phase 3 เพราะบั๊กใน flow เหล่านี้ยังทำให้ลูกค้ารอและ dashboard พาไปผิดรายการ ไม่มีการเปลี่ยน stack/schema/autonomy หรือเพิ่ม dependency

## ความเข้าใจระบบสำหรับ PO ที่รับช่วง

Watchtower รวมงาน Tech Operations ของ B2B SaaS: signal จาก email/LINE/portal กลายเป็น ticket พร้อม owner/SLA; alert ผูก incident; agent ใช้หลักฐานจาก investigation/KB และตรวจ draft ของ AI ก่อนตอบ; brief/handoff รักษาความต่อเนื่องระหว่างกะ; lead/head ดู workload, SLA และสุขภาพระบบ งานสำเร็จเมื่อคำขอลูกค้าถูกจัดการและส่งต่อได้ครบ ไม่ใช่เพียงจำนวนหน้าจอหรือจำนวน test

โครงระบบตาม architecture/ADR: Next.js web คุย REST/WebSocket กับ NestJS API; Postgres+pgvector เก็บ domain/audit/KB, Redis+BullMQ ส่งงานให้ worker ทำ ingestion/AI/scheduling/email; object storage ผ่าน adapter แยกต่างหาก Package boundaries บังคับด้วย lint/tests การเปลี่ยนรอบนี้อยู่ใน web และ QA/docs จึงไม่ต้อง migrate schema

สิทธิ์ต้องแยกตามงาน: agent จัดการและตอบลูกค้า, lead จัดทีม/กะ, head ตั้งค่าระบบ, dev อ่านข้อมูล masked และส่ง internal note แต่ไม่ตอบลูกค้า, client เห็นเฉพาะ org/สิทธิ์ของลิงก์ตนเอง AI ต้อง redact PII/audit และ default draft-for-approval ตาม N3/N4 การมีปุ่มแนะนำไม่ทำให้การพัก SLA/การส่งข้อความข้ามการตัดสินใจของคน

ความพร้อมปัจจุบันแยกสองชั้น: localhost POC ต่อ Google/Gmail/Claude CLI จริงบางส่วนตาม HANDOFF; regression รอบนี้ใช้ fixture/mock สำหรับ external adapters แต่ API/worker/DB/Redis/Mailpit ใน full-stack เป็น process/service จริง การผ่านชุดนี้ยังไม่ยืนยัน staging, internet readiness, external credential configuration หรือคุณภาพคำตอบกับลูกค้าจริง

ตัวชี้วัดรอบ pilot ควรยึด PRD §1.3: เวลา signal→ticket/AI report, draft acceptance, first-response SLA, reopen, handoff acknowledgment และสัดส่วนงานที่ agent ทำจบในระบบ เป้าตัวเลขเดิมยังเป็น ASSUMED; รอบนี้เพิ่มความถูกต้องของ flow/ตัวเลขก่อนเก็บ baseline จากผู้ใช้จริง

## Findings → การปรับปรุง

| Finding | ผลกระทบ | ผลแก้และ acceptance |
| --- | --- | --- |
| T-156 | Staff timeline ไม่มีไฟล์แนบให้เปิด แม้ API route มีแล้ว | แสดงชื่อ/ขนาด ดาวน์โหลดผ่าน authenticated API เดิม; pending/error/retry; refresh session ร่วม coordinator; masked dev ไม่เห็น raw file |
| T-158 ส่วน QA-06 | AI Wait ข้าม warning เดิม ทำ SLA พักขณะยังไม่ตอบลูกค้า | อ่าน timeline ล่าสุดก่อน action; confirm/cancel; อ่านไม่ได้/ยังโหลดไม่ครบไม่เปลี่ยนสถานะ; delayed callback หลังเปลี่ยนหน้าไม่เขียน ticket เก่า |
| T-162 / Home | Unassigned นับ 5 statuses แต่ link/oldest query ใช้ 3 | ใช้ open statuses เดียวกันทั้ง count/link/oldest |
| T-162 / Home | SLA tile/show-all มีเพียง sort เปิดคิวทั้งหมด | ส่ง slaState at_risk+breached และ sort เดียวกับรายการ SLA |
| T-162 / Home | Show-all ใช้จำนวน preview สูงสุด 50 เป็นยอดทั้งหมด | ใช้ authoritative total; ไม่มี counts ใช้ lower bound เมื่อมี nextCursor |
| T-162 / Home | Developer อยู่ใน support workload ทั้งที่รับ assignee ไม่ได้ | แสดงเฉพาะ active agent/lead/head |
| T-162 / Home | No queue link เปิดทุก queue | แสดงเป็นจำนวนธรรมดาจน API รองรับ filter นี้ ไม่ทำเป็นลิงก์ผิด |
| B-001 / T-163 | ลิงก์ ticket เดิมในแท็บเดิมไม่รับ fragment/refetch | hashchange รับ token และล้าง fragment; opaque revision บังคับ fresh read แม้ token เดิม; stale GET/POST401 ไม่ลบ access ใหม่; current401 ยัง revoke |
| T-164 | AGENTS อ้าง testing/checklist แต่ไฟล์ไม่มีจริง | เพิ่ม docs/07-TESTING.md และ docs/08-QA-CHECKLIST.md จาก runner/coverage จริง |
| T-161 เฉพาะ PoW test | Batch-invariance testทำ WebCrypto 100000 digests โดยเกินknown solutionมาก จนtimeoutใต้โหลด | QAใช้known8-bit vectorและcap169 attempts ยังรักษาทั้ง4batch sizes+assert attempts; tests12/16-bitและindependent cryptoยังอยู่ครบ ไม่เพิ่มtimeout/retryหรือเปลี่ยนproduct |

## หลักฐานและขอบเขต

- [TESTED] ก่อนแก้: browser regression เดิม 59/59 ผ่าน แต่ independent acceptance ใหม่ reproduce ได้ 3/3 bugs (Home link, AI Wait, attachment missing)
- [TESTED] หลังแก้: independent browser acceptance 5/5 ผ่าน รวม download จริงจาก mock binary route + axe, cancel/confirm, hashchange และ delayed-navigation race
- [TESTED] Security review จับ late POST401 race หลัง fix รอบแรก แล้ว producer แก้และเพิ่ม regression; security reviewer รัน tracking suite เอง 29/29 ผ่าน
- [TESTED] Unit เดิม retry timeline เลือกปุ่ม Try again ทั้งหน้าซึ่งมีมากกว่าหนึ่ง section: QA แก้ scope ให้ตรง Conversation และรัน 31/31 ผ่าน
- [TESTED] Gateสุดท้ายmain: build/lint/typecheckผ่าน; unit+boundaries4911ผ่าน/29contract skips (18targets,0cache, concurrency1/maxWorkers4); web1228และboundaries238; final-build browser acceptanceรันเอง5/5; command/ข้อผิดพลาดระหว่างทางอยู่ STATUS
- [TESTED] Fullstack เดิมหลังเอา B-001 marker/workaround ออก completed38: ผ่านจริง37 + expected failure1 (B-003 Gmail auto-ack ที่ยังไม่ทำ); ไม่เรียก expected failure ว่าfeatureผ่าน

## งานต่อที่สำคัญ

1. T-154/T-155 ปิดข้อจำกัด capacity/storage ก่อนเปิด portal สู่ internet (malware dependency ยังต้องเจ้าของตัดสิน)
2. T-159 เติม history/trend ที่มี API รองรับ และ T-158 ส่วน rail counts (ยังไม่ปิดทั้ง task)
3. T-113/T-114/T-207 เติม coverage AC-3/5/7/dev/RBAC และ review phase โดยแยกผล mock จาก external sandbox
4. T-161 วิเคราะห์ flaky ที่บันทึกไว้โดยไม่ลด assertion หรือเพิ่ม retry เพื่อทำเขียว
5. T-115 pilot กับผู้ใช้จริง พร้อมเก็บเวลาทำงาน/ความสำเร็จ/feedback แยกแต่ละ role ก่อนยกระดับ autonomy

[UNVERIFIED] ข้อความไทยยังไม่ผ่านเจ้าของภาษา, mobile จริง, external integrations, production readiness และ gate stage3 ไม่ได้ถูกยืนยันจากรอบนี้
