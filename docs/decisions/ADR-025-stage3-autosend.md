# ADR-025 — Stage 3 auto-send: env flag, shadow mode, promotion สองชั้น, auto-rollback (T-304a)

- **Status:** Proposed 2026-11-04 · ร่างโดย `architect` · รอ `security-reviewer` (N7, T-306a) และคำตอบเจ้าของ 5 ข้อท้ายไฟล์ก่อน Accepted · **supersede ADR-011 §2 เฉพาะ ceiling**
- **Date:** 2026-11-04 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของ (N3) · main thread commit
- **Context:** PRD §6.4 stage 3 = auto-send เมื่อ grader ≥ threshold ∧ intent allow-list ∧ customer verified; gate เข้า stage 3 = verified-resolution ≥ human, CSAT parity, reopen ≤ human ต่อเนื่อง ≥ 4 สัปดาห์ · §6.6 grader อิสระ, kill switch, budget, disclosure · ADR-011 §2 ceiling สามชั้น (CHECK ≤ 2, `PHASE_MAX_AUTONOMY_STAGE = 2`, api 403) และ `decide()` ปฏิเสธ `ai_auto` เสมอ · `outbound_delivery_origin_check` ไม่มี `ai_auto` (0013) `[TESTED: อ่าน migration]` · BACKLOG Phase 3: ทำ code/test/shadow ได้ ห้ามตั้ง flag บน POC/production จนเจ้าของสั่ง · POC ใช้ `sonnet` ทุก tier (ADR-019) · disclosure ทำด้วยโค้ด `disclosureFor()` + `senderAuth` (T-114a)

## Decision
### 1. ชั้นป้องกัน 4 ชั้น (ต้องผ่านครบ)
| ชั้น | ใครคุม | ปิด/ไม่ผ่านแล้ว |
|---|---|---|
| L0 env `AI_AUTOSEND_ENABLED` | เจ้าของ (สิทธิ์ server) | ไม่มี `ai_auto` เลย = stage 2 + shadow |
| L1 `decide()` pure | โค้ด | deny + reason code + audit |
| L2 DB (CHECK, trigger, SECURITY DEFINER) | schema | INSERT/UPDATE ถูกปฏิเสธ |
| L3 คน (head ขอ + เจ้าของอนุมัติ ต่อ intent) | คน | intent ค้าง stage 2 |

### 2. Env flag
- อ่านครั้งเดียวตอน boot ของ api และ worker · ON เฉพาะสตริง `true` ตรงตัว · Zod ใน `packages/shared` → `createPolicyGate({ db, autosend })`
- ไม่มีใน DB / admin UI / API แก้ · `GET /v1/autonomy` แสดง `autosendFlag` อ่านอย่างเดียว · ON ตอน boot = warn 1 บรรทัด + audit `autonomy.autosend_flag_boot`
- worker ตรวจ flag ของตัวเองซ้ำตอน claim (api ON/worker OFF = ไม่ส่ง) · flag OFF แต่ DB มี stage 3 → `effectiveStage = min(stage, autosend ? 3 : 2)` · promote ขณะ flag OFF = 409 `autosend_flag_off`

### 3. Shadow mode
- `intent.autosend_shadow` (lead/head ตั้ง, default false `[ASSUMED]` เพราะเพิ่ม grader 1 call ต่อ draft) ใช้ได้เมื่อ effective stage ≥ 2 และ kill switch ปิด
- หลัง drafter: compose (draft + footer §8) → grader `pre_send` → `decideAutoSend(facts)` (ฟังก์ชันเดียวกับ live) → `ai_autosend_evaluation (mode='shadow')` เก็บ `would_auto_send`, `failed_conditions[]` · **draft ยังรอคนอนุมัติ**
- `shadow_precision` = % ของ `would_auto_send=true` ที่คนอนุมัติโดยแก้ ≤ 10% → หลักฐานหลักของ promotion · live เขียนแถว `mode='live'` ทุกครั้ง

### 4. เงื่อนไข `ai_auto` ใน `decide()` (ตรวจตามลำดับ คืน reason ข้อแรกที่ไม่ผ่าน)
1. flag ON (`autosend_flag_off`) 2. actor = ai 3. kill switch ปิด 4. cap switch ปิด 5. intent stage = 3 หลัง effectiveStage (`stage_below_3`)
6. grade `pre_send` ผูก content hash ของ message ที่จะส่งตรงตัว, อายุ ≤ 10 นาที `[ASSUMED]`, passed, violations = [], score ≥ `intent.autosend_min_score` (0.85 `[ASSUMED]`, ช่วง 0.70–1.00)
7. grader อิสระ: (provider, model) ของ grader ≠ ของ drafter (`grader_not_independent`) — ดูคำถามเจ้าของ #2
8. disclosure verified ตาม `disclosureFor()` **และ** อีเมล inbound ทุกฉบับของ ticket `senderAuth='pass'` (`contact_unverified` / `sender_unauthenticated`)
9. allow-list `intent.autosend_policy` (Zod): channels ⊆ {gmail, portal} (LINE = feature ภายหลัง), action = reply อย่างเดียว (ตั้ง `pending_customer` ได้), citation KB visibility customer ≥ 1, ไม่มีประโยค uncited, ลิงก์เฉพาะ portal/KB ของ instance, ไม่มีไฟล์แนบ, ไม่มี placeholder, ≤ `maxChars`
10. ticket: ไม่ใช่ P1/P2, ไม่ผูก incident ที่เปิด, ลูกค้าไม่ได้ขอคุยกับคน, auto ติดกันใน ticket ≤ 2, ไม่เคย reopen หลัง auto `[ASSUMED]`
11. procedure ที่ publish ของ intent ตั้ง `autosend: 'allowed'` และ `procedure_version_id` ของ draft = version ที่ publish (ADR-026)
12. งบ: auto-send ต่อ intent ต่อวัน ≤ `autosend_daily_cap` (20 `[ASSUMED]`) และงบ AI รายวันยังไม่เกิน
- facts โหลดใหม่ทุกครั้ง (ไม่ cache) · โหลดไม่ได้ = deny · deny ตอน schedule/claim → draft กลับเป็น `draft` + ป้ายใน ticket "AI ตั้งใจส่งแต่ถูกระงับ: <reason>" + audit (dedupe ตาม A-6)
- ลำดับ: drafter → compose → grade `pre_send` → gate → `outbound_delivery(origin='ai_auto')` hold 120 s `[ASSUMED]` (คนพิมพ์ตอบ/assign = ยกเลิก) → gate ซ้ำตอน claim → ส่ง → `ticket.ai_handled = true`

### 5. DB (migration เดียว เลขกำหนดตอน merge)
- `intent`: CHECK 0..3 แทน `intent_autonomy_phase1_check` · `PHASE_MAX_AUTONOMY_STAGE = 3` · `set_intent_autonomy()` ยกเป็น 3 ไม่ได้ (`WT003`) · trigger `intent_require_promotion`: INSERT stage 3 = ปฏิเสธ, UPDATE <3→3 ต้องมีแถว promotion `approved` ที่ยังไม่ apply อายุ ≤ 72 ชม. ผูก gate report `green` อายุ ≤ 7 วัน · คอลัมน์ `autosend_shadow`, `autosend_min_score`, `autosend_daily_cap`, `autosend_policy` (column grant; ลดเกณฑ์ของ intent ที่ stage 3 ต้องเป็น head + history)
- ตารางใหม่: `intent_autonomy_promotion` (ผ่าน `request_/decide_/apply_stage_promotion()` SECURITY DEFINER, `search_path` ตรึง ตาม A-1), `autonomy_gate_report` (append-only), `ai_autosend_evaluation` (append-only), `seed_batch`
- `ai_grade` (T-301b) ต้องมี: `ai_draft_id, content_hash (trigger คำนวณ), phase ('pre_send'|'post_resolution'|'sampled'), grader_ai_run_id, grader_provider, grader_model, drafter_provider, drafter_model, score, passed, violations`
- `outbound_delivery`: origin เพิ่ม `ai_auto` + `ai_grade_id` (CHECK ai_auto ⇔ มี grade) ห้ามมี `approved_by`/`created_by` · insert trigger ตรวจ draft `auto_approved`, hash ตรง, grade passed, grader ≠ drafter, stage 3, สวิตช์ปิด, ไม่มีไฟล์แนบ, channel ∈ {gmail, portal} · message ai_auto `sender_user_id IS NULL`
- `ai_draft.status` เพิ่ม `auto_approved` · `intent_autonomy_history.change` เพิ่ม `promotion`/`auto_rollback` + `promotion_id`, `evidence`
- **A-9/A-10/A-11** (ย้ายจาก T-125): REVOKE UPDATE(id,key)/DELETE บน `intent`; reason 3–500 ตัวทุกฟังก์ชัน; partition ใหม่ได้ `reject_mutation` เท่า parent
- down migration: มี stage 3 หรือ ai_auto ที่ยัง scheduled = RAISE

### 6. Promotion 2 → 3
- gate report รายสัปดาห์ + on demand · window ≥ 28 วันที่ stage 2 ต่อเนื่อง · **นับเฉพาะ `seed_batch_id IS NULL`** · เกณฑ์: verified-resolution AI ≥ human `[CONFIRMED PRD]`, reopen AI ≤ human `[CONFIRMED PRD]`, CSAT AI ≥ human − 0.1 (≥ 20 response ต่อกลุ่ม) `[ASSUMED]`, shadow ≥ 50 evaluation และ precision ≥ 90% `[ASSUMED]`, eval replay violations = 0 + redaction eval ผ่าน · sample ไม่พอ = `insufficient_data` ≠ green
- ขั้นตอน: head ขอ (สิทธิ์ `ai.autonomy.promote`, ต้อง report green + flag ON) → เจ้าของอนุมัติ (สิทธิ์ `ai.autonomy.owner_approve` ให้ผ่าน CLI เท่านั้น, re-auth + พิมพ์ key ของ intent) → `apply_stage_promotion()` + history + audit `autonomy.promoted` → แจ้ง head · report เป็น input ให้คน ไม่ใช่ผู้ตัดสิน

### 7. Auto-rollback → stage 2 + audit + แจ้ง head
- trigger (เฉพาะ ticket ที่มี ai_auto และไม่ใช่ seed): grader พบ policy violation → ทันที · reopen / CSAT ≤ 2 → ดูคำถามเจ้าของ #4 · grader `pre_send` ไม่ผ่าน ≥ 3 ใน 20 draft ล่าสุด · gate report รายสัปดาห์ red · เปลี่ยน model/prompt/procedure ที่ยังไม่มี replay ผ่าน = **ระงับ** (ไม่ rollback)
- worker `autonomy-watch` (event + ทุก 15 นาที) → `rollback_intent_autonomy()` idempotent · delivery ที่ค้างถูก deny ตอน claim · ขอ promote ใหม่ได้เมื่อมี report green ที่ window เริ่มหลัง rollback (≥ 28 วัน)

### 8. แจ้งลูกค้าว่าเป็นคำตอบอัตโนมัติ
- `instance_setting` `autosend.disclosure = { enabled (default true [ASSUMED]), text: { th, en } }` head แก้ได้ + audit · footer ใส่ฝั่ง server ตอน compose (ถูก hash และ grade ด้วย) · UI ป้าย "AI ส่งอัตโนมัติ"

### 9. Threat model (T-306a ต้องลอง)
ข้าม gate (INSERT/UPDATE ตรง, SECURITY DEFINER + TEMP table, flag ผ่าน DB) · แก้ข้อความหลัง grade (hash) · grader = drafter · prompt injection ให้ auto-send (model ไม่เลือก tool, uncited ส่งไม่ได้, ห้ามลิงก์/แนบ, ≤ 2 auto ต่อ ticket, P1/P2 ไม่ auto — **ที่เหลือ:** paraphrase ที่เลี่ยงตัวตรวจกันได้แค่ grader) · grader ถูก injection (delimiter, Zod, เงื่อนไขเชิงโครงสร้างไม่ขึ้นกับ model) · เปิดเผยให้ unverified (เงื่อนไข 8) · flag เดียวเปิดทั้งระบบ (ต้อง promotion ต่อ intent) · seed ทำให้ report เขียว (`seed_batch_id` ที่ app role แก้ไม่ได้) · ยกสิทธิ์ตัวเอง (CHECK ผู้ขอ ≠ ผู้อนุมัติ, owner ผ่าน CLI)

### 10. แยกข้อมูล seed
- `seed_batch(id, kind 'demo'|'year'|'e2e', loaded_at, loaded_by, note)` · `seed_batch_id` บน `ticket` + `organization` · app role ไม่มี UPDATE คอลัมน์นี้และ INSERT `seed_batch` ไม่ได้ (seed รันด้วย role ของ migrator `[UNVERIFIED 60%]`) · trigger ticket seed ต้องอยู่ใน org batch เดียวกัน · partial index `ticket (intent_id, resolved_at) WHERE seed_batch_id IS NULL`
- POC: `pnpm db:mark-seed --dry-run` (org ใน cast ของ seed + `external_id LIKE 'seed-%'`) · รันจริงบน POC = `[ASK-HUMAN]` + สำรองก่อน · instance pilot ใหม่ไม่มี seed 1 ปี (เจ้าของ 2026-11-04)

### 11. Test ก่อน merge (DoD T-304b–g)
- property test `decide.test.ts`: ทุกชุด origin × actor × intent × สวิตช์ × flag × facts → **flag OFF ⇒ ไม่มี `ai_auto`** · stage < 3 ⇒ ไม่มี · fact หาย ⇒ deny · regression ADR-011 12,800 กรณีเดิม
- integration DB: INSERT ai_auto ที่ stage 2 / ไม่มี grade / hash ไม่ตรง / grader = drafter / สวิตช์เปิด / มีไฟล์แนบ ⇒ ปฏิเสธ · UPDATE stage ตรง ⇒ ปฏิเสธ · promotion ไม่ครบเงื่อนไข ⇒ ปฏิเสธ · TEMP table โจมตี SECURITY DEFINER
- worker: flag OFF + stage 3 ใน DB ⇒ มีแค่ shadow · api ON/worker OFF ⇒ ไม่ส่ง · rollback idempotent · report ไม่นับ seed · e2e T-306b ใน stack ทิ้ง (**ห้ามตั้ง flag บน POC**)

## Options considered
- A flag ใน DB ให้ head เปิด — ขัด N3 · ตัด · B GUC — app role ตั้งเองได้ ไม่เพิ่มความปลอดภัย · ตัด · C head อนุมัติคนเดียว — ขัด N3 · ตัด · **D (เลือก) flag env + gate pure + DB trigger + คนสองชั้น + shadow** · E ข้าม shadow ใช้ eval อย่างเดียว — ไม่สะท้อน traffic จริง · ตัด

## Consequences
- ต้นทุน grader 1 call ต่อ draft เมื่อ shadow/stage 3 · POC (sonnet ทุก tier) เปิด stage 3 ไม่ได้จนกว่า grader ใช้ model อื่น
- คำตอบอัตโนมัติรูปแบบจำกัด (มี citation, ไม่มีลิงก์/ไฟล์แนบ) — ขยายต้องมี ADR ใหม่
- งานตามมา: T-301b (`ai_grade` ตาม §5), T-304b–g · T-125 ตัด A-9/10/11 มาไว้ที่นี่ · ADR-011 §2 superseded เมื่อ Accepted
- ตรวจซ้ำ: ก่อนตั้ง flag บน instance ใด, ก่อนเปิด LINE auto-send, ก่อน stage 4, rollback > 1 ครั้ง/intent/เดือน

## การตัดสินของเจ้าของ 2026-11-04 `[CONFIRMED]` (แทนค่า [ASSUMED] ที่ขัดกันในข้อบน)
1. **ผู้อนุมัติ promotion:** คนเดียวกับผู้ขอได้ (เจ้าของเป็น head) แต่ต้อง re-auth + พิมพ์ key ของ intent ยืนยัน → CHECK ผู้ขอ ≠ ผู้อนุมัติ ใช้ **เฉพาะเมื่อผู้อนุมัติไม่มีสิทธิ์ `ai.autonomy.owner_approve`**; ผู้ถือสิทธิ์ owner (ให้ผ่าน CLI) อนุมัติคำขอของตัวเองได้พร้อม re-auth + typed confirm และลง audit `self_approved: true`
2. **grader อิสระ = ต่าง model vendor เดียวกันพอ** (เช่น grader `opus` ตรวจ drafter `sonnet` ผ่าน claude-cli) · เงื่อนไข 7 ตรวจ model id ต่างกัน
3. **footer แจ้งลูกค้าว่าเป็นคำตอบอัตโนมัติ เปิดเป็นค่าเริ่มต้น** (head แก้ข้อความ TH/EN หรือปิดได้ + audit)
4. **rollback:** policy/data-leak violation → ทันที · reopen หรือ CSAT ≤ 2 → เมื่อรวม ≥ 2 ใน 20 auto-send ล่าสุดของ intent
5. seed: instance pilot ใหม่ไม่มี seed (เจ้าของ) · POC ทำ `db:mark-seed --dry-run` ก่อน รันจริง = `[ASK-HUMAN]` · ช่องทาง auto-send รอบแรก Gmail + portal เท่านั้น (LINE = feature ภายหลัง)
- Status คงเป็น Proposed จน `security-reviewer` ตรวจ (T-306a ✅ 2026-11-05) และตรวจซ้ำผลแก้ (T-306j)

## แก้ตามผลตรวจ T-306a (T-306e, migration 0109) — เพิ่มเงื่อนไขหลังข้อ 11 `[TESTED]` ด้วย property/integration test
- **C-1:** `procedure_requires_human` (`ticketRequiresHuman()` = มี event `procedure.require_human`) และ `escalation_pending` (card `procedure.escalation_proposed` ที่ยังไม่ apply และยังไม่หมดอายุ ตาม `readProcedureProposals`) · fact หาย/ไม่ใช่ `false` = deny
- **C-2:** ข้อความถูก normalize (NFKC, ตัวอักษรล่องหน, เลขไทย, `[.]`/`(dot)`/`。`/`hxxp`, IDN → punycode) แล้วทุก link/อีเมล/เบอร์/@handle/LINE id/IP/host ต้องเป็น origin ของ instance หรือปรากฏตรงตัวใน snippet KB ที่ draft cite · **ข้อจำกัด:** snippet ที่เก็บใน `ai_ticket_insight.evidence` ผ่าน redactor แล้ว เบอร์/อีเมลใน KB จึงมักเป็น `[PHONE_1]` → ตอบเบอร์จาก KB ไม่ผ่าน (fail closed) · `customerWantsHuman` ขยายวลี TH/EN + กฎ: หลังมี `ai_auto` ใน ticket inbound ถัดไปทุกฉบับ = ขอคน จนกว่าคนจะตอบ
- **C-3:** portal verified เฉพาะ `customFields.portal.requesterVerified === true` (ไม่ใช้ `contact.verifiedAt`) — **แก้ 2026-11-05 (T-306h):** ตั้ง `true` (+ `requesterVerifiedAt`) เมื่อเปิดลิงก์ "คำขอของฉัน" (ticket portal ของ contact ที่มีอยู่ตอนคลิก) หรือลิงก์ tracking ที่ส่งทางอีเมล (ticket นั้น) · ticket ที่ยื่นทีหลังด้วยอีเมลเดียวกันยังไม่ verified · ช่องว่างที่ยอมรับ `[ASSUMED]`: ticket ที่คนอื่นยื่นด้วยอีเมลของลูกค้าก่อนลูกค้าคลิกจะถูก verify ด้วย แต่คำตอบไปที่กล่องจริงเท่านั้น · `disclosureFor()` ของ drafter/simulation ยังใช้ `contact.verifiedAt` เดิม (ไม่แตะ `procedure-simulate`) — main thread ตัดสิน 2026-11-05: drafter stage 2 คง `contact.verifiedAt` เพราะมีคนอนุมัติทุกฉบับ `[ASK-HUMAN: เจ้าของรับรอง]`
- **C-4:** `ai_replay_result` (0109, append-only, เขียนผ่าน `record_replay_result()` ที่ต้องมีสิทธิ์ `ai.autonomy.promote`; passed เป็นไปไม่ได้ถ้า mock/ไม่มีเคส/มี violation/redaction eval ไม่ผ่าน) · fact `replayPassed` = แถวล่าสุดของชุด (drafter model, grader model, prompt version ทั้งสอง, procedure version ที่ publish) ผ่าน + `procedure_simulation` ล่าสุดของ version นั้นผ่านบน `steps_hash` เดียวกัน · ไม่ผ่าน = `replay_missing` (ระงับ ไม่ rollback; rule `gate_red` ข้าม report ที่แดงเพราะ replay อย่างเดียว) · gate report: `eval_replay_violations`/`redaction_eval` ตัดสินจริง (ไม่มีผล = `insufficient_data`) · worker `autonomy-watch` สุ่มตรวจ ai_auto ที่ส่งแล้ว (`ai_grade.phase='sampled'`; `instance_setting` `autosend.sampling` default 100% ของ 20 ตัวแรกหลัง promote แล้ว 20%, เลือกจาก hash ของ delivery id จึงคงที่ทุกรอบ) แล้ว rule `violation` rollback ในรอบเดียวกัน · **ตัวเขียน (T-306g, 2026-11-05):** `pnpm --filter @watchtower/eval-runner record -- --intent <key> --as <email>` เรียก `record_replay_result()` ด้วยผู้ถือ `ai.autonomy.promote` (runbook `pilot-instance.md` 9b) · replay อัตโนมัติเมื่อเปลี่ยนของยังไม่ทำ (T-302d)
- **C-10:** inbound อ่านแบบ aggregate ใน SQL (sender auth ทุกฉบับ, ข้อความล่าสุดก่อน, เกิน 1,000 ฉบับ = ขอคน)
- **C-11:** ไม่มี `ai_run` ของ drafter/grader (agent/ticket ตรงกัน) = deny `ai_run_missing` · `ai_run.response_model` เก็บ model id ที่ provider ตอบ และ `ai_grade.*_model` ใช้ค่านั้น (ไม่มี = alias) · `[UNVERIFIED 50%]` claude-cli bridge คืน model ใน response ได้จริงหรือไม่ (โค้ดรองรับ ถ้าไม่คืนจะได้ alias) และ SDK adapter ใส่ `request.model` เมื่อ provider ไม่ตอบ → แยก "ตอบจริง" กับ "alias" ไม่ได้ใน `response_model`
- **C-14:** gate report `metrics.reviewers` = สัดส่วน approve/edit/reject ต่อผู้ตรวจ

## Links
PRD §6.4–6.6, §9 · BACKLOG T-301b, T-302c/d, T-304a–g, T-306a–c, T-125 · ADR-010 §5, ADR-011, ADR-013 §6, ADR-019, ADR-023, ADR-026 · migration 0007, 0013, 0014 · `packages/domain/src/autonomy/decide.ts`, `apps/worker/src/outbound/dispatcher.ts`, `apps/worker/src/ai/investigation.ts`
