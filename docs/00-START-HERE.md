# 00 — START HERE: วิธีให้ AI (Claude Code หรืออื่น) ทำโปรเจกต์ Watchtower

เอกสารชุดนี้เขียนให้ main thread อ่านแล้วลงมือได้ทันที โดยไม่ต้องถามคนเพิ่ม ยกเว้นจุดที่ระบุ `[ASK-HUMAN]`

## ลำดับการอ่าน (ครั้งแรกเท่านั้น)
1. `AGENTS.md` — กติกากลาง, non-negotiables, แผนที่เอกสาร
2. `HANDOFF.md` — สถานะล่าสุด
3. `docs/01-PRD.md` — ทำอะไร เพื่อใคร วัดผลอย่างไร (อ่าน §0–§2, §4 ของโมดูลที่จะทำ, §5 scenario, §6 AI, §7 data model, §11 constraints, §12 stack, §15 phase)
4. `docs/BACKLOG.md` — งานเรียงลำดับ
5. ที่เหลืออ่านเมื่อถึง phase นั้น

## Phases และคำสั่ง
| Phase | ชื่อ | slash command | เอกสารหลัก | agent หลัก | ผลลัพธ์ที่ต้องได้ (exit criteria) |
|---|---|---|---|---|---|
| 0 | Foundation | `/phase-0-bootstrap` | PRD §7, §12; ADR-001 | `architect`, `backend-dev` ∥ `frontend-dev`, `po` | monorepo รัน `docker compose up` ได้, auth + RBAC + org/contact + ticket core + portal channel + three-pane shell + audit log + seed; e2e AC-1 (portal path) ผ่าน |
| 1 | Inbox + AI stage 0–2 + Shifts | `/phase-1-inbox` | PRD §4.1–4.2, §4.4, §4.7, §4.9–4.10, §5.1–5.2, §6 | `integration-engineer`, `ai-engineer`, `backend-dev`, `frontend-dev`, `ux-designer` | Gmail + LINE + portal เข้า ticket, auto-ack, classifier/investigator/drafter + A/E/R, KB RAG, CSAT email, Discord notify, realtime, roster/clock-in/brief/handoff; AC-1, AC-2, AC-4, AC-7 ผ่าน; ทีมรันกะจริงในระบบได้ |
| 2 | Reliability + Usage | `/phase-2-reliability` | PRD §4.3, §4.5, §4.6, §4.8, §5.3, §9.1 | `integration-engineer`, `backend-dev`, `frontend-dev` | GCP Monitoring/Logging ingest, dedup/correlation/escalation, service catalog, incident + Discord thread, status page, deploy feed, usage metrics + anomaly → proactive ticket, Client Health Score, ops dashboard; AC-3, AC-5 ผ่าน |
| 3 | Autonomy + Learning | `/phase-3-autonomy` | PRD §6.4–6.7, §4.4 authoring, §9.2 | `ai-engineer`, `po`, `security-reviewer` | grader, eval set + replay, golden answers, KB author, procedures + simulation, stage 3 สำหรับ 2–3 intent แรก, cost dashboard, CEO view + weekly brief, roster planner; intent แรกผ่าน gate 4 สัปดาห์ |
| 4 | Mobile + Scale | (ภายหลัง) | PRD §12 | — | React Native app, org-private status page, LINE group chat, Helm |

ทุก phase ปิดด้วย `/review` ของ `po` (+ `qa-engineer` regression) และ `/handoff`

## Subagents (`.claude/agents/`)
| agent | tier | บทบาท | ใช้เมื่อ |
|---|---|---|---|
| `po` | deep | ตรวจงานตรง PRD/AC + non-negotiables, ปรับ BACKLOG, ตัดสิน scope, เสนอ (ไม่ตัดสินแทนเจ้าของ) | ก่อนเริ่มและหลังจบทุก phase / ทุก `/review` |
| `architect` | deep | ออกแบบ/ทบทวน architecture, boundary ระหว่าง module, schema, เขียน ADR | Phase 0, เมื่อจะเบี่ยงจาก ADR, เมื่อแตะ `packages/db` หรือ boundary ของ `packages/ai`/`channels` |
| `backend-dev` | standard | NestJS modules, Drizzle schema/migration, BullMQ jobs, REST/WS/MCP, unit + integration tests | ทุก phase |
| `frontend-dev` | standard | Next.js/React ตาม UI spec, three-pane, keyboard-first, realtime, PWA, unit tests | ทุก phase |
| `ai-engineer` | standard | provider abstraction, agents (classifier/investigator/drafter/grader), tools registry, prompts (versioned), PII redaction, eval runner | Phase 1, 3 |
| `integration-engineer` | standard | adapters: Gmail push/history, LINE webhook/reply-vs-push, Discord bot/webhook, GCP Pub/Sub, Logging/Monitoring/BigQuery clients, GitHub App — พร้อม contract tests และ sandbox/mocks | Phase 1, 2 |
| `ux-designer` | deep | design tokens, three-pane layout, states (empty/loading/error), alert discipline, a11y, copy TH/EN → `docs/06-UI-SPEC.md` | ต้น Phase 1 และก่อน dashboard Phase 2 |
| `qa-engineer` | standard | e2e Playwright จาก scenario PRD §5, exploratory, bug report `docs/qa/bugs.md`, regression หลังทุก phase | ปิดทุก phase |
| `security-reviewer` | deep | secret handling, RBAC/audit, PII redaction, read-only credentials, webhook signature, dependency/SBOM, CSP | Phase 0 (auth), Phase 1 (channels/AI), Phase 3 (autonomy), ก่อน release |
| `explorer` | light | อ่านโค้ด/log/spec จำนวนมากแล้วสรุปสั้น (read-only) | ทุกครั้งที่ต้อง "ไปดูให้หน่อยว่า…" |

หลักการ delegate:
- **Main thread = ผู้ตัดสินใจและผู้เขียนไฟล์สำคัญ** (docs, ADR, STATUS, HANDOFF, merge)
- งาน implement ยาวให้ agent ทำ แล้วรายงานกลับ: ทำอะไร / ไฟล์ที่แตะ / ผล test / สิ่งที่ยังไม่ยืนยัน — **main thread ตรวจซ้ำก่อน commit**
- agent อ่านเฉพาะ `AGENTS.md` + เอกสาร phase ของตัวเอง
- รันขนานได้เมื่อไม่แตะไฟล์เดียวกัน (เช่น `backend-dev` ทำ api ขณะ `frontend-dev` ทำ web shell)
- ผู้ตรวจ (`po`, `qa-engineer`, `security-reviewer`) ต้องไม่ใช่ agent ที่ผลิตงานนั้น (N7)
- tier → model จริงอยู่ใน `config/models.yaml`; `.claude/agents/*.md` ใส่ `model:` ตาม tier ปัจจุบัน

## Definition of Done (ทุก task)
- [ ] โค้ด + test ผ่าน (`pnpm test`, e2e ถ้าแตะ flow), `pnpm lint && pnpm typecheck` ผ่าน
- [ ] ไม่ละเมิด Non-negotiables N1–N10 ใน `AGENTS.md`
- [ ] OpenAPI/README ของ module อัปเดต ถ้าเปลี่ยน API
- [ ] อัปเดต `docs/STATUS.md` (entry ต่อ task) และติ๊ก `docs/BACKLOG.md`
- [ ] สิ่งที่ยังไม่ยืนยันติดป้ายและอยู่ใน "Open questions" ของ STATUS.md
- [ ] ถ้ามีการตัดสินใจใหม่ → ADR
- [ ] log ลง `logs/daily/` ระหว่างทำ

## `[ASK-HUMAN]` — จุดที่ต้องหยุดถามคน (เพิ่มเติมจาก `AGENTS.md`)
1. สร้าง GitHub repo / ตั้งค่า org, license, การ publish public — เจ้าของทำหรืออนุมัติ (PRD §13)
2. credential ทุกชนิด: GCP service account, Gmail domain-wide delegation, LINE channel secret/token, Discord bot token, GitHub App, Anthropic/Vertex key — เตรียม `.env.example` + วิธีใส่ แล้วหยุด
3. คำตอบ PRD §16 (repo host, Cloud SQL replica, GCP projects, mailbox, LINE plan, Discord, ทีม/กะ, SLA tier, AI provider) — ใช้ `[ASSUMED]` ไปก่อนได้ แต่บันทึกใน `docs/STATUS.md` → "Open questions"
4. ก่อนส่งข้อความใด ๆ ถึงลูกค้าจริง หรือเชื่อมต่อ production จริงครั้งแรก
5. งบ API ต่อ session ทดสอบเกิน `config/budgets.yaml`
6. การเปลี่ยน autonomy stage ของ intent ใดขึ้นเป็น ≥ 3 ครั้งแรก

นอกเหนือจากนี้ ให้ตัดสินใจเอง เขียนเหตุผลลง STATUS.md/ADR แล้วเดินต่อ

## ลำดับงาน Phase 0 (ย่อ — รายละเอียด BACKLOG T-000…T-012)
T-000 main thread: git init / remote / hooks / commit แผน → T-001 `architect` ADR-001 ยืนยัน stack + โครง monorepo + `docs/04-ARCHITECTURE.md` ร่าง → ∥ T-002 `backend-dev` api + db + docker compose · T-003 `frontend-dev` web shell + design tokens → T-004 `backend-dev` auth/RBAC/audit → T-005 `backend-dev` org/contact/ticket core → T-006 `frontend-dev` three-pane + ticket views → T-007 `backend-dev`+`frontend-dev` portal channel → T-008 seed → T-009 `qa-engineer` e2e AC-1 → T-010 `security-reviewer` auth/secrets review → T-011 `po` review → T-012 `/handoff` + tag `v0.0.1`
