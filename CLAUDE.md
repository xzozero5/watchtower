# CLAUDE.md — Watchtower

> ⚠️ อ่าน `@AGENTS.md` ก่อนเสมอ (กติกากลาง, non-negotiables, แผนที่เอกสาร) แล้วไปต่อที่ `HANDOFF.md` → `docs/STATUS.md` → `docs/BACKLOG.md` → `docs/00-START-HERE.md`
> ไฟล์นี้มีเฉพาะสิ่งที่ใช้กับ Claude Code โดยตรง — กติกาที่ใช้กับทุก AI อยู่ใน `AGENTS.md` ห้ามคัดลอกมาไว้ที่นี่ (กัน drift)

@AGENTS.md

## สิ่งที่ Claude Code ต้องทำเป็นอย่างแรกทุก session
1. อ่าน `HANDOFF.md` ทั้งไฟล์
2. ตรวจ/สร้าง `logs/daily/$(TZ=Asia/Bangkok date '+%F').md` ตาม `docs/templates/daily-log.template.md` แล้ว **log ทุก action ระหว่างทำ** (เวลากรุงเทพ)
3. รัน `/status` ถ้าไม่แน่ใจว่าจะทำอะไรต่อ

## Slash commands (`.claude/commands/`)
| คำสั่ง | ใช้เมื่อ |
|---|---|
| `/status` | สรุป phase ปัจจุบัน งานถัดไป blockers `[ASK-HUMAN]` ที่ค้าง |
| `/phase-0-bootstrap` … `/phase-3-autonomy` | เริ่มงานของ phase นั้นตาม BACKLOG (ดู `docs/00-START-HERE.md`) |
| `/review [T-xxx]` | ให้ `po` + `architect` (+ `security-reviewer`) ตรวจงานก่อน commit |
| `/handoff` | ปิด session: อัปเดต HANDOFF, daily log, STATUS, ADR, commit |

## Sub-agents (`.claude/agents/`)
`po` · `architect` · `backend-dev` · `frontend-dev` · `ai-engineer` · `integration-engineer` · `ux-designer` · `qa-engineer` · `security-reviewer` · `explorer` — บทบาทและเมื่อไรใช้ใคร ดู `docs/00-START-HERE.md` §Subagents
หลัก: main thread ตัดสินใจและเขียนไฟล์สำคัญ · งานอ่านหนัก/implement ยาวส่ง agent · ผู้ตรวจคนละตัวกับผู้ผลิต (N7)

## Hooks (`.claude/settings.json`)
- `PreToolUse` → `.claude/hooks/guard.py` บล็อก: อ่าน/พิมพ์ secret, `git push --force`, `--no-verify`, `rm -rf` นอก working tree, แก้ `evals/golden/**` โดย agent ผู้ผลิต, คำสั่งที่ยิง write ไป GCP/LINE/Discord/Gmail จริงนอก test
- `Stop` → `.claude/hooks/handoff_reminder.py` เตือนถ้า `HANDOFF.md` / daily log วันนี้ยังไม่ถูกแตะใน session

## Tech stack (ADR-001 — สรุป; รายละเอียดใน `docs/decisions/ADR-001-stack.md`)
TypeScript monorepo (pnpm + Turborepo) · `apps/web` Next.js + Tailwind + shadcn/ui + TanStack Query (PWA) · `apps/api` NestJS (REST/OpenAPI + WebSocket + MCP endpoint) · `apps/worker` BullMQ · `packages/db` Drizzle + Postgres 16 + pgvector · `packages/ai` Vercel AI SDK (Anthropic / Vertex) · `packages/channels` adapters (gmail, line, portal, discord, webhook) · Redis · MinIO · Docker Compose + Caddy · Vitest / Playwright / eval runner · GitHub Actions

## คำสั่งมาตรฐาน
```bash
pnpm install
pnpm dev                 # web + api + worker (ต้องมี docker compose up postgres redis minio)
pnpm test                # vitest ทุก package
pnpm test:e2e            # playwright
pnpm lint && pnpm typecheck
pnpm db:migrate && pnpm db:seed
pnpm eval                # AI eval runner (ต้องมี key — [ASK-HUMAN])
docker compose up -d     # ทั้งระบบ
```

## โครง repo (เป้าหมาย)
```
/
├── AGENTS.md  CLAUDE.md  HANDOFF.md  README.md  LICENSE  CHANGELOG.md
├── docs/            01-PRD.md  00-START-HERE.md  STATUS.md  BACKLOG.md  04-ARCHITECTURE.md  06-UI-SPEC.md
│                    07-TESTING.md  08-QA-CHECKLIST.md  09-SECURITY.md  decisions/  templates/  handoff-archive/
├── logs/daily/      YYYY-MM-DD.md
├── apps/            web/  api/  worker/
├── packages/        db/  ai/  channels/  ui/  shared/
├── examples/        intents/  procedures/  metrics/   (ของตัวอย่าง ไม่ใช่ของจริง)
├── evals/           golden/  runner/   (agent ผู้ผลิตห้ามแก้ golden/)
├── config/          models.yaml  budgets.yaml
├── tools/githooks/  pre-commit
├── .claude/         agents/  commands/  hooks/  settings.json
├── docker-compose.yml  .env.example  .gitignore
```

## Conventions (Claude Code)
- TypeScript strict, ห้าม `any` ยกเว้น boundary ของ SDK พร้อม comment · ทุก AI tool มี Zod schema input/output + unit test
- ไฟล์ที่มี backslash/escape ซับซ้อน → แก้ด้วย Edit tool ไม่ใช่ heredoc
- ห้าม `git stash/checkout` ขณะมี agent แก้ไฟล์เดียวกัน · commit data/seed แยกจาก code
- ⏰ shell ของ remote session เป็น UTC — เวลาใน log ใช้ `TZ=Asia/Bangkok date`
