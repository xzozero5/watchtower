# Brief: UI rework (visual layer) — เริ่ม 2026-11-03 00:00 ขนานกับงาน QA

> สำหรับ AI/คนที่ทำ rework UI · อ่าน `AGENTS.md` ก่อน · main thread ของ session QA ยัง merge งานเข้า `main` อยู่ (ดู §3) — อ่านข้อนี้ก่อนแตะไฟล์

## 1. ขอบเขต
- **ทำ:** visual layer ของ `apps/web` + `packages/ui` — tokens, theme light/dark, typography, spacing, layout ของ app shell และหน้า, หน้าตา component
- **ไม่ทำ:** พฤติกรรม, data flow, API, schema, การเรียก hook, routing, ข้อความ (copy) นอกจากที่ต้องย้ายตำแหน่ง · **ห้ามเปลี่ยน accessible name / role / label ของปุ่มและช่องกรอก** เพราะ e2e 172 + full-stack 38 ใช้ `getByRole`/`getByLabel` (ถ้าจำเป็นต้องเปลี่ยน ต้องแก้ test ใน commit เดียวกันและบอกเหตุผล)
- ทิศทางดีไซน์: ข้อเสนอ "Soft Beacon" `docs/design/redesign-2026-11/` **ยังรอเจ้าของอนุมัติ** — ถามเจ้าของก่อนว่าจะใช้ชุดนี้ทั้งหมด บางส่วน หรือทิศอื่น อย่าเดา

## 2. คำตัดสินที่ต้องคงไว้ (po แทนเจ้าของ 2026-11-02, `docs/qa/2026-11-02-roleplay-triage.md`)
- **สีบอกสถานะเท่านั้น:** rail/icon เป็นสีกลาง ๆ ยกเว้นหน้าปัจจุบันหรือมี count > 0 · ค่า 0 ไม่เป็นแดง/ส้ม · แดง/อำพันสงวนไว้ให้สิ่งที่ต้องทำ (PRD §10, UI-SPEC §8)
- **ปุ่มจุดตัดสินใจมี label สั้นคู่ไอคอน** (AI card: Approve/Send, Edit, Regenerate, Send to dev · composer Reply/Note · แท็บ right pane) ส่วน chrome รองเป็นไอคอน + tooltip ได้ · แท็บ default ของ right pane คงที่
- **ชื่อเรื่อง = subject ของคน** · AI summary เป็นบรรทัดแยกที่มีป้าย "AI" (N5) · ทุกแถวมีเลข ticket และช่อง SLA (แสดง "No SLA" เมื่อไม่มี)
- severity = icon + label + สี (ไม่ใช่สีอย่างเดียว) · TH/EN ครบ · WCAG AA contrast ทั้งสองธีม
- ยังไม่ทำในรอบ QA และเป็นของ UI rework ได้: ชิปสถานะกะเป็นข้อความ + toast มุมขวาบน (T-151), tile/จุดสีบน home/dashboard/brief ที่แดงตอนค่า 0 (QA-20)

## 3. ไฟล์ที่กำลังถูกแก้โดยงาน QA (ชนแน่ถ้าแตะตอนนี้)
| พื้นที่ | งาน | สถานะ |
|---|---|---|
| `apps/web/src/components/queue/**`, command palette, `nav-rail.tsx`, i18n queue/rail/ops | FE-1: แถวคิว, การเรียง, Needs you, ชื่อ rail ไทย, rail สีกลาง | กำลังทำ |
| `apps/web/src/components/{ticket,conversation,ai}/**`, i18n ticket/ai | FE-2: Reply บน channel ที่ส่งออกไม่ได้, รอลูกค้า, AI card, label ปุ่ม, assignee picker | กำลังทำ |
| `apps/web/src/components/{admin,portal,login,dev}/**`, `app/not-found.tsx`, `app/admin/intents`, i18n admin/portal/login/errors/dev | FE-3: สร้าง intent, คำอธิบาย stage, portal next steps, 404 ลูกค้า, notice dev | กำลังทำ |
| `packages/ai/**`, `apps/api/**`, `apps/worker/**`, `packages/shared/**` | redaction, search, assignees | ไม่ใช่ขอบเขต UI |

**ลำดับที่แนะนำ:** (1) `packages/ui` tokens/theme/fonts + app shell + หน้าที่ไม่อยู่ในตาราง (home, dashboard, shift, alerts, incidents, status-page, admin หน้าอื่น, other-mail) ก่อน (2) เมื่อ main thread แจ้งว่า merge งาน QA เข้า `main` ครบแล้ว ให้ `git merge main` เข้า branch นี้ แล้วค่อยทำหน้าคิว/ticket/admin intents/portal

## 4. Definition of Done
`pnpm lint && pnpm typecheck && pnpm test` ผ่าน · `pnpm test:e2e` (ใช้ `PW_CHANNEL=chrome`) + `pnpm test:e2e:fullstack` ผ่าน — **อย่ารันกับ stack จริงที่ :3000/:4000/:5432** (stack นั้นมีข้อมูล POC) e2e เปิด server/DB ของตัวเองอยู่แล้ว; integration ใช้ service ทิ้งได้ (`TEST_DATABASE_URL=...:45432`, `TEST_REDIS_URL=...:46379`, `TEST_S3_*`, ดู `logs/daily/2026-11-02.md`) · screenshot ก่อน/หลัง light+dark, 1440 และ 390 ลง `docs/screenshots/` · commit เล็ก ๆ prefix `web:`/`ui:` ภาษาไทย · อัปเดต UI-SPEC ที่เปลี่ยน (§1 tokens, §3 shell) · ไม่ push จนกว่า gate ผ่าน
