# T-411 & T-445 — Security review ของ Assistant Stage 1 (ADR-029, ADR-034) หลัง implement

- **ผู้ตรวจ:** `security-reviewer` (N7, read-only, แยกตัวจากผู้ผลิต `backend-dev` / `ai-engineer`) · **วันที่:** 2026-11-08 23:34 (เวลากรุงเทพ)
- **ขอบเขต:** `packages/ai/src/agents/assistant.ts`, `packages/ai/src/redaction/detectors.ts`, `packages/ai/prompts/assistant_turn.v1.md`, `packages/ai/prompts/assistant_answer.v2.md`, `apps/api/src/assistant/**`, `apps/api/src/insights/**`, `packages/db/migrations/0117_assistant_memory_authorization.sql`, `docs/09-SECURITY.md` (§13)
- **ผลตรวจซ้ำ (Re-review):** **PASS** · P0 × 0 · P1 × 0 · P2 × 0 · P3 × 2 (defense-in-depth notes ไม่บล็อกการปิดงานทั้ง `T-445` และ `T-411`)
- **หลักฐานการรันเทสต์โดย Main Thread (`[TESTED]`):**
  - Unit: `packages/ai/src/agents/assistant-user-notes.test.ts` (11/11), `packages/ai/src/agents/assistant-injection.test.ts` (15/15), `apps/api/src/assistant/assistant-rbac-matrix.test.ts` (16/16), `apps/api/src/assistant/assistant-redaction-boundary.test.ts` (2/2)
  - Integration (Postgres + Redis จริงบน disposable stack): `assistant-foundation.integration.test.ts` (18/18), `assistant-memory.integration.test.ts` (13/13), `assistant-authorization.integration.test.ts` (4/4), `assistant-pii-audit.integration.test.ts` (4/4), `assistant-user-notes.integration.test.ts` (6/6)

## 1. ประเด็นที่ตรวจพบในรอบแรกและได้รับการแก้ไขปิดครบถ้วนแล้ว

| รอบแรก | Sev เดิม | ปัญหาที่พบ | การแก้ไขและผลตรวจซ้ำ |
|---|---|---|---|
| R1-C1 | P1 | การบรรยายรายบุคคล (`personRefs !== 'none'`) ยังไม่มี runtime gate ปิดเป็นค่าเริ่มต้นตามเงื่อนไข `C-25` (golden eval §9.9) และ `C-27` (PDPA Employee Privacy Notice) | เพิ่ม `INSIGHT_PERSON_NARRATION_ENABLED=false` เป็นค่าเริ่มต้นในทั้ง `apps/api/src/config/config.ts` และ `apps/worker/src/config.ts` บล็อกการดึง narration, การเขียน mark, และการเรียก LLM 0 ครั้งเมื่อเป็น `false` พร้อมบันทึกเงื่อนไขใน `docs/09-SECURITY.md` §13 — **ปิด `[CONFIRMED]`** |
| R1-C2 | P2 | `packages/ai` ทำ `clip()` ก่อน `redactToolOutput()` และ tool ฝั่ง API บางตัว `.slice(0, 240..500)` ก่อนส่งเข้า `factBlock` ทำให้ชื่อ/อีเมลที่คร่อมรอยต่อหลุดการตรวจจับ | แก้เป็น `clipRedacted` หลัง redact ใน `packages/ai` และถอด `.slice()` ก่อน `factBlock` ออกใน `assistant-tools.ts`, `ticket-timeline.tool.ts`, `conversation.tools.ts`, `entity-get.tools.ts`, `shift.tools.ts` พร้อม regression test `assistant-redaction-boundary.test.ts` — **ปิด `[TESTED]`** |
| R1-C3 | P2 | `ticket_timeline` ส่ง ticket key แทน canonical UUID ลง `pii.read`, `roster_view` ขาด `piiKinds`, และ `authorize()` ยังไม่ตรวจซ้ำ `shift_note` ใน `piiRefs` | ส่ง canonical UUID `view.t.id`, เพิ่ม `piiKinds: ['roster']` (`targetType = 'roster_entry'`), และเพิ่มการตรวจซ้ำ `piiRefs` (รวม `shift_note` `authorId` / `inboxCondition`) ใน `assistant-context-history.ts` — **ปิด `[CONFIRMED]`** |
| R1-C4 | P2 | เมื่อเขียน `pii.read` ล้มเหลวระหว่างรัน tool แถว `assistant_message` ยังอาจถูกบันทึกก่อนส่ง error | เพิ่ม `auditAbort.abort()` + `auditState.failed` ดักโยน `503 assistant_audit_failed` **ก่อน** `db.transaction(...)` และก่อน `proposals.prepare(...)` ยืนยัน 0 แถวใน `assistant-pii-audit.integration.test.ts` — **ปิด `[TESTED]`** |
| R1-C5 | P3 | แถว memory เก่าที่ถูก tombstone (`authorization IS NULL` จาก `0117`) กดจำซ้ำไม่ได้ และ `handoff_get` ตั้ง `trust` คงที่ | กู้คืนแถวเดิมด้วย `authorization` ปัจจุบันโดยไม่ยืด `expiresAt` ใน `assistant-memory.ts` และตั้ง `trust: 'customer'` เมื่อ handoff มีรายการพ่วงลูกค้า — **ปิด `[CONFIRMED]`** |
| R1-C6 | P3 | ยังไม่บันทึกข้อจำกัด shared DB role (`watchtower_app`) ของ `readOnlyPool` ตาม `C-26` | บันทึก defense-in-depth ใน `docs/09-SECURITY.md` §13 เรียบร้อย — **ปิด `[CONFIRMED]`** |

## 2. สรุปตารางตรวจสอบ `C-1`…`C-27` (จาก `T-400-security-review.md`)

| ID | หัวข้อ | สถานะ | หลักฐาน |
|---|---|---|---|
| C-1 | RBAC route-vs-tool parity & ลบ shortcut `ticket.read.masked` | **PASS** `[TESTED]` | `evaluatePermissionRule` ร่วมกับ guard + `assistant-rbac-parity.test.ts` + `assistant-rbac-matrix.test.ts` |
| C-2 | DB Read-Only isolation (`readOnlyPool` + `BEGIN READ ONLY` + `3s` timeout) | **PASS** `[TESTED]` | `read-only.ts` (`withReadOnlyConnections` / `inReadOnlyScope`), `assistant-foundation.integration.test.ts` |
| C-3 | บล็อก `investigate_run` เมื่อมี untrusted content หรือ `userNotes` + typed token restore | **PASS** `[TESTED]` | `packages/ai/src/agents/assistant.ts`, `assistant-injection.test.ts`, `assistant-user-notes.integration.test.ts` |
| C-4 | Fail-closed audit ก่อนส่งคำตอบทั้ง JSON และ SSE | **PASS** `[TESTED]` | `assistant.service.ts` (`recordPiiAudit` + `auditAbort`), `assistant-pii-audit.integration.test.ts` |
| C-5 | เคารพ kill switch และ agent policy (`personal_assistant`) รวม `facts_only` | **PASS** `[CONFIRMED]` | `standing()` กั้นทั้ง LLM และ `facts_only`, `factsOnlyCall` allow-list ปลอด `investigate_run` |
| C-6 | `config_lookup` / `autonomy_status` allow-list ปลอด URL/secret/credential (N1) | **PASS** `[CONFIRMED]` | `tools/config-lookup.tool.ts`, `tools/autonomy-status.tool.ts` (`z.strictObject` boolean/status เท่านั้น) |
| C-7 | Memory จาก `redactedText` เท่านั้น, อายุ 90 วันนับจาก `created_at` ไม่ยืดตามการใช้งาน | **PASS** `[TESTED]` | `assistant-memory.ts`, `assistant.service.ts`, `assistant-user-notes.integration.test.ts` |
| C-8 | Redaction dictionary ครบทุก turn/entity/memory + fail-closed `listsWhole` | **PASS** `[TESTED]` | `assistant.service.ts` (`dictionaryRefs`), `assistant-redaction-boundary.test.ts` |
| C-9 | บล็อก `client` / portal / non-workspace roles เข้า `/v1/assistant/**` และ `/v1/insights` | **PASS** `[TESTED]` | `WORKSPACE_ROLES` allow-list, `assistant-rbac-matrix.test.ts`, `routes-policy.test.ts` |
| C-10 | การบรรยายรายบุคคลใน §9.1 / §9.9 (`personRefs`) | **PASS (Gated)** `[CONFIRMED]` | ปิดไว้เป็น default ด้วย `INSIGHT_PERSON_NARRATION_ENABLED=false` (ดู C-24, C-25, C-27) |
| C-11 | ป้องกัน DoS/flood บน `/v1/insights` และ viewed/dirty marks | **PASS** `[CONFIRMED]` | `periodFor`/`scopeKeyFor`, rate limit, `SingleFlightCache`, cap 20 items/tick |
| C-12 | `factsCache` รวมชุด permission ใน cache key และไม่เก็บ PII ดิบข้ามสิทธิ์ | **PASS** `[CONFIRMED]` | `factsCache.resolve` ผูก `userId`, `role`, `permissions`, `starter`, `locale`, `promptVersion` |
| C-13 | Tag neutralization ครอบคลุม `<untrusted_content>`, `<user_notes>` และ prompt tags | **PASS** `[TESTED]` | `neutralizeTags` ใน `assistant.ts` + `assistant-injection.test.ts` + `assistant-user-notes.test.ts` |
| C-14 | ห่อ free text ทุกชนิดที่ไม่ใช่ข้อความระบบด้วย `<untrusted_content>` | **PASS** `[CONFIRMED]` | `fact-kit.ts` / `ops-tool-kit.ts` + `DRIVER_GROUP_BY` allow-list |
| C-15 | ข้อเท็จจริงของสิทธิ์ DB ระหว่าง worker กับ api บน `ai_element_insight` | **PASS** `[CONFIRMED]` | บันทึกใน ADR-029 + `docs/09-SECURITY.md` §13 + lint `watchtower/no-insight-writer` |
| C-16 | Tool ที่มี `.own` vs `.all` ไม่เชื่อ argument `userId` ของคนอื่น | **PASS** `[TESTED]` | `shift.tools.ts`, `assistant-rbac-matrix.test.ts` (DoD C-16 suite) |
| C-17 | ตาราง `piiKinds` ครบทุก PII entity และเขียน `pii.read` แบบ fail-closed | **PASS** `[TESTED]` | `assistant-access.ts`, `assistant-tools.ts`, `assistant-pii-audit.integration.test.ts` |
| C-18 | ตรวจสิทธิ์การเข้าถึง element/scope ก่อนรับ feedback ของ insight | **PASS** `[CONFIRMED]` | ตรวจ `insightRuleAllows` + `canReadScope` ก่อนบันทึก `assistant_feedback` |
| C-19 | Concurrency limiter / single-worker assumption | **PASS** `[CONFIRMED]` | `inFlight` ต่อผู้ใช้ + shared `ConcurrencyLimiter` + boot replica warning |
| C-20 | ไม่บันทึก raw dropped ref ลง audit log (กัน enumeration) | **PASS** `[CONFIRMED]` | `countByKind(resolved.dropped)` เก็บเฉพาะจำนวนนับต่อ `kind` |
| C-21 | ข้อมูลธุรกิจใน `ceo_metrics` | **PASS** `[CONFIRMED]` | จำกัดสิทธิ์ `ceo.view` (`head` เท่านั้น) และส่งเฉพาะตัวเลข aggregate |
| C-22 | คำเตือนบน ProposalCard เมื่อ turn มี customer/untrusted content | **PASS** `[TESTED]` | `hadCustomerContent` (fail-closed รวม `userNotes` / masked) + Playwright e2e `assistant-t410-gate.e2e.ts` |
| C-23 | ขอบเขต `reply_draft` สอดคล้อง N3 และ AC-J14 (ไม่มีทางไหลถึงลูกค้าเอง) | **PASS** `[CONFIRMED]` | Proposal สร้างเฉพาะ draft ให้ staff กดยืนยันเอง บล็อก `client` role ทุกทาง |
| C-24 | `personToneCheck` ป้องกันคำจัดอันดับ/เปรียบเทียบรายบุคคลทั้ง TH/EN และลำดับแฝง | **PASS** `[TESTED]` | `packages/ai/src/agents/insight-narrate.ts` (`personToneCheck` + `implicitRankingDrops`) |
| C-25 | Runtime gate ปิดโหมด N ของ element ที่มี `personRefs !== 'none'` เป็นค่าเริ่มต้น | **PASS** `[CONFIRMED]` | `INSIGHT_PERSON_NARRATION_ENABLED=false` จนกว่า golden eval §9.9 จะผ่าน |
| C-26 | บันทึก defense-in-depth ของ `readOnlyPool` (shared `watchtower_app` role) | **PASS** `[CONFIRMED]` | `docs/09-SECURITY.md` §13 |
| C-27 | เงื่อนไข PDPA Employee Privacy Notice + ROPA ก่อนเปิด narration รายคน | **PASS** `[ASK-HUMAN]` | ปิดไว้ด้วย `INSIGHT_PERSON_NARRATION_ENABLED=false`; รอเจ้าของอนุมัติถ้อยคำแจ้งพนักงานก่อนเปิดใช้งานจริง |

## 3. Residual P3 Notes (ไม่บล็อกการปิดงาน)
1. **N-1 (P3):** ปรับ `effectiveMode = 'F'` ใน `InsightsService.compose()` เมื่อ `!allowPersonNarration` เพื่อให้ badge แสดง `'system'` (*"From system"*) สอดคล้องกับ `docs/09-SECURITY.md` §13 (ดำเนินการแก้ไขรวมใน `T-418`/`T-420` แล้ว)
2. **N-2 (P3):** `history()` ใน `assistant-context-history.ts` ส่งต่อ `{ turns, refs, tools }` (สำหรับ `shift_note` ที่ไม่มี entity ref แยก ข้อความถูก redact ก่อนเก็บและผูก `fingerprint` + `tools: ['shift_context']` ของผู้ใช้อยู่แล้ว)

