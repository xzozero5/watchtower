# T-432 — ตรวจซ้ำ T-435 (2026-11-06)

ผู้ตรวจ `security-reviewer` คนละ agent กับผู้ผลิต; static review และ targeted tests, ไม่ใช้ credential หรือเรียกโมเดลจริง

- ไม่พบ P1/P2 ค้างในขอบเขตที่ตรวจ
- C-1: embedding มี daily token cap แยกจาก LLM, re-embed หยุดแบบ deferred
- C-2: runtime อยู่ `embed` internal เท่านั้น; init ใช้ loopback server ของตัวเองบน `embed-egress`
- C-3/4/6/8: exact host allow-list, response cap 8 MiB, hardening/pin image และข้อความ index transition ถูกแก้แล้ว
- Residual P3: debug overlay เปิด admin API/egress ชั่วคราว; query ใช้ slot ร่วมกับ re-embed; DNS ไม่ pin
- ผู้ตรวจรัน tests: AI local provider + embedding audit 46, domain budget/guard 15, shared compose 35, API embedding 6 ผ่าน
- Main อ่านผล/ไฟล์จริงก่อน Accepted; ไม่อ้างว่า image จริงหรือโมเดลไทยผ่านแล้ว

ยังไม่ยืนยัน: real-image startup/permissions/init, runtime egress isolation, Host/Origin และ RAM. คง T-433 live enable แยกต่างหาก
