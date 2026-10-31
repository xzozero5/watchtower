---
description: Phase 0 — Foundation (monorepo, compose, auth/RBAC/audit, ticket core, portal, three-pane shell, seed, e2e AC-1)
---
เริ่ม Phase 0 ของ Watchtower ตาม `docs/BACKLOG.md` (T-000..T-012) และ exit criteria ใน `docs/00-START-HERE.md`

0. ตรวจ/สร้าง `logs/daily/$(TZ=Asia/Bangkok date '+%F').md` แล้ว log ทุกขั้นระหว่างทำ
1. **T-000 main thread ทำเอง**: git init ถ้ายังไม่มี, `.gitignore`, `git config core.hooksPath tools/githooks`, commit แผน; remote/push ถ้าเจ้าของให้ URL มิฉะนั้น `[ASK-HUMAN]` แล้วทำต่อแบบ local
2. เรียก `architect` ทำ T-001 (ยืนยัน ADR-001 กับโครงจริง, โครง monorepo, ร่าง `docs/04-ARCHITECTURE.md`, boundary lint) — main thread ตรวจซ้ำแล้ว commit
3. รัน **ขนานกัน**: `backend-dev` T-002 (api + db + compose) และ `frontend-dev` T-003 (web shell + tokens) — ไม่แตะไฟล์เดียวกัน
4. `backend-dev` T-004 (auth/RBAC/audit) → T-005 (org/contact/ticket core) · ขนาน `frontend-dev` T-006 (three-pane) เมื่อ API contract ของ T-005 นิ่ง (ใช้ OpenAPI จาก T-005 เป็นสัญญา)
5. T-007 portal channel (`backend-dev` + `frontend-dev`), T-008 seed
6. `qa-engineer` T-009 e2e AC-1 + RBAC; `security-reviewer` T-010 — แก้ P0/P1 ก่อนไปต่อ
7. `po` T-011 review phase; main thread ปรับ BACKLOG Phase 1 ตามข้อเสนอ
8. ตรวจเองก่อนปิด: `docker compose up -d && curl localhost:3000/health`, `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` ผ่าน
9. T-012 `/handoff` + `CHANGELOG.md` 0.0.1 + tag `v0.0.1`
กฎ: ห้ามข้าม DoD · ห้ามต่อ credential จริง · ถามเจ้าของได้ ≤ 5 ข้อก่อนเริ่ม นอกนั้นตัดสินใจเองและบันทึกใน STATUS/ADR
