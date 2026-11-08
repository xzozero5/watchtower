# T-421 Security & QA Gate Review — Embedded Element Insights (`ADR-029 §9`)

- **Date:** 2026-11-09 (เวลากรุงเทพ)
- **Reviewers (N7 Separate Independent Reviewers):**
  - `security-reviewer` (Read-Only): ตรวจ `T-418`, `T-420` (Wave 9b), และ `T-421 (Security Half)`
  - `qa-engineer` (Independent QA): ตรวจ `T-419a`, `T-420` UI placements, และ `T-421 (QA Half)`
- **Verdict:** **PASS** (`P0: 0` | `P1: 0` | `P2: 0` | `P3: 1` note for future `home.my_work` mode `N` unlock)

---

## 1. Security Review Summary (`security-reviewer`)

| ID | Area | Control / Resolved Finding | Status |
|---|---|---|---|
| `T-418 R-1..R-4` | Worker `insightTick` (`apps/worker/src/insights/{gate,tick}.ts`) | (1) `checkFeedbackGate` query ตรงที่ `assistant_feedback.updated_at` 7 วัน โหวต ≥ 20 (`>30%` notice, `>50%` pause) · (2) แยกเพดานงบ 2 ชั้น (`≥60%` app-wide daily cap vs `≤30%` `insight_narrator` cap) · (3) อ่าน DB ผ่าน `withReadOnlyConnections` เสมอ (N2) · (4) บังคับ `effectiveMode = 'F'` ใน API `InsightsService` ตราบใดที่ `INSIGHT_PERSON_NARRATION_ENABLED=false` (`C-25`/`C-27`) `[TESTED]` | **PASS** |
| `T-420 C-1` | `reports.ai_cost` & `resolveRefs` (`reports.ts`, `insight-refs.ts`) | `INNER JOIN intent ON intent.key = ai_run.intent` เพื่อใช้ UUID จริงใน `topDrivers('intent', ...)`, เปลี่ยน `agent` เป็น non-ref metric `top_agent_runs` (regex `/^[a-z0-9_]{1,40}$/`), และเพิ่ม `UUID_REGEX` defense-in-depth ใน `namesOf()` ป้องกัน PostgreSQL `22P02` `[TESTED]` | **PASS** |
| `T-420 C-2` | `dashboard.ops.team` (`dashboard-9b.ts`) | ใช้ `OPEN_STATUSES` + `orgScopeCondition`, กรองคนที่มีงาน, เรียงตาม `a.userId.localeCompare(b.userId)` (ไม่เรียงตาม workload ป้องกัน implicit ranking ตาม `ADR-029 §9.9` / `C-24`), และใช้ `{person_${letter}}` คู่กับ `factViews` เพื่อ restore ชื่อตามสิทธิ์ผู้ดู `[TESTED]` | **PASS** |
| `T-420 C-3` | Fact ID & Enum Parity (`insight-claims.ts`, `admin-9b.ts`) | `dashboard.ops.ai` อ่าน `'cost_usd'`, `'error_count'`, `'fallback_count'`; `admin.intent.gate` แปล `'green' | 'red' | 'insufficient_data' | 'none'` เป็นภาษาไทยครบ; `admin.queues` ใช้ `'sending'` และ `admin.outbox` ใช้ `'dead'` ตรง schema จริง `[TESTED]` | **PASS** |
| `T-420 C-5` | Client Batch Isolation (`apps/web/src/lib/insights/use-insight.ts`) | ผูกคิว batch + in-flight cache กับ `${userId}::${scope}::${period}::${locale}` และล้างทันทีเมื่อเปลี่ยนผู้ใช้หรือ logout `[TESTED]` | **PASS** |
| `T-420 C-6` | Budget Boundary Parity (`apps/api/src/insights/insights.service.ts`) | ใช้ `<` ที่เพดาน 30% ตรงกับ `>=` ใน Worker `gate.ts` `[TESTED]` | **PASS** |
| `N1 / N2 / N3 / J20` | Secrets, Read-only, Admin Facts-Only, No Push | `admin.*` ทั้ง 6 ตัวเป็นโหมด `F` (`adminFactsOnly: true` — ไม่เคยส่งเข้า LLM และไม่แนะนำเลื่อน stage N3), `admin.integrations` ไม่อ่านคอลัมน์ secret (N1), ไม่มี push/WebSocket/SSE notification จาก insights (AC-J20) `[CONFIRMED]` | **PASS** |

### Residual Non-Blocking Note (P3)
- เมื่อเจ้าของอนุมัติเปิด `INSIGHT_PERSON_NARRATION_ENABLED=true` ในอนาคตหลังผ่าน gate `C-25` (golden eval §9.9) และ `C-27` (PDPA employee notice + ROPA `[ASK-HUMAN]`) หากจะเปลี่ยน `home.my_work` ใน registry จาก `F` เป็น `N` ต้องปรับ `InsightsService` ให้รองรับ scope `user` จาก `ai_summary` สำหรับโหมด `N` ด้วย (ปัจจุบัน `home.my_work` เป็น `F` ใน registry และทำงานผ่าน lazy `ai_summary` เมื่อเปิด flag).

---

## 2. QA Gate Summary (`qa-engineer`)

- **Queue Isolation (`apps/worker/src/insights/insights-t421-qa.test.ts` — `3/3` `[TESTED]`):**
  - พิสูจน์ด้วย fake slow bridge `5–10s` และ pending `aiQueue` ว่า `runInsightTick` ใช้ `tryAcquire()` ยอมหลีกทางใน `< 50ms` ไม่แย่ง concurrency slot และไม่ทำให้คิว `ai` ของลูกค้า/พนักงานช้าลง.
- **Zero Hallucinated Numbers (`packages/ai/src/agents/insight-t421-eval.test.ts` — `35/35` `[TESTED]`):**
  - ตรวจทั้งชุดเคส `evals/proposals/insights.json` (`31` เคส) + เคสเลขไทย (`๙๘๗๖๕๔`) และอารบิกที่ไม่อยู่ใน facts: `numbersSubsetOfFacts` ปัดตก 100% (`hallucinated number = 0`, `uncited = 0`).
- **RBAC `43 × 7` Matrix & Scope Leak (`apps/api/src/insights/insights-rbac-matrix.test.ts` — `9/9` `[TESTED]`):**
  - ยืนยันครบ `43 elements × 7 roles`: `client` ถูกปฏิเสธ `403` ทุกจุด, `dev` เห็นเฉพาะ element ที่ route อนุญาตแบบ masked (ไม่รั่วชื่อลูกค้า), batch ไม่ผสมกลุ่มผู้ดู, และ 30/30 non-`R`/`X` elements มี facts builder ครบถ้วน.
- **UI States, Accessibility & Public Route Isolation (`element-insight.test.tsx` `33/33` + `element-insight-axe.e2e.ts` `2/2` `[TESTED]`):**
  - ป้าย 6 state TH/EN ตรงตาม AC-J17, 👍/👎 พร้อม `judges_person`, Axe Light/Dark 0 violations, และ transitive import check ยืนยันว่า `/portal`, `/status`, `/csat`, `/login`, `/start` ไม่ import โค้ด insights/assistant.

