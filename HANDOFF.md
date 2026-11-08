# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-09 02:38 (เวลากรุงเทพ) โดย Antigravity (Main + Parallel Subagents)
> กฎขนาด ≤ 40 KB — เขียนทับสถานะ ไม่ append ประวัติ · ฉบับก่อน: `docs/handoff-archive/HANDOFF-2026-11-09-pre-birdday-ui-polish.md` · บันทึกรายชั่วโมงอยู่ `logs/daily/2026-11-08.md` และ `logs/daily/2026-11-09.md`

## สถานะปัจจุบัน
- **Phase:** Phase 1–3 (`done pending pilot / live / live gate`) + **Jarvis/Birdday AI Assistant Stage 1, Embedded Element Insights Wave 9a/9b, KB Multi-Index (`T-434`), และ Birdday Cockatiel Persona / Claude-Style Chat UX / Lively Shimmer Skeletons (`T-447`) เสร็จสมบูรณ์ 100%** (เหลือเฉพาะ `T-412` วัดผล live pilot 2 สัปดาห์ และ `T-433` เปิด `EMBEDDING_PROVIDER=local` `[ASK-HUMAN]`).
- **Build/Test & CI (`[TESTED]`):**
  - GitHub Actions CI run `42514898285` **เขียวครบทั้ง 4 jobs**: `Docker Compose build, up, health` (2m54s), `Lint, typecheck, unit tests` (9m08s), `End-to-end (Playwright)` (10m45s — Web e2e + Full-stack e2e), `Integration tests` (12m52s) · Fast-forward merged เข้า `main`
  - Local gates บน Main Thread: `pnpm build` (11/11), `pnpm typecheck` (18/18), `pnpm lint` (19/19), `@watchtower/ui` (`16/16` files, `815/815` tests), `@watchtower/web` unit (`156/156` files, `1,807/1,807` tests), Playwright Edge E2E + `axe` light/dark (`52/52` passed, `0` violations)
- **Independent Reviews (`[TESTED]` ตามกฎ N7, `P0=0, P1=0, P2=0`):**
  - `docs/decisions/T-447-review.md` (`Birdday` Persona + Claude-Style Chat + Shimmer Skeletons — `qa-engineer` + `security-reviewer` **PASS**)
  - `docs/decisions/T-411-security-review.md` (`ADR-034` **Accepted**)
  - `docs/decisions/T-421-security-review.md` (Wave 9a + 9b Security + QA Gate)
  - `docs/decisions/T-434-security-review.md` (`ADR-033` **Accepted**)
  - `docs/decisions/T-412-po-review.md` (`AC-J1`…`AC-J22` Code & Automated Gate `22/22 PASS`)
- **Deployment (`[TESTED]`):**
  - **Pre-deploy Verified Backup:** `D:\Works\watchtower-backups\poc-20261109-005819-pre-deploy.dump` (`13,783,670 bytes`, `Format: CUSTOM`, 2,794 TOC entries ตรวจด้วย `pg_restore -l`)
  - **Main POC Stack Running & Healthy (9 containers):** `postgres`, `redis`, `minio`, `mailpit`, `api`, `worker`, `web` (rebuilt พร้อม **Birdday** + Claude-style chat + shimmer skeletons), `caddy`, `gmail-tunnel` (`wt-*` test containers ถูกลบออกทั้งหมดแล้วโดยไม่แตะ `watchtower_*` volumes)
  - **Database Migrations Applied:** `0117_assistant_memory_authorization`, `0118_gate_report_equal_window`, `0119_kb_chunk_embeddings` (backfilled 293 KB chunks), `0120_kb_reembed_lease`
  - **Host AI Bridge Running (Detached):** `PID 37148` (`mode: codex`, `http://127.0.0.1:4317/healthz` → `200`, Redis `watchtower:ai:status` → `online`)
  - **Safety Flags:** `AI_AUTOSEND_ENABLED=false`, `INSIGHT_PERSON_NARRATION_ENABLED=false`, `EMBEDDING_PROVIDER=mock`.
- **Credential ที่มีแล้ว:** อยู่ใน `D:\Works\secret\watchtower.env` นอก repo เท่านั้น (ห้ามอ่าน/พิมพ์ค่า N1).

## การตัดสินใจของเจ้าของที่มีผลอยู่
- **Birdday Cockatiel Persona & Lively Claude-Style UX (`2026-11-09` `[CONFIRMED]`):** เจ้าของต้องการเปลี่ยนธีม AI เป็นนกค็อกคาเทลชื่อ **Birdday**, เพิ่มความมีชีวิตชีวา/การตอบสนองและ skeleton loading ทั้งเว็บ, และปรับประสบการณ์คุยกับ AI ให้ไหลลื่นสไตล์ Claude (`T-447`).
- **Safety & Runtime Guardrails (`[CONFIRMED]`):**
  - **ห้ามเปิด `AI_AUTOSEND_ENABLED`** บน POC/production และห้ามส่งข้อความหาลูกค้าจริง.
  - **ห้ามเปลี่ยน runtime AI bridge** จาก Host AI Bridge (`codex` บน `:4317`) ไปเป็น provider อื่นโดยเจ้าของไม่ได้สั่ง.
  - **ห้ามเปิด `INSIGHT_PERSON_NARRATION_ENABLED`** จนกว่าเจ้าของจะอนุมัติ `C-27` (`[ASK-HUMAN]`).
  - **ห้ามเปิด `EMBEDDING_PROVIDER=local`** เอง (`T-433` `[ASK-HUMAN]`) — โครงสร้าง multi-index `T-434` (`0119`–`0120` + `pnpm kb:reembed`) พร้อมแล้ว.
  - `.agents/` และ `.codex/` ใน working tree เป็น directory ของเจ้าของ **ห้าม git add / commit เด็ดขาด**.

## ทำเสร็จใน session นี้
| งาน | ผล | ไฟล์หลัก |
| --- | --- | --- |
| `T-447` | `[TESTED]` มาสคอตนกค็อกคาเทล **Birdday** (`<BirddayAvatar />` 5 สถานะ + `<BirddayIcon />`), แชท AI สไตล์ Claude (live multi-step phase timeline + elapsed timer, expandable width `26.5rem`↔`38rem`, unified auto-growing composer), directional pearl shimmer `<Skeleton />` + structured route/table/queue/shift skeletons (`@watchtower/ui` 815/815, `@watchtower/web` 1,807/1,807, E2E+`axe` 52/52) | `packages/ui/src/components/{birdday,skeleton}.tsx`, `apps/web/src/components/assistant/**`, `apps/web/src/app/(console)/loading.tsx`, `docs/decisions/T-447-review.md` |
| `T-446` | `[TESTED]` Migration `0118` รองรับ `window_start = window_end` เฉพาะ `insufficient_data` + DB integration `5/5` | `packages/db/migrations/0118_gate_report_equal_window.sql`, `packages/domain/src/autonomy/gate-report.ts` |
| `T-445` (`a/b/c/d`) + `T-410` + `T-411` | `[TESTED]` Re-auth history/preview/memory + Redis tool budget 60/hr + C-17 PII audit fail-closed + `<=10` `<user_notes>` + RBAC `16/16` + Injection `15/15` (`ADR-034` Accepted) | `apps/api/src/assistant/**`, `packages/ai/src/agents/assistant.ts`, `docs/decisions/T-411-security-review.md` |
| `T-418` + `T-419a` + `T-420` + `T-421` | `[TESTED]` Worker `insights.refresh` + `<ElementInsight>` 6 states TH/EN + ครบ 30/30 Mode `F`/`N` placements + RBAC `43×7` + Eval `35/35` hallucinated=0 | `apps/worker/src/insights/**`, `packages/domain/src/insights/**`, `apps/web/src/components/insights/**`, `docs/decisions/T-421-security-review.md` |
| `T-412` (Code Gate) + `T-434` (`a/b/c`) | `[TESTED]` PO ตรวจครบ `AC-J1`…`AC-J22` (`22/22 PASS`) · Multi-index `kb_chunk_embeddings` (`0119`–`0120`) + `pnpm kb:reembed` (`ADR-033` Accepted) | `docs/decisions/T-412-po-review.md`, `packages/db/src/kb-reembed.ts`, `packages/domain/src/kb/**` |

## ค้าง / ติดอะไร
- ไม่มีงานโค้ดค้าง — เหลือเฉพาะรายการที่ต้องรอเจ้าของทดลองเล่น / ตัดสินใจด้านล่าง.

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] **ทดลองเล่น Birdday & Lively UI (`T-447`) บน POC (`http://localhost:3000`):** เปิดปุ่มนกค็อกคาเทล **Birdday** มุมขวาล่าง (`Ctrl/Cmd + /` หรือ Command Palette `Ctrl/Cmd + K` → `Ask Birdday`), ลองปุ่มขยายความกว้างหน้าต่างแชท, ดู live thinking timeline และ shimmer skeletons
- [ ] **`T-433` เปิด Hybrid Local Embeddings (`BAAI/bge-m3`):** เมื่อพร้อมเปิดใช้งานจริง ให้รัน embedder service, รัน `pnpm kb:reembed --provider local --model BAAI/bge-m3 --dims 1024 --activate`, และสลับ `EMBEDDING_PROVIDER=local`
- [ ] **`T-412` / `C-25` / `C-27` & Pilot (`T-115`):** ยืนยัน retention (`C-25`), นโยบาย `INSIGHT_PERSON_NARRATION_ENABLED` (`C-27`), และเก็บผลใช้งานจริง 2 สัปดาห์ใน pilot

## ขั้นต่อไป (เรียงลำดับ)
1. เจ้าของทดลองเล่น **Birdday** และ UI ใหม่บน POC (`http://localhost:3000`) และแจ้งหากต้องการปรับบุคลิก/แอนิเมชันเพิ่มเติม.
2. หากต้องการเปิด `BAAI/bge-m3` จริง (`T-433`): เปิด profile `local-embed` แล้วรัน `pnpm kb:reembed --activate`.
3. เริ่ม `T-115` Internal Pilot ตาม `docs/runbooks/` เมื่อพร้อม deploy instance ใหม่สำหรับทีม.

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- ผลการใช้งานจริงของทีมใน pilot 2 สัปดาห์สำหรับ `T-412` (`≥ 60%` active users, `👎 < 15%`) ยังไม่เกิดขึ้นจริง `[UNVERIFIED 0%]`.
- อัตรา recall/latency ของ `BAAI/bge-m3` บน KB จริงขององค์กรหลังเปิด `T-433` ยังวัดเฉพาะชุดตัวอย่างสาธารณะใน `STATUS.md` `[VERIFY]`.

## วันตรวจซ้ำ
- ตรวจความพร้อมก่อนเริ่ม Pilot (`T-115` / `T-412` live window): 2026-11-16
- รอบหมุน key / ตรวจทาน `ADR-021` / `ADR-034` retention: 2027-02-01
