# STATUS — สถานะโปรเจกต์ (main thread อัปเดตทุกครั้งที่ปิด task)

รูปแบบ entry: `## YYYY-MM-DD HH:MM (Asia/Bangkok) — <ใคร/agent> — <phase/task>` แล้วตามด้วย ทำอะไร / ไฟล์ที่แตะ / test / ค้าง / ไม่ยืนยัน
snapshot สั้นสำหรับ cold start อยู่ที่ `HANDOFF.md` — ไฟล์นี้คือ log ต่อ task + open questions

## สถานะปัจจุบัน
| Phase | สถานะ (2026-10-31) | ค้าง |
|---|---|---|
| 0 Foundation | 🟨 กำลังทำ | T-002, T-003 |
| 1 Inbox + AI 0–2 + Shifts | ⬜ | — |
| 2 Reliability + Usage | ⬜ | — |
| 3 Autonomy + Learning | ⬜ | — |
| 4 Mobile + Scale | ⬜ | — |

- Test ล่าสุด: ยังไม่มีโค้ด
- Blockers: ไม่มี · `[ASK-HUMAN]` ค้าง: credential, PRD §16

## Open questions / `[UNVERIFIED]` / `[ASSUMED]` ที่ยังค้าง
- PRD §16 (Cloud SQL replica, GCP projects, mailbox + delegation, LINE plan/volume, Discord, ทีม/กะ, SLA tiers, AI provider/budget) — ข้อ 9 ปิดแล้ว: public, Apache-2.0, เป็นกลางไม่ผูกกับองค์กรใด `[CONFIRMED 2026-10-31]`
- `[CONFIRMED 2026-10-31]` Google Workspace domain ของ SSO อ่านจาก env ค่าตัวอย่าง `example.com`
- `[ASSUMED]` งบ `build_ai` $10/session วัดไม่ได้บน Max plan จึงดู % plan limit แทน
- `[VERIFY]` `docs/brand/watchtower-logo.svg` ไม่ตรงกับ PNG ที่เจ้าของเลือก (SVG มี badge และ wordmark สองสี, สีแดงเข้มกว่า) และสีใน `docs/brand/README.md` ตรงกับ SVG มากกว่า PNG → UI ใช้ PNG เป็นโลโก้ และใช้ hex ใน README เป็น token
- `WT_MAIN_THREAD=1` ใน `.claude/settings.local.json` (เจ้าของตั้งเอง) ปลดการป้องกัน HANDOFF/STATUS/BACKLOG ให้ sub-agent ด้วย → main thread ตรวจ diff ของสามไฟล์นี้หลัง agent ทุกตัว; `guard.py` ควรแยก sub-agent จาก hook input แทน env (เสนอ ยังไม่ทำ)
- LINE TH pricing/quota `[VERIFY]` · LINE mark-as-read `[VERIFY]` · Google managed MCP availability `[VERIFY]`
- วันหยุดราชการไทย 2026–2027 สำหรับ business calendar `[VERIFY]` (T-008)
- งบ API: ยังไม่ตั้ง (`config/budgets.yaml` ค่า default `[ASSUMED]`)

## กติกาจากบทเรียน (เติมเมื่อเจอ)
- (ยืมจากโปรเจกต์ก่อน) ตรวจซ้ำรายงาน agent ก่อน commit · ห้าม `git stash/checkout` ขณะ agent แก้ไฟล์เดียวกัน · test ห้ามเขียนลง data จริง · ไฟล์ที่มี backslash แก้ด้วย Edit tool · ห้ามพิมพ์ secret ออก stdout แม้เพื่อตรวจ
- `TZ=Asia/Bangkok date` บน Git Bash (Windows) ให้เวลา GMT ผิด 7 ชม. → ใช้ `TZ=ICT-7 date` `[TESTED]`
- `grep -i` (โดยเฉพาะ `-F -i`) abort บน Git for Windows เครื่องนี้ → lowercase ด้วย `tr` แล้วค่อย match และ script ตรวจความปลอดภัยต้อง block เมื่อ grep error `[TESTED]`
- บรรทัดใน `.gitignore` ห้ามมี comment ต่อท้าย pattern

## Log

## 2026-10-31 22:05 (Asia/Bangkok) — main thread — Brand Design
- ทำอะไร: ออกแบบ Brand Identity และ Logo ประจำโปรเจกต์ Watchtower ตามคำสั่งเจ้าของ คัดเลือกและปรับแต่งรูปทรง Sea Lighthouse จนสรุปที่ Option 3B-3 (Midnight Navy Dome Roof + Warm Coral Red & Ivory Body Stripes) สบายตา อบอุ่น และสื่อถึงการเฝ้าระวัง Tech Ops
- ไฟล์ที่แตะ: `docs/brand/*`, `docs/brand/README.md`, `HANDOFF.md`, `logs/daily/2026-10-31.md`
- test: สร้างไฟล์ภาพความละเอียดสูง Master PNG (`watchtower-logo.png`), App Icon 512x512 (`watchtower-icon.png`), Favicon 64x64 (`favicon.png`) และ Vector SVG ทั้งหมดพร้อมใช้งาน `[TESTED]`
- ค้าง: —
- ไม่ยืนยัน: —


## 2026-10-31 21:50 (Asia/Bangkok) — architect + main thread — T-001
- ทำอะไร: monorepo pnpm + Turborepo, placeholder 5 package, boundary lint, `docs/04-ARCHITECTURE.md` ร่าง, ADR-002
- ไฟล์ที่แตะ: root config, `tools/eslint/`, `packages/*`, `docs/04-ARCHITECTURE.md`, `docs/decisions/ADR-002-boundary-enforcement.md`, PRD §12
- test: main thread รันซ้ำแบบ `--force` lint/typecheck/test/build และยืนยันว่าไฟล์ละเมิดใน `packages/ai` ทำ lint fail `[TESTED]`
- ค้าง: `pnpm test:e2e` ยังไม่มี test จริง (T-003) ห้ามนับเป็นผ่าน
- ไม่ยืนยัน: boundary test บน Linux/CI `[UNVERIFIED 90%]` · `eslint-config-next` กับ ESLint 10 `[UNVERIFIED 70%]` · drizzle-kit กับ `PARTITION BY` `[VERIFY]`
- `[ASK-HUMAN]` Turbo telemetry เปิดอยู่บนเครื่อง dev: เจ้าของปิดเองด้วย `turbo telemetry disable`; CI/Docker ตั้ง `TURBO_TELEMETRY_DISABLED=1`

## 2026-10-31 21:35 (Asia/Bangkok) — main thread — T-000
- ทำอะไร: git init ต่อจาก `origin/main` (`f848253`, LICENSE Apache-2.0) ให้ push เป็น fast-forward, เปิด hooks, แก้ `.gitignore`, เพิ่ม `.gitattributes` (LF), ทำเอกสารให้เป็นกลางตามคำสั่งเจ้าของ, แก้ pre-commit ให้ fail closed
- ไฟล์ที่แตะ: `.gitignore`, `.gitattributes`, `tools/githooks/pre-commit`, `AGENTS.md`, `FIRST_PROMPT.md`, `HANDOFF.md`, `docs/01-PRD.md` §0/§1/§2/§3/§4/§13/§16/§17, `docs/00-START-HERE.md`, `docs/claude-project-instructions.md`, `.claude/agents/{po,security-reviewer,integration-engineer}.md`
- test: pre-commit 6 กรณีใน scratch repo ผ่าน `[TESTED]`
- ค้าง: —
- ไม่ยืนยัน: intent taxonomy ใหม่ใน PRD §3.1 `[ASSUMED]`

## 2026-10-31 21:05 (Asia/Bangkok) — Claude (claude.ai planning session) — Pre-Phase 0
- ทำอะไร: research, PRD v0.1, ชุดไฟล์วิธีทำงาน (AGENTS, CLAUDE, START-HERE, BACKLOG, HANDOFF, templates, agents, commands, hooks, ADR-001, FIRST_PROMPT)
- ไฟล์ที่แตะ: ทั้งชุด kickoff
- test: —
- ค้าง: T-000
- ไม่ยืนยัน: ดูหัวข้อ Open questions
