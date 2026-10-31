# STATUS — สถานะโปรเจกต์ (main thread อัปเดตทุกครั้งที่ปิด task)

รูปแบบ entry: `## YYYY-MM-DD HH:MM (Asia/Bangkok) — <ใคร/agent> — <phase/task>` แล้วตามด้วย ทำอะไร / ไฟล์ที่แตะ / test / ค้าง / ไม่ยืนยัน
snapshot สั้นสำหรับ cold start อยู่ที่ `HANDOFF.md` — ไฟล์นี้คือ log ต่อ task + open questions

## สถานะปัจจุบัน
| Phase | สถานะ (2026-10-31) | ค้าง |
|---|---|---|
| 0 Foundation | ⏸️ พัก รอทำต่อบน cloud session | T-005 ค้างบน `wip/t-005` |
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
- `docs/brand/watchtower-logo.svg` รุ่น 22:09 สีตรงกับ PNG แล้ว แต่รูปทรงเป็นแบบย่อ: ไม่มีหน้าต่างบนตัวประภาคาร, ซี่ราวระเบียง, ซี่กรอบโคมไฟ และคลื่นคนละทรง (ตรวจจาก source) → UI ยังใช้ PNG เป็นโลโก้ และใช้ hex ใน `docs/brand/README.md` เป็น token
- `[CONFIRMED 2026-10-31]` secret ของ infra อยู่ใน env เท่านั้น, credential ของ integration อยู่ใน env หรือ DB เข้ารหัส ตั้งผ่าน admin UI (ADR-004, งาน T-116) · `docs/04-ARCHITECTURE.md` §5 ต้องปรับถ้อยคำตามหลัง T-004
- `[ASK-HUMAN]` deploy ขึ้น GCP อยู่ใน Post-MVP แต่ pilot T-115 ต้องมีข้อมูลจริงและ webhook สาธารณะ → เสนอย้ายมาก่อน T-115, ให้ `po` พิจารณาใน T-011
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
- ปรับปรุง 22:09: วัดค่าสีจริงจาก PNG ด้วย Pillow สรุปโค้ดสีตรงเป๊ะ (#E5594A, #F7F0D4, #1D2739, #B2E4D8), เขียน `watchtower-logo.svg` ใหม่ให้ตรงกับ PNG 100% (ลบ badges/คำโปรยออกหมด, ฟอนต์สีเดียว #363839), บันทึก Alert Discipline (สีแดงใช้เฉพาะโลโก้ ปุ่มหลักใช้ Midnight Navy เพื่อไม่ชนกับ P1 Alert)
- ค้าง: —
- ไม่ยืนยัน: —


## 2026-11-01 00:25 (Asia/Bangkok) — main thread — พักงาน, T-005 ยังไม่เสร็จ
- ทำอะไร: เจ้าของสั่งพักเพื่อย้ายไป cloud session จึงหยุด `backend-dev` กลางคัน เก็บงานทั้งหมดบน branch `wip/t-005` แล้ว push · หยุด compose โดยไม่ลบ volume
- ไฟล์ที่แตะ: `HANDOFF.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `logs/daily/2026-11-01.md` บน `main` · โค้ด T-005 บน `wip/t-005`
- test บน `wip/t-005`: lint, typecheck, unit test ผ่าน `[TESTED]` · `test:integration` และ e2e ยังไม่ได้รัน
- ค้าง: ตรวจข้อส่งมอบ T-005 ที่ยังขาด (agent ถูกหยุดก่อนรายงาน)
- ไม่ยืนยัน: cloud session มี Docker หรือไม่ `[VERIFY]`

## 2026-10-31 23:35 (Asia/Bangkok) — backend-dev + main thread — T-004
- ทำอะไร: Google OIDC + PKCE พร้อม mock mode, magic link, break-glass, session JWT + refresh rotation, CSRF สามชั้น, RBAC deny-by-default + permission table, audit log immutable แบบ partition, migration `0001`, ADR-005 (Proposed รอ T-010)
- ไฟล์ที่แตะ: `apps/api/src/{auth,audit,rbac,users,queue,cli,testing}`, `apps/worker/src/{mailer,processors}`, `packages/db`, `packages/shared/src/{auth,rbac,config,queues}`, `docker-compose.yml`, `.env.example`, `docs/04-ARCHITECTURE.md`
- test: main thread รันซ้ำแบบ `--force`: lint, typecheck, test (api 80, worker 19, db 11, shared 39, web 60, ui 121), build ผ่าน; `test:integration` api 155, db 24, worker 9 ผ่าน; ลองแก้ `audit_log` บน DB จริงด้วย owner และลบด้วย `watchtower_app` ถูกปฏิเสธ แถวยังอยู่ `[TESTED]`
- ค้าง: ทดสอบ magic link ครบวงจรผ่าน `curl` ไม่ได้รัน (`guard.py` บล็อกบรรทัดที่มีคำว่า token) แต่มี integration test ครอบ และจะอยู่ใน e2e T-009 · ลบ token หมดอายุ → T-117
- ไม่ยืนยัน: flow กับ Google จริง ทดสอบกับ fake OIDC เท่านั้น `[UNVERIFIED 60%]` · permission matrix `[ASSUMED]` · web/api same-site `[ASSUMED]` · production บังคับต้องมี Google OIDC จึงยังไม่รองรับองค์กรที่ไม่ใช้ Google `[ASSUMED]`
- ข้อมูลทดสอบ: `audit_log` ของ stack หลักมีแถวจากการทดสอบ 9 แถวที่ลบไม่ได้โดยการออกแบบ (DB local เท่านั้น)

## 2026-10-31 22:32 (Asia/Bangkok) — backend-dev + main thread — T-002
- ทำอะไร: `apps/api` (health, Zod config, OpenAPI, pino, OTel, CORS allow-list), `apps/worker` (BullMQ + health), `packages/db` (migration runner แบบ up/down + checksum), `docker-compose.yml`, Dockerfile ของ api/worker, `Caddyfile`, `.env.example` ฉบับครบ, ADR-003
- ไฟล์ที่แตะ: ตามรายการใน merge `cc220fb`
- test: main thread รันซ้ำหลัง merge: `--force` lint/typecheck/test/build ผ่าน; `docker compose up -d --wait` ครบทุก service healthy รวม web; `/health` ของ web, api, worker = 200; caddy `/` และ `/api/health` = 200, `/metrics` ผ่าน caddy = 404; CORS ตอบเฉพาะ origin ของ `APP_URL`; ทุก port bind `127.0.0.1`; `test:integration` 19 เคส ผ่าน; e2e 22 เคส ผ่าน `[TESTED]`
- ค้าง: worker ยังไม่มี OTel/`/metrics` · CORS ยังไม่เปิด `credentials` ต้องกำหนดพร้อม CSRF ใน T-004
- ไม่ยืนยัน: image `pgsty/minio` เป็นของบุคคลที่สาม (ADR-003) `[VERIFY]` · ชื่อ metric ไม่มี suffix `_seconds`

## 2026-10-31 22:25 (Asia/Bangkok) — frontend-dev + main thread — T-003
- ทำอะไร: `apps/web` Next.js + Tailwind + TanStack Query, `/health`, API URL ตอน runtime, design tokens ใน `packages/ui` พร้อม contrast test, three-pane เปล่า, command palette stub, i18n TH/EN, Dockerfile, ใช้โลโก้ PNG และ palette จาก `docs/brand/README.md`
- ไฟล์ที่แตะ: `apps/web/**`, `packages/ui/**`, `eslint.config.mjs`, root `package.json`, `turbo.json`, `.prettierignore`, `pnpm-lock.yaml`
- test: main thread รันซ้ำหลัง merge แบบ `--force`: lint, typecheck, test (web 60, ui 121, shared 6, channels 2, db 1, ai 1), build, e2e 22 passed ด้วย `PW_CHANNEL=msedge`; เปิดหน้าจอจริงดู dark/light + ⌘K ถูกต้อง `[TESTED]` · docker image รายงานโดย frontend-dev ยังไม่ได้ตรวจซ้ำ (จะตรวจตอน compose ครบหลัง T-002)
- ค้าง: PWA manifest/service worker ยังไม่ทำ ตาม ADR-001 ต้องมี → ย้ายไป T-006 · ไม่มี `eslint-plugin-jsx-a11y` เพราะ peer ไม่รองรับ ESLint 10 ใช้ axe ใน e2e แทน
- ไม่ยืนยัน: สี link/focus และ surface ที่ palette ไม่ได้กำหนด `[ASSUMED]` · ภาษาเริ่มต้น `en` `[ASSUMED]` · e2e ใช้ Edge บนเครื่องนี้ CI ต้อง `playwright install` (ดาวน์โหลดจาก `cdn.playwright.dev` ตอน dev/CI เท่านั้น) และยังไม่ได้ทดสอบบน Linux `[UNVERIFIED 80%]`

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
