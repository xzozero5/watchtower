# ADR-021 — ยอมให้ `claude-cli` ทำงานกับข้อมูลลูกค้าและบน instance ที่ไม่ใช่ loopback (opt-in ต่อ instance)

- **Status:** Accepted (แก้ ADR-019 ข้อ 2 และ ADR-017 ข้อห้าม production/loopback)
- **Date:** 2026-11-04 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของโปรเจกต์ ("ใช้ claude -p แบบอัตโนมัติกับข้อมูลลูกค้าได้" · "แก้ ADR ให้ยอม claude-cli")
- **Context:** ADR-019 ข้อ 2 ให้ config ปฏิเสธ boot เมื่อ `NODE_ENV=production` หรือ `APP_URL` ไม่ใช่ loopback และค้าง `[ASK-HUMAN]` สองข้อ: เงื่อนไขบริการ Anthropic กับการใช้ subscription แบบอัตโนมัติร่วมกับข้อมูลลูกค้า และจะเปิด Watchtower ผ่าน internet อย่างไร เจ้าของตอบทั้งสองข้อแล้ว (2026-11-04) จึงต้องปลดล็อก แต่ repo เป็น open source (N1) ค่าที่มากับ repo ต้องยังปลอดภัยสำหรับคนที่ fork ไป

## Decision
1. **การตัดสินของเจ้าของ `[CONFIRMED]`:** instance ของเจ้าของใช้ `claude-cli` (`claude -p` ผ่าน subscription) แบบอัตโนมัติกับข้อความลูกค้าที่ redact แล้ว (N4 ยังบังคับ) · เจ้าของรับผิดชอบเรื่องเงื่อนไขบริการและ PDPA/ISO ของ instance ตัวเอง · ปิด `[ASK-HUMAN]` ทั้งสองข้อใน ADR-019 Consequences
2. **ข้อห้ามเดิมกลายเป็น opt-in ต่อ instance:** env ใหม่ `CLAUDE_CLI_ALLOW_REMOTE` (ค่าเริ่ม `false`) · ถ้า `false` พฤติกรรมเหมือนเดิมทุกอย่าง (ปฏิเสธ boot เมื่อ production หรือ `APP_URL` ไม่ใช่ loopback) · ถ้า `true` config ยอมทั้งสองกรณี และ api/worker log คำเตือนหนึ่งบรรทัดตอน boot ว่า "claude-cli remote opt-in enabled (ADR-021)" (ไม่มีค่า secret)
3. **สิ่งที่ไม่ผ่อน:** bridge ยังไม่ publish port ออก host (เข้าได้เฉพาะ compose network), bearer token ยังบังคับ, allow-list ของ host bridge เดิม, redaction ก่อนส่ง, `ai_run` audit, งบ, สวิตช์ฉุกเฉิน, ไม่ fallback เป็น mock
4. **ค่าใน repo:** `.env.example` ใส่ `CLAUDE_CLI_ALLOW_REMOTE=false` พร้อม comment อ้าง ADR นี้ · runbook local-poc §3 บอกวิธีเปิด

## Options considered
- **A — opt-in ด้วย env (เลือก)** — เจ้าของได้สิ่งที่ต้องการ; คน fork ไม่โดนเปิดโดยไม่รู้ตัว
- **B — ลบข้อห้ามทิ้ง** — ง่ายสุด แต่ fork ที่ตั้ง `AI_PROVIDER=claude-cli` บน server สาธารณะจะส่งข้อมูลลูกค้าผ่านบัญชีส่วนตัวโดยไม่ได้ตั้งใจ
- **C — ย้ายไป API key** — เจ้าของไม่เลือกตอนนี้ (ยังเปลี่ยนได้ด้วย `AI_PROVIDER` อย่างเดียว)

## Consequences
- AI ยังทำงานเมื่อเครื่อง host online เท่านั้น (ADR-019 ข้อ 5) — ถ้าเปิดให้ทีมใช้ผ่าน internet จะเห็นแถบ AI offline เมื่อ host ปิด (T-170)
- implement ใน T-170 (config + test ทั้งสองค่า)
- ตรวจซ้ำเมื่อ: เงื่อนไขบริการ Anthropic เปลี่ยน, มีคนนอกทีมเจ้าของเข้า instance, ย้ายไป production จริง

## Links
- ADR-017, ADR-019, ADR-008 · T-170 · `docs/runbooks/local-poc.md` §3
