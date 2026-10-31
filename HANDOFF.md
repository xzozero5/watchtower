# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-10-31 21:35 (เวลากรุงเทพ) โดย Claude Code (main thread, Phase 0)
> กฎขนาด ≤ 40 KB — เขียนทับสถานะ ไม่ append ประวัติ · เรื่องที่จบย้ายไป `docs/handoff-archive/` · บันทึกรายชั่วโมงอยู่ `logs/daily/`

## สถานะปัจจุบัน
- **Phase:** 0 — Foundation (กำลังทำ; T-000 เสร็จ, T-001 กำลังทำ)
- **Repo:** public บน GitHub, Apache-2.0, เป็นกลางไม่ผูกกับองค์กรใด (PRD §13) `[CONFIRMED 2026-10-31]`
- **Deployment:** Docker Compose บน local ก่อน → production บน GCP ภายหลัง (ADR-001) `[CONFIRMED 2026-10-31]`
- **Credential:** ยังไม่มีตัวใดเลย — ทุก integration ต้องมี mock/sandbox mode จนกว่าจะได้ (`[ASK-HUMAN]`)
- **เงิน:** ยังไม่ตั้งงบ — `config/budgets.yaml` ค่าเริ่มต้น `[ASSUMED]`

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ชื่อโปรเจกต์ **Watchtower** — 2026-10-31 20:57
- Tech stack ตาม ADR-001 (TypeScript monorepo, Next.js, NestJS, BullMQ, Postgres+pgvector/Drizzle, Redis, MinIO→GCS, Vercel AI SDK) — 2026-10-31 21:01
- รัน Docker local ก่อน, deploy จริงบน GCP — 2026-10-31 21:01
- Feature set ตาม PRD v0.1 รวม 3 ข้อที่เพิ่ม: CSAT email, GCP Monitoring, product-usage dashboard + proactive ticket — 2026-10-31 20:43–20:45
- Repo เป็น public และเป็นกลาง ห้ามมีชื่อหรือข้อมูลขององค์กรที่นำไปใช้ องค์กรจะ fork ไปใส่ข้อมูลตัวเอง — 2026-10-31 21:25
- SSO domain อ่านจาก env — 2026-10-31 21:25
- Default autonomy = stage 2 (draft-for-approval) ทุก intent; เป้าหมายระยะยาว AI support 100% — PRD §6.4
- เอกสารการทำงานเป็นไทย, PRD/โค้ดเป็นอังกฤษ — PRD §0 / AGENTS.md

## ทำเสร็จใน session นี้ (วางแผน)
| งาน | ผล | ไฟล์ |
|---|---|---|
| Research software ใกล้เคียง + integration constraints + UX + AI maturity | สรุปใน PRD §11, §14 | `docs/01-PRD.md` |
| PRD v0.1 | ครบ 17 ส่วน | `docs/01-PRD.md` |
| วิธีทำงาน | AGENTS/CLAUDE/START-HERE/BACKLOG/templates/agents/commands/hooks | ทั้ง repo |

## ค้าง / ติดอะไร
- คำถาม PRD §16 ที่เหลือยังไม่มีคำตอบ — ใช้ `[ASSUMED]` ไปก่อน บันทึกใน STATUS "Open questions"

## รอเจ้าของ
- [ ] ตอบ PRD §16 เท่าที่ตอบได้ (ไม่บล็อก Phase 0)
- [ ] ตั้ง `config/budgets.yaml` (งบ API ต่อ session/เดือน)

## ขั้นต่อไป (เรียงลำดับ)
1. ทำ T-001 … T-011 ต่อตาม `/phase-0-bootstrap`
2. ปิด Phase 0 ด้วย `/review` + `/handoff`

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- LINE OA ราคา/โควตาแผนไทย `[VERIFY]` — PRD §4.2 R-2.10
- Mark-as-read API ของ LINE ใช้ได้กับแผน OA ที่ใช้ `[VERIFY]`
- Product DB ของ deployment อ้างอิง = Cloud SQL Postgres `[ASSUMED]`
- Google Workspace SSO ใช้ได้ (domain-wide delegation อนุญาต) `[ASSUMED]`
- GCP mapping (Cloud Run/Cloud SQL/Memorystore/GCS) `[ASSUMED]` — ADR-001 §Deployment

## วันตรวจซ้ำ
- LINE pricing/feature: ก่อน T-103
- Google managed MCP (BigQuery/Logging) availability: ก่อน T-203
