# ADR-032 — Codex continuation แบบ checkpoint + heartbeat

- **Status:** Accepted 2026-11-06 โดย main thread ตามคำสั่งเจ้าของ
- **Context:** เจ้าของต้องการหยุดเมื่อ 5-hour/weekly quota เต็ม และทำงานต่อหลัง reset โดยประหยัด quota รวมทั้ง deploy/push/หยุด container ทดสอบ

## Decision
- ใช้ Codex app heartbeat ของแชตนี้ทุกชั่วโมง (`watchtower-checkpoint`) เป็นตัวปลุก ไม่สร้าง cron หรือ CLI daemon ซ้ำ
- บันทึกสถานะงานแบบ atomic ใน Git common directory (`info`) นอก tracked files ไม่มี prompt, credential หรือข้อมูลลูกค้า; HANDOFF เป็นแหล่งความจริงสำหรับคนและ agent ต่าง vendor
- ทุกครั้งตรวจ usage ด้วยเครื่องมือของ Codex ก่อนงานหนัก; เมื่อ window ใดเหลือ ≤5% หรือถูกระงับ ให้บันทึกเวลาที่พร้อมใช้ทั้งสอง window และจบรอบ ห้ามหมุนบัญชี ซื้อเครดิต หรือวน retry
- ทำครั้งละ bounded task, จำกัด dev พร้อมกัน 1 ตัวและ reviewer 1 ตัว; checkpoint ก่อน/หลังงานพร้อม commit และผล test ใช้ script กับงาน deterministic
- หลังตรวจ acceptance ครบจึง mark completed และปิด heartbeat. การ deploy/push ได้รับอนุมัติแล้ว; autosend stage 3 ยังปิด

## Consequences
- heartbeat ไม่ได้เพิ่ม quota และไม่รับประกันเวลาปลุกหลัง reset. ต้องเปิดแอปและเครื่องให้ scheduler ทำงาน; เครื่องปิดหรือบัญชีหมดโควตาอาจทำให้เริ่มช้า
- checkpoint ช่วยกู้สถานะหลัง interruption ได้ แม้ agent ไม่มีโอกาสเขียนข้อความตอน quota หมด
- ไม่ใช้ API key ใหม่ ไม่อ่าน login cache/auth และไม่เปลี่ยน boundary ของระบบ Watchtower

## Links
- [Codex resume](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (อ่าน 2026-11-06)
- [Goals lifecycle](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) (อ่าน 2026-11-06)
