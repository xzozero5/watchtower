# T-412 Product Owner Acceptance Review — Jarvis Stage 1 (`ADR-029` & `§9` Embedded Insights)

- **Date:** 2026-11-09 (เวลากรุงเทพ)
- **Reviewer:** `po` (Independent Product Owner Review, Read-Only per N7)
- **Scope:** `AC-J1`…`AC-J22` + Pilot Metrics Readiness (`T-400`…`T-421`, `T-445`)
- **Verdict:** **CODE & AUTOMATED GATE PASS 100% `[TESTED]`** — พร้อมเข้าสู่ระยะ Live Pilot (คง `[ ] T-412` ใน `BACKLOG.md` รอผลวัดใช้งานจริงใน pilot 2 สัปดาห์ตามกฎ N5 เหมือน `T-306`)

---

## 1. Acceptance Criteria Verification (`AC-J1`…`AC-J22`)

| AC | Requirement | Verdict | Primary Evidence |
|---|---|---|---|
| **AC-J1** | `Ctrl/⌘ K` "Ask AI" + `Ctrl/⌘ /` + ปุ่มลอยทุก route ของ console, ไม่มีบน `/portal`, `/status`, `/csat`, `/start`, `/login` | **PASS `[TESTED]`** | `apps/web/src/components/assistant/assistant-bubble.tsx`, `apps/web/e2e/assistant-t410-gate.e2e.ts`, transitive public-route isolation check (`element-insight.test.tsx`) |
| **AC-J2** | Entity awareness (`ticket`/`incident`/`alert`/`intent`/`org`/`shift`) server resolve ด้วยสิทธิ์, chip = สิ่งที่ส่งจริง, ≥ 95% eval อ้าง entity ถูก | **PASS `[TESTED]`** | `apps/api/src/assistant/context-resolver.ts`, `assistant.service.ts`, mock eval `32/32` citation `100%` (`T-409`) |
| **AC-J3** | ถามข้าม ≥ 2 module ใน ≤ 4 tool call | **PASS `[TESTED]`** | `packages/ai/src/agents/assistant.ts` (`Math.min(4, input.limits.maxToolCalls)`), 9+ module tools ใน `apps/api/src/assistant/tools/` |
| **AC-J4** | Memory: สนทนา 30 วัน redacted, ดู/ลบรายอัน/ลบทั้งหมด, ไม่แชร์ข้ามคน (head ก็อ่านไม่ได้), `<user_notes>` ≤ 10 pinned facts (`T-445d`) | **PASS `[TESTED]`** | `apps/api/src/assistant/assistant-memory.ts`, `assistant-memory.integration.test.ts` (`13/13`), `assistant-user-notes.integration.test.ts` (`6/6`), `ADR-034` |
| **AC-J5** | ทุก claim มี citation หรือป้าย `Uncited`, `href` เปิดได้ด้วยสิทธิ์ผู้ดู | **PASS `[TESTED]`** | `packages/ai/src/agents/assistant.ts`, `apps/api/src/assistant/assistant-hrefs.ts`, `apps/web/src/components/claims/claim-line.tsx` |
| **AC-J6** | ตาราง `tool × role` deny-by-default, `dev` masked, "หน้าจอปฏิเสธ = AI ปฏิเสธ" | **PASS `[TESTED]`** | `apps/api/src/assistant/assistant-rbac-parity.test.ts`, `assistant-rbac-matrix.test.ts` (`16/16`) |
| **AC-J7** | Tool ใหม่ผ่าน redaction fail-closed, ไม่คืนค่า credential (N1) | **PASS `[TESTED]`** | `apps/api/src/assistant/tools/config-lookup.tool.ts`, `assistant-redaction-boundary.test.ts` (`2/2`), `assistant-injection.test.ts` (`15/15`) |
| **AC-J8** | Audit `ai_run` + `assistant.message` + `pii.read` (fail-closed withhold เมื่อเขียน audit ล้ม `T-445b`) | **PASS `[TESTED]`** | `apps/api/src/assistant/assistant-pii-audit.integration.test.ts` (`4/4`), `T-411-security-review.md` |
| **AC-J9** | แสดง phase ภายใน 1 s, ปุ่ม Stop, บันทึก latency | **PASS `[TESTED]`** | `apps/api/src/assistant/assistant.service.ts` (SSE phase + keep-alive), `assistant-t410-gate.e2e.ts` |
| **AC-J10** | Offline / kill switch / งบหมด ปิดช่องพิมพ์พร้อมเหตุผล ไม่ fallback mock | **PASS `[TESTED]`** | `apps/web/e2e/assistant-t410-gate.e2e.ts` (`provider_offline`, `budget_stop`, 0 axe violations) |
| **AC-J11** | 30 ข้อความ/ชม., 200k token/วัน, 1 turn ต่อคน, คิวบอกตำแหน่ง, tool budget 60/ชม./user/tool (`T-445c`) | **PASS `[TESTED]`** | `assistant.service.ts`, `assistant-authorization.integration.test.ts`, `assistant-t410-gate.e2e.ts` |
| **AC-J12** | ภาษา TH/EN ครบถ้วน | **PASS `[TESTED]`** | `packages/shared/src/features/insights.ts`, `apps/web/src/i18n/`, `element-insight.test.tsx` (`33/33`) |
| **AC-J13** | `client` ยิง `/v1/assistant/**` ได้ `403` ทุก endpoint (`routes-policy` test) | **PASS `[TESTED]`** | `apps/api/src/assistant/assistant.controller.ts` (`@WorkspaceOnly()`), `apps/api/test/routes-policy.test.ts` |
| **AC-J14** | ไม่มีทางที่ผลของ assistant ไหลถึงลูกค้า (`C-22` ProposalCard warning + `C-23` `reply_draft`) | **PASS `[TESTED]`** | `T-411-security-review.md`, `assistant-t410-gate.e2e.ts` |
| **AC-J15** | ทุก element ใน §9.1 ที่ไม่ใช่ `X` มีโหมดตามตาราง และมีปุ่ม "ถาม AI เรื่องนี้ / Ask AI about this" ทุก element (รวม `F`) | **PASS `[TESTED]`** | `apps/api/src/insights/insights-rbac-matrix.test.ts` (`36` non-`X` controls, `7` `X`), `T-419b` |
| **AC-J16** | เปิดดู element ไม่สร้าง `ai_run` · fingerprint เดิม = 0 call · ไม่มีคนดูใน 24 ชม. = 0 call | **PASS `[TESTED]`** | `apps/api/src/insights/insights.service.ts`, `apps/worker/src/insights/tick.ts`, `insights.integration.test.ts` |
| **AC-J17** | ป้าย 6 state TH/EN ตรงตามถ้อยคำ §9.3 ทุกตัวอักษร + Axe Light/Dark 0 violations | **PASS `[TESTED]`** | `packages/shared/src/features/insights.ts` (`INSIGHT_STATE_COPY`), `element-insight.test.tsx` (`33/33`), `element-insight-axe.e2e.ts` (`2/2`) |
| **AC-J18** | Narration ทุก claim อ้าง fact ≥ 1, uncited = 0, ตัวเลข ⊆ facts (เลขไทย+อารบิก), eval hallucinated number = 0 | **PASS `[TESTED]`** | `packages/ai/src/agents/insight-t421-eval.test.ts` (`35/35`), `insight-narrate.ts` |
| **AC-J19** | `role × element`: ไม่มีสิทธิ์ = ไม่มีใน response · `dev` ได้อย่างน้อย `F` ของ element ที่ route ให้ `dev` เห็น · `client` `403` · batch ไม่ผสมกลุ่มผู้ดู | **PASS `[TESTED]`** | `apps/api/src/insights/insights-rbac-matrix.test.ts` (`43 × 7`), `apps/web/src/lib/insights/use-insight.ts` (`C-5`) |
| **AC-J20** | ไม่มี push/notification/realtime จาก insight · narration ตามข้อมูลไม่เกิน 20 นาทีหลัง event ที่ผ่าน materiality | **PASS `[TESTED]`** | `apps/worker/src/insights/tick.ts` (debounce 3m, max wait 15m, tick 2m), `T-421-security-review.md` |
| **AC-J21** | 👎 ต่อ element 7 วัน (โหวต ≥ 20): `> 30%` แจ้งใน Admin › AI, `> 50%` หยุด narration ของ element นั้นจน `lead`/`head` เปิดคืน | **PASS `[TESTED]`** | `apps/worker/src/insights/gate.ts` (`checkFeedbackGate`), `apps/worker/src/insights/insights.integration.test.ts` |
| **AC-J22** | งบ insight ≤ 30% ของ `app_ai_daily`, ใช้ ≥ 60% หยุด narration · หน้า `admin.*` ทั้งหมดเป็นโหมด `F` · วัด `insight.narration_rejected ≤ 20%` ใน pilot | **PASS WITH PILOT GATE `[ASK-HUMAN]`** | `apps/worker/src/insights/gate.ts`, `apps/api/src/insights/insights.service.ts`, `T-421-security-review.md` |

---

## 2. Live Pilot Gate & Human Decisions Pending (`[ASK-HUMAN]`)

ตามกติกา **N5** โค้ดและ telemetry พร้อมวัดผลใน Pilot ครบถ้วนแล้ว แต่เกณฑ์ด้านล่างต้องวัดจากการใช้งานจริงบน Pilot Instance เป็นเวลา 2 สัปดาห์ก่อนติ๊กปิด `[x] T-412`:
1. **Adoption:** `≥ 50%` ของพนักงานใช้งาน `≥ 3` ครั้ง/กะ ในช่วง 2 สัปดาห์ของ pilot
2. **Quality & Satisfaction:** `👍 ≥ 70%` และ `insight.narration_rejected ≤ 20%`
3. **Live Latency:** `p50 ≤ 15 s`, `p95 ≤ 40 s` บน provider จริงใน pilot
4. **Person-Level Narration Gate (`C-25` + `C-27` `[ASK-HUMAN]`):** ค่าเริ่มต้น `INSIGHT_PERSON_NARRATION_ENABLED=false` บังคับโหมด `F` สำหรับ element ที่มีข้อมูลรายบุคคล (`shift.overview`, `dashboard.ops.team`, `home.my_work`) จนกว่าเจ้าของจะอนุมัติชุด golden eval §9.9 (`C-25`) และอนุมัติถ้อยคำแจ้งพนักงาน + ROPA ตาม PDPA (`C-27`).

