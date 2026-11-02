# ADR-018 — UI redesign "Soft Beacon"

- **Status:** Accepted
- **Date:** 2026-11-02 · **ผู้ตัดสิน:** เจ้าของ
- **Context:** เจ้าของต้องการเปลี่ยนภาษาภาพของแอปตาม ref (Dribbble "Sales Command Center") ux-designer ทำ mockup ไว้ที่ `docs/design/redesign-2026-11/` เจ้าของอนุมัติทิศทางและตอบคำถาม 5 ข้อ (README §8)

## Decision
- ใช้ธีม "Soft Beacon" ตาม `docs/design/redesign-2026-11/` (token ใน README) แทนภาษาภาพแบบ hairline ของ `docs/design/ui-refresh-2026-11.md` ในจุดที่ขัดกัน
- แผ่นแอปลอยบน gradient backdrop เฉพาะ Overview/Login · หน้าอื่นเต็มจอ
- ฟอนต์ Plus Jakarta Sans + IBM Plex Sans Thai + IBM Plex Mono self-host ผ่าน `@fontsource` (ไม่มีปลายทาง network ใหม่ตอน runtime)
- Head home มี chart + trend ตั้งแต่ตอนนี้ (เพิ่ม counts/history API)
- draft card อยู่คอลัมน์ AI ด้านขวาของหน้า ticket (เปลี่ยนจาก `ai-first-workspace.md` §3)
- active nav = gradient navy → teal · การ์ดไฮไลต์ใช้แสง seafoam ไม่ใช้ทอง
- คงกฎเดิม: ปุ่มหลัก navy, coral ใช้ในโลโก้เท่านั้น, แดงเฉพาะ P1, สถานะไม่ใช้สีอย่างเดียว, autonomy stage 0–2

## Options considered
- **A — Soft Beacon ตาม mockup** — ดูทันสมัย โปร่ง ตรงกับที่เจ้าของต้องการ / งาน restyle ทั้งแอป, ต้องตรวจ contrast ใหม่
- **B — คง ui-refresh-2026-11 แล้วปรับเล็กน้อย** — งานน้อย / ไม่ตอบโจทย์เจ้าของ

## Consequences
- ต้องอัปเดต `docs/06-UI-SPEC.md` (§1 tokens, §3 layout, §6 AI sidebar, §18.2 Head home) ก่อน implement
- contrast ของ token ใหม่ต้องผ่าน `contrast.test.ts` และ axe ทั้ง light/dark
- เพิ่ม dependency `@fontsource/*` (ไฟล์ฟอนต์ใน bundle เท่านั้น)
- e2e/screenshot ที่อิง layout เดิมต้องอัปเดต

## Links
- `docs/design/redesign-2026-11/README.md` §8 (คำตอบเจ้าของ) · `docs/design/ui-refresh-2026-11.md` · `docs/design/ai-first-workspace.md`
