# AGENTS.md — Watchtower (Tech Ops AI Command Center)

กติกากลางของทุก agent (model-agnostic) ไฟล์นี้สั้นโดยตั้งใจ รายละเอียดอยู่ในเอกสารที่ลิงก์ **ถ้าไฟล์ใน repo มีคำตอบ ห้ามตอบจากความจำของ model**

## โปรเจกต์นี้คืออะไร
Open-source, self-hosted **AI Command Center** สำหรับทีม Tech Operations ของบริษัท B2B SaaS — ticketing + omnichannel inbox (Gmail, LINE OA, portal) + alert/incident (GCP → Discord) + investigation tools (GCP Logs, BigQuery/Postgres, Git) + knowledge base + shift/handoff + AI ที่ pre-investigate/draft ให้คนอนุมัติ แล้วค่อย ๆ ยกระดับ autonomy รายตัว intent จนถึง AI support 100%
เจ้าของโปรเจกต์ทำหน้าที่ Product Owner + ผู้ตัดสินใจสุดท้าย · รายละเอียดทั้งหมด `docs/01-PRD.md`

## อ่านตามลำดับนี้ก่อนลงมือทุกครั้ง (cold start ≤ 15 นาที)
1. `AGENTS.md` (ไฟล์นี้)
2. `HANDOFF.md` — สถานะล่าสุด ค้างอะไร ขั้นต่อไป (≤ 40 KB อ่านจบได้ทุก model)
3. `docs/STATUS.md` (หัวข้อ "สถานะปัจจุบัน") + `docs/BACKLOG.md` — หยิบงานถัดไปที่ยังไม่ปิด
4. `docs/00-START-HERE.md` — phase, role, Definition of Done, `[ASK-HUMAN]`
5. เอกสารของงานที่จะทำเท่านั้น (ดูแผนที่ด้านล่าง) — อย่าอ่านทั้ง `docs/` ทุกครั้ง

**ไม่ได้ใช้ Claude Code** (Codex, Gemini CLI, Cursor, Copilot, AI อื่น หรือคน): ทุกอย่างใน repo ใช้ได้ — role ใน `.claude/agents/` และขั้นตอนใน `.claude/commands/` เป็น markdown ธรรมดา ใช้เป็น prompt ของ session แยกได้ · ความจำของ AI / Project instructions นอก repo **ไม่ใช่แหล่งความจริง** ถ้าขัดกับ repo ให้เชื่อ repo

## แผนที่เอกสาร (source of truth)
| เรื่อง | ไฟล์ |
|---|---|
| ทำอะไร เพื่อใคร requirement/AC, scenario, AI autonomy, data model, integration constraints, phase plan | `docs/01-PRD.md` |
| วิธีรันงาน: phase, slash command, role/agent, DoD, จุดที่ต้องถามคน | `docs/00-START-HERE.md` |
| สถานะล่าสุด (snapshot, เขียนทับ) | `HANDOFF.md` |
| log สถานะต่อ task + open questions + `[UNVERIFIED]` | `docs/STATUS.md` |
| งานเรียงลำดับ มี ID `T-xxx` และ DoD | `docs/BACKLOG.md` |
| การตัดสินใจที่มีผลอยู่ (stack, boundary, ข้อเบี่ยง) | `docs/decisions/ADR-xxx.md` (`docs/decisions/README.md` เป็นสารบัญ) |
| Architecture จริงของโค้ด (เขียนตอน Phase 0–1) | `docs/04-ARCHITECTURE.md` |
| UI spec / design tokens / copy TH-EN | `docs/06-UI-SPEC.md` |
| โลโก้ + สีแบรนด์ (ยืนยันแล้ว ใช้ PNG เป็นหลัก) | `docs/brand/README.md` |
| Test strategy, eval ของ AI, QA checklist, security checklist | `docs/07-TESTING.md`, `docs/08-QA-CHECKLIST.md`, `docs/09-SECURITY.md` |
| บันทึกรายวัน (timesheet) | `logs/daily/YYYY-MM-DD.md` (เวลากรุงเทพ) |
| HANDOFF ที่จบแล้ว | `docs/handoff-archive/` |
| ตัวอย่าง intent / procedure / metric SQL ที่ไม่ใช่ของจริง | `examples/` |
| template ทุกชนิด | `docs/templates/` |

## Non-negotiables (ห้ามละเมิด — ฉบับเต็มใน PRD §6.6, §8.2)
| # | กฎ | เหตุผล |
|---|---|---|
| N1 | **ไม่มี secret / credential / customer data / ชื่อหรือ procedure ภายในของบริษัทที่นำไปใช้ใน repo** — repo เป็นกลาง ไม่ผูกกับองค์กรใด (ผู้ใช้ fork แล้วใส่ข้อมูลตัวเองใน instance) · secret อยู่ใน environment เท่านั้น ห้ามพิมพ์ค่าออก stdout/log/transcript (ตรวจได้แค่ "มี/ไม่มี" หรือความยาว) | open source + ISO 27001 + PDPA |
| N2 | **tool ที่ AI/คนใช้ investigate เป็น read-only ทั้งหมด** (GCP Logs, BigQuery/Postgres, Git) และมี rate/cost budget; write action ใด ๆ ของ AI ต้องผ่าน policy หรือคนกด | PRD §6.1 |
| N3 | **AI ตอบลูกค้าเองได้เฉพาะ intent ที่ autonomy stage ≥ 3 และผ่าน gate** — default ทุก intent = stage 2 (draft-for-approval); auto-ack template ปลอดภัยเท่านั้นที่ส่งได้ทุก stage | PRD §6.4 |
| N4 | **PII ถูก redact ก่อนส่ง LLM เสมอ** และทุก AI action ลง audit log (prompt version, model, tools, cost) | PRD §6.6 |
| N5 | **แยก "ยืนยันแล้ว" ออกจาก "เดา"** ทุกที่ — เอกสารติดป้าย (ดูหัวข้อป้าย), โค้ดไม่ hard-code สิ่งที่ `[UNVERIFIED]` เป็นข้อเท็จจริง, UI แสดง confidence/citation | นิสัยของโปรเจกต์นี้ |
| N6 | **ค้นก่อนสร้าง** — grep ว่ามี component/module/doc/ADR อยู่แล้วหรือไม่ ห้ามทำของซ้ำ | ลด rework |
| N7 | **ผู้ตรวจต้องเป็น agent คนละตัวกับผู้ผลิต** — `po`/`qa-engineer`/`security-reviewer` ตรวจงานของ dev agent; agent ห้ามแก้ eval set/rubric ที่ใช้ตรวจงานตัวเอง | คุณภาพจริง |
| N8 | **งานทุกชิ้นต้องมี test ผ่าน + lint/typecheck ผ่าน + อัปเดต STATUS/BACKLOG ก่อนปิด** | Definition of Done |
| N9 | **ห้าม `git push --force` บน `main`**, ห้าม `--no-verify`, ห้ามลบไฟล์นอก working tree ที่ตัวเองสร้าง | ความปลอดภัยของ repo |
| N10 | **Stack และ boundary ตาม ADR** — จะเบี่ยงต้องเขียน ADR ก่อนแก้โค้ด | กัน drift |

## ป้ายกำกับ claim (หนึ่งป้ายต่อหนึ่ง claim)
`[CONFIRMED]` ยืนยันจากเจ้าของ/เอกสารทางการ · `[TESTED]` รันจริงแล้ว · `[ASSUMED]` ค่า default ที่สมเหตุสมผล รอยืนยัน · `[VERIFY]` มาจากแหล่งรอง ต้องตรวจกับต้นทาง · `[UNVERIFIED xx%]` ยังไม่ยืนยัน พร้อม confidence · `[ASK-HUMAN]` ต้องให้คนตัดสิน
ภาษาไทยใช้ `[ยืนยันแล้ว]` `[ทดสอบแล้ว]` `[ยังไม่ยืนยัน xx%]` `[เจ้าของตัดสินใจ]` ได้ ความหมายเดียวกัน

## วิธีทำงาน
- **Main thread = ผู้ตัดสินใจและผู้เขียนไฟล์สำคัญ** (docs, ADR, STATUS, HANDOFF, การ merge) · งานอ่านหนัก (โค้ดหลายไฟล์, log, spec ยาว) และงาน implement ยาว ส่ง sub-agent ที่เหมาะ (ดู `docs/00-START-HERE.md`) แล้วรับรายงานกลับสั้น ๆ: ทำอะไร / ไฟล์ที่แตะ / ผล test / สิ่งที่ยังไม่ยืนยัน
- ให้ sub-agent อ่านเฉพาะ `AGENTS.md` + เอกสารของงานตัวเอง (ประหยัด context) · รันหลาย agent ขนานได้เมื่อไม่แตะไฟล์เดียวกัน
- **ตรวจซ้ำรายงานของ agent ทุกครั้งก่อน commit** — รัน test เอง, เปิดไฟล์จริง, ไม่เชื่อ "ผ่านแล้ว" จากคำบอก
- งานที่ผลแน่นอน (validate, migrate, lint, คำนวณ) ใช้ script ไม่ใช้ LLM
- ข้อมูลเครื่องมือ/API ภายนอก (Gmail, LINE, Discord, GCP, BigQuery) ตรวจจากเอกสารทางการปัจจุบัน บันทึกวันที่และลิงก์ใน PRD §11 หรือ ADR
- ก่อนเริ่มแต่ละ phase ถามเจ้าของได้ไม่เกิน 5 ข้อที่เปลี่ยนทิศทางงาน นอกนั้นตัดสินใจเอง เขียนเหตุผลลง STATUS/ADR แล้วเดินต่อ
- เลือก model ตาม tier ใน `config/models.yaml` (`deep` / `standard` / `light`) ห้าม hardcode ชื่อ model ในโค้ด · log token/ต้นทุนของ AI ที่ใช้ระหว่าง build ลง daily log

## หยุดและถามเจ้าของเมื่อ (`[ASK-HUMAN]`)
- ต้องใช้ credential จริง (GCP, Gmail, LINE, Discord, GitHub, AI key) — เตรียม `.env.example` + runner ให้พร้อมแล้วหยุด ห้ามใช้ key จากที่อื่น
- จะทำสิ่งที่ย้อนกลับไม่ได้ (ลบข้อมูล, เปลี่ยน schema production, publish repo public, ส่งข้อความถึงลูกค้าจริง)
- ค่าใช้จ่าย API/cloud ต่อ session เกินงบใน `config/budgets.yaml`
- scope ขัดกับ PRD หรือ ADR และแก้ไม่ได้ด้วยการเขียน ADR ใหม่ที่เจ้าของจะยอมรับแน่ ๆ
- ต้องเพิ่ม dependency ที่มี network access ไปปลายทางใหม่
- เรื่อง security/privacy ที่ไม่แน่ใจ

## จบงานทุกครั้ง (ไม่ทำ = งานยังไม่เสร็จ)
1. อัปเดต `HANDOFF.md` ตาม `docs/templates/HANDOFF.template.md` — **เขียนทับสถานะ ไม่ append ประวัติ** ≤ 40 KB · เรื่องที่จบย้ายไป `docs/handoff-archive/`
2. append `logs/daily/YYYY-MM-DD.md` (เวลากรุงเทพ `TZ=Asia/Bangkok date '+%H:%M'` — shell บน remote อาจเป็น UTC; Git Bash บน Windows ไม่มี zoneinfo ให้ใช้ `TZ=ICT-7 date '+%H:%M'`) ตาม `docs/templates/daily-log.template.md` — log ระหว่างทำ ไม่ใช่รวบตอนจบ
3. อัปเดต `docs/STATUS.md` (entry ต่อ task) + ติ๊ก `docs/BACKLOG.md`
4. การตัดสินใจสำคัญ → ADR ใหม่ `docs/decisions/` ตาม `docs/templates/adr.template.md`
5. test/lint ผ่าน → commit เล็ก ๆ ข้อความบอกว่าทำอะไร (scope prefix: `web:` `api:` `worker:` `db:` `ai:` `docs:` `infra:`) → `git push`
6. ทดสอบในใจ: session ใหม่ (หรือ AI vendor อื่น) ที่อ่านแค่ `AGENTS.md` + `HANDOFF.md` ทำงานต่อได้ไหม

## เครื่อง, path, guard
- repo ของเจ้าของอยู่บน Windows `D:\Works\watchtower` · secret อยู่นอก repo (`D:\Works\secret\watchtower.env` → โหลดเป็น env) [ASSUMED]
- git pre-commit hook `tools/githooks/pre-commit` (เปิดครั้งเดียวต่อ clone: `git config core.hooksPath tools/githooks`) — บล็อก secret pattern, ไฟล์ > 10 MB, `.env`
- `.claude/hooks/guard.py` บังคับได้เฉพาะ Claude Code — AI อื่นต้องถือกฎใน Non-negotiables เอง

## ภาษา
สื่อสาร/เอกสารการทำงาน/commit = ไทย ศัพท์เทคนิคคงอังกฤษ · PRD, โค้ด, identifier, schema, OpenAPI, README สาธารณะ = อังกฤษ (open source) · UI = TH/EN (i18n)
