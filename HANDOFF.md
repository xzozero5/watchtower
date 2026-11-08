# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-09 01:28 (เวลากรุงเทพ) โดย Antigravity (Main + 9 Subagents)
> กฎขนาด ≤ 40 KB — เขียนทับสถานะ ไม่ append ประวัติ · ฉบับก่อน: `docs/handoff-archive/HANDOFF-2026-11-08-pre-jarvis-wave9b-complete.md` · บันทึกรายชั่วโมงอยู่ `logs/daily/2026-11-08.md` และ `logs/daily/2026-11-09.md`

## สถานะปัจจุบัน
- **Phase:** Phase 1–3 (`done pending pilot / live / live gate`) + **Jarvis AI Assistant Stage 1 & Embedded Element Insights Wave 9a/9b & KB Multi-Index (`T-434`) เสร็จสมบูรณ์ 100% บน `main`** (เหลือเฉพาะ `T-412` วัดผล live pilot 2 สัปดาห์ และ `T-433` เปิด `EMBEDDING_PROVIDER=local` `[ASK-HUMAN]`).
- **Build/Test & CI (`[TESTED]`):**
  - Branch `main` (`a6e19aab` + docs commit ปิดท้าย) · **GitHub Actions CI `42508724802` เขียวครบทั้ง 4 jobs** (`End-to-end` 8m33s, `Integration tests` 12m44s, `Lint/typecheck/unit` 8m38s, `Docker Compose` 2m51s)
  - Local gates บน Main Thread: `pnpm build` (11/11), `pnpm typecheck` (18/18), `pnpm lint` (19/19), `pnpm test:boundaries` (298/298), `turbo run test` (11/11 รวม `compose-env` 617/617), `@watchtower/db test:integration` (57 files / 556 tests `0001`–`0120`), Playwright Edge (`7/7`)
- **Independent Reviews (`[TESTED]` ตามกฎ N7, `P0=0, P1=0, P2=0`):**
  - `docs/decisions/T-411-security-review.md` (`ADR-034` **Accepted**)
  - `docs/decisions/T-421-security-review.md` (Wave 9a + 9b Security + QA Gate)
  - `docs/decisions/T-434-security-review.md` (`ADR-033` **Accepted**)
  - `docs/decisions/T-412-po-review.md` (`AC-J1`…`AC-J22` Code & Automated Gate `22/22 PASS`)
- **Deployment (`[TESTED]`):**
  - **Pre-deploy Verified Backup:** `D:\Works\watchtower-backups\poc-20261109-005819-pre-deploy.dump` (`13,783,670 bytes`, `Format: CUSTOM`, 2,794 TOC entries ตรวจด้วย `pg_restore -l` ก่อน migrate)
  - **Main POC Stack Running & Healthy (9 containers):** `postgres`, `redis`, `minio`, `mailpit`, `api`, `worker`, `web`, `caddy`, `gmail-tunnel` (`wt-*` test containers ถูกลบออกทั้งหมดแล้วโดยไม่แตะ `watchtower_*` volumes)
  - **Database Migrations Applied:** `0117_assistant_memory_authorization`, `0118_gate_report_equal_window`, `0119_kb_chunk_embeddings` (backfilled 293 KB chunks), `0120_kb_reembed_lease`
  - **Host AI Bridge Running (Detached):** `PID 37148` (`mode: codex`, `http://127.0.0.1:4317/healthz` → `200`, Redis `watchtower:ai:status` → `online`)
  - **Live Smoke Tests Passed:** `:4000/health` `200`, `:4000/health/ready` `200`, `:4100/health/ready` `200`, `:3000/health` `200`, `:3000/login` `200`, `:8080/health` `200`, `/v1/insights` unauthenticated `401`, `AI_AUTOSEND_ENABLED=false`, `INSIGHT_PERSON_NARRATION_ENABLED=false`, `EMBEDDING_PROVIDER=mock`.
- **Credential ที่มีแล้ว:** อยู่ใน `D:\Works\secret\watchtower.env` นอก repo เท่านั้น (ห้ามอ่าน/พิมพ์ค่า N1).

## การตัดสินใจของเจ้าของที่มีผลอยู่
- **Autonomous L2 + Clean Test Containers + Start POC (`2026-11-08` `[CONFIRMED]`):** เจ้าของสั่งให้รันงานค้างแบบขนานจนครบ, ลบ disposable test containers หลังทำเสร็จ (โดยไม่ลบ POC volumes `watchtower_*`), และเปิด POC stack หลักพร้อมทดสอบให้เจ้าของเข้ามาลองเล่นได้ทันที.
- **Safety & Runtime Guardrails (`[CONFIRMED]`):**
  - **ห้ามเปิด `AI_AUTOSEND_ENABLED`** บน POC/production และห้ามส่งข้อความหาลูกค้าจริง.
  - **ห้ามเปลี่ยน runtime AI bridge** จาก Host AI Bridge (`codex` บน `:4317`) ไปเป็น provider อื่นโดยเจ้าของไม่ได้สั่ง.
  - **ห้ามเปิด `INSIGHT_PERSON_NARRATION_ENABLED`** จนกว่าเจ้าของจะอนุมัติ `C-27` (`[ASK-HUMAN]`).
  - **ห้ามเปิด `EMBEDDING_PROVIDER=local`** เอง (`T-433` `[ASK-HUMAN]`) — โครงสร้าง multi-index `T-434` (`0119`–`0120` + `pnpm kb:reembed`) พร้อมแล้ว.
  - `.agents/` และ `.codex/` ใน working tree เป็น directory ของเจ้าของ **ห้าม git add / commit เด็ดขาด**.

## ทำเสร็จใน session นี้
| งาน | ผล | ไฟล์หลัก |
| --- | --- | --- |
| `T-446` | `[TESTED]` Migration `0118` รองรับ `window_start = window_end` เฉพาะ `insufficient_data` + ถอด `-1s` workaround + DB integration `5/5` | `packages/db/migrations/0118_gate_report_equal_window.sql`, `packages/domain/src/autonomy/gate-report.ts` |
| `T-445` (`a/b/c/d`) + `T-410` + `T-411` | `[TESTED]` Re-auth history/preview/memory + Redis tool budget 60/hr + C-17 PII audit fail-closed + `<=10` `<user_notes>` + RBAC `16/16` + Injection `15/15` + E2E `5/5` (`ADR-034` Accepted) | `apps/api/src/assistant/**`, `packages/ai/src/agents/assistant.ts`, `docs/decisions/T-411-security-review.md` |
| `T-418` + `T-419a` + `T-420` + `T-421` | `[TESTED]` Worker `insights.refresh` + `<ElementInsight>` 6 states TH/EN + ครบ 30/30 Mode `F`/`N` placements + RBAC `43×7` + Eval `35/35` hallucinated=0 | `apps/worker/src/insights/**`, `packages/domain/src/insights/**`, `apps/web/src/components/insights/**`, `docs/decisions/T-421-security-review.md` |
| `T-412` (Code Gate) | `[TESTED]` PO ตรวจอิสระครบ `AC-J1`…`AC-J22` (`22/22 PASS`); คง `[ ]` รอวัดผลใช้งานจริงใน live pilot 2 สัปดาห์ | `docs/decisions/T-412-po-review.md` |
| `T-434` (`a/b/c`) | `[TESTED]` Multi-index `kb_chunk_embeddings` (`0119`) + atomic lease/fencing (`0120`) + `pnpm kb:reembed` + active-spec query/pinned worker (`ADR-033` Accepted) | `packages/db/src/kb-reembed.ts`, `packages/domain/src/kb/**`, `apps/api/src/kb/kb-embedding.service.ts`, `apps/worker/src/kb/processor.ts` |

## ค้าง / ติดอะไร
- ไม่มีงานโค้ดในเฟสปัจจุบันค้าง — เหลือเฉพาะรายการที่ต้องใช้ credential จริง / live pilot / การตัดสินใจของเจ้าของด้านล่าง.

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] **`T-433` เปิด Hybrid Local Embeddings (`BAAI/bge-m3`):** เมื่อพร้อมเปิดใช้งานจริง ให้รัน embedder service, รัน `pnpm kb:reembed --provider local --model BAAI/bge-m3 --dims 1024 --activate`, และสลับ `EMBEDDING_PROVIDER=local`
- [ ] **`T-412` / `C-25` / `C-27`:** ทดลองเล่น Jarvis Assistant + Embedded Element Insights บน POC (`http://localhost:3000`), ยืนยัน retention (`C-25`), นโยบาย `INSIGHT_PERSON_NARRATION_ENABLED` (`C-27`), และเก็บผลใช้งานจริง 2 สัปดาห์ใน pilot (`T-115`)
- [ ] **Pilot & Live Credentials (`T-115`, `T-207`, Phase 3 Stage 3 Gate):** เตรียม instance ใหม่สำหรับทีม + GCP/Discord credentials จริง + เลือก intent แรกเมื่อพร้อมเปิด shadow/live gate

## ขั้นต่อไป (เรียงลำดับ)
1. เจ้าของทดสอบใช้งานจริงบน POC (`http://localhost:3000`) — ทั้ง Jarvis (`Ctrl/Cmd+J`, Ask AI chip, Memory/Pin) และ `<ElementInsight>` บนหน้า Home / Queue / Ops / Dashboard / Reports / Admin.
2. หากเจ้าของต้องการเปิด `BAAI/bge-m3` จริง (`T-433`): เปิด profile `local-embed`, รัน `pnpm kb:reembed --activate`, และตรวจ recall/latency บน POC.
3. เตรียมเริ่ม `T-115` Internal Pilot ตาม `docs/runbooks/` เมื่อเจ้าของพร้อม deploy instance ใหม่สำหรับทีม.

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- ผลการใช้งานจริงของทีมใน pilot 2 สัปดาห์สำหรับ `T-412` (`≥ 60%` active users, `👎 < 15%`) ยังไม่เกิดขึ้นจริง `[UNVERIFIED 0%]` — โค้ดและ automated gate ผ่านครบแล้ว (`docs/decisions/T-412-po-review.md`).
- อัตรา recall/latency ของ `BAAI/bge-m3` บน KB จริงขององค์กรหลังเปิด `T-433` ยังวัดเฉพาะชุดตัวอย่างสาธารณะใน `STATUS.md` `[VERIFY]`.

## วันตรวจซ้ำ
- ตรวจความพร้อมก่อนเริ่ม Pilot (`T-115` / `T-412` live window): 2026-11-16
- รอบหมุน key / ตรวจทาน `ADR-021` / `ADR-034` retention: 2027-02-01
