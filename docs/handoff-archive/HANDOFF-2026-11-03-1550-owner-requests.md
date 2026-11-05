# HANDOFF — Watchtower

> อัปเดตล่าสุด: 2026-11-03 15:50 (เวลากรุงเทพ) โดย Claude Code main thread — คำขอเจ้าของ 6 ข้อ (rail, อีเมลแบบ Gmail, แนบรูป, `claude -p` docker, seed 1 ปี)
> ฉบับก่อน: `docs/handoff-archive/HANDOFF-2026-11-03-1320-po-quality-sweep.md`

## สถานะปัจจุบัน
- **Branch:** งานรอบนี้อยู่ `codex/po-workflow-upgrade` และ **fast-forward เข้า `main` ในเครื่องแล้ว** (เจ้าของสั่ง "พร้อม" 2026-11-03 17:00) · **ยังไม่ push** origin/main ยังเป็น `8be6c5e`
- **Phase:** 0/1 MVP + 2 mock เหมือนเดิม; รอบนี้ปิด T-165…T-169, เปิด T-170/T-171 (ส่วนที่เหลือ)
- **ผลตรวจ [TESTED]:** typecheck 17/17, lint 18/18 + prettier ผ่าน; unit ทุก package ผ่าน (web 114 ไฟล์, shared 868, db/seed 64, worker 22 ไฟล์, ai, channels, domain, ui, connectors); api ผ่าน 38/39 ไฟล์ในรอบ gate — ไฟล์ที่ล้ม (email-reply ชนขณะแก้, routes-policy เพราะ dev เข้าถึง uploads) แก้แล้วรันซ้ำเฉพาะไฟล์ผ่าน **แต่ยังไม่ได้รัน api ครบชุดหลังแก้**; integration (agent รันเอง): uploads 8, shifts/incidents/manual/portal 131, kb-sync 5, migration up/down 3
- **Demo `wt-year` (โค้ดรอบนี้ + seed 1 ปี):** `http://localhost:53000` (api :54000, mailpit :58025, pg :55432) dev login เปิด (เช่น `head@example.com` role Head) · AI/Gmail mock · env/override อยู่ใน scratchpad ของ session (ไม่อยู่ใน repo) · ปิด: `docker compose -p wt-year down -v` · image ชื่อ `wt-year/*` ไม่ทับ POC
- **POC ของเจ้าของ (`watchtower`, :3000) deploy โค้ดรอบนี้แล้ว 2026-11-03 17:05:** สำรอง DB ก่อน (`D:\Works\watchtower-backups\poc-20261103-1703.dump`, pg_dump -Fc) → build api/worker/web จาก main → migrate (0082/0083 ถูกรันไปแล้วตั้งแต่ 16:39 โดยไม่ตั้งใจ จาก `up --build gmail-tunnel` ที่พ่วง api+migrate — runbook §4 แก้เป็น `--no-deps` แล้ว) → ทุก service healthy, AI provider ready (sonnet ทุก tier, classifier timeout 15 s), OPS-1012 แสดงแบบ Gmail ใน Chrome เจ้าของ `[TESTED]`
- **POC = ชุดเดียวสำหรับใช้จริง + demo (เจ้าของสั่ง 2026-11-03 17:10):** seed reference + ข้อมูลจำลอง 1 ปีลง POC แล้ว (ticket 3,839, รูปแนบ 8 ภาพใน MinIO) ผ่าน `docker-compose.seed.yml` · สำรองก่อน `poc-20261103-1711-pre-year-seed.dump` · ปลด tier ของ SLA ทดสอบ 2 ตัว (runbook §5b) · Home แสดง open 95 · stack อื่น (`wt-year`, `wt-demo` เก่า, `wt-e2e-*`) **หยุดแล้วแต่ยังไม่ลบ** — การลบ volume ถูก permission บล็อก เจ้าของลบเองได้ด้วย `docker compose -p wt-year down -v` / `docker compose -p wt-demo down -v` / `docker rm wt-e2e-pg wt-e2e-redis wt-e2e-mailpit`
- **e2e ก่อน push [TESTED]:** full-stack 36 ผ่าน + 1 ล้ม (`ac1-gmail` noise, flaky T-161 — รันไฟล์เดียวผ่าน 8/8) + 1 ไม่ได้รัน; web e2e 184 ผ่าน/32 skip/2 ล้ม (`keyboard` focus, `shift` AC-7 — flaky T-161, รันแยกซ้ำ 2 รอบผ่าน 36/36)
- **bridge ยัง publish `127.0.0.1:4317`** และ env ยังใช้ `host.docker.internal` (ใช้ได้ทั้ง worker เก่า/ใหม่) — ถ้าจะปิด port ให้เจ้าของเปลี่ยน `CLAUDE_CLI_BRIDGE_URL=http://claude-bridge:4317` ก่อน แล้วเอา `ports` ของ claude-bridge ออก
- **ต้นทุน:** ไม่มี external AI/cloud call ในผลิตภัณฑ์; build agents 6 ตัว (frontend/backend×2/ai/security) ไม่มี meter รวม

## การตัดสินใจของเจ้าของที่มีผลอยู่
- **ADR-019 (2026-11-03):** `claude -p` เป็น AI หลักไปก่อน, sonnet ทุก tier (ตั้งใน env ไม่ hardcode), bridge เป็น compose service เปิดค้าง (profile `ai`, network `ai` เฉพาะ worker), AI ใช้ได้เมื่อ host online — offline = รอ/ลองใหม่ ไม่ fallback mock · KB folder ภายนอก `D:\Works\watchtower-kb` (`WATCHTOWER_KB_DIR`) + `pnpm kb:sync` · **ยังคงข้อห้าม claude-cli เมื่อ `NODE_ENV=production` หรือ `APP_URL` ไม่ใช่ loopback** (ดูรอเจ้าของ)
- อีเมลแสดงแบบ Gmail + composer จริง, แนบรูปทุกที่ (คำขอ 2026-11-03)
- ADR-017/018 เดิมยังมีผล

## ทำเสร็จใน session นี้
| งาน | ผล | ไฟล์หลัก |
| --- | --- | --- |
| T-165 | Daily brief/Shift handoff ไฮไลต์ถูก; rail ไม่ล้น (nav scroll) — ตรวจบนจอจริง | nav-rail.tsx, console-layout.tsx |
| T-166 | Gmail thread view (iframe sandbox + sanitizer + บล็อกรูป remote + cid), email composer (To/Cc/Bcc, Subject, rich text, signature, quote, preview, รูป inline), MIME multipart, migration 0082 | conversation/email/*, composer.tsx, channels gmail/reply.ts, api tickets/email-reply.ts |
| T-167 | `/v1/uploads` + แนบกับ note/handoff/incident/manual ticket/reply/internal note; dev ไม่มีสิทธิ์ (T-137) | api uploads/*, web components/attachments/*, migration 0083 |
| T-168 | ADR-019, bridge Dockerfile + compose, healthz/online, brief เลื่อนเมื่อ offline, kb:sync | tools/claude-cli-bridge/*, packages/ai, packages/db/src/kb-sync |
| T-169 | `pnpm db:seed:year` ~3.8k tickets, 21.6k ข้อความ, KB 95, incident 21, กะ/handoff ทั้งปี, AI/CSAT, รูปแนบ 8 ภาพ (มี S3) — รันจริง 2 รอบ | packages/db/src/seed/year/* |
| Security review (N7) | ไม่มี P0/P1 · แก้แล้ว: C-1 approve draft ส่ง HTML อื่น, C-3 seed guard, C-6 แยก network bridge, C-9 flag seed · ค้าง C-2/4/5/7/8 → T-171 | |

## ค้าง / ติดอะไร
- T-170: แถบ "AI offline" ทั้งระบบ, investigation/draft เลื่อนเมื่อ offline, kb:sync ลบไฟล์ → deprecate, ยืนยันชื่อ `CLAUDE_CODE_OAUTH_TOKEN` `[VERIFY]` + build image bridge (เจ้าของ build แล้วใช้งานอยู่ — ยังไม่ได้ตรวจผลใน `ai_run`)
- T-171: draft AI ลง rich editor, style อีเมลลูกค้าหายตอน ingest, audit ผู้รับ/allow-list domain, Gmail ตัด Bcc `[UNVERIFIED 80%]`, EXIF WebP/GIF, Playwright email/upload
- **T-172 (ADR-020) รันจริงแล้ว 2026-11-03:** IAM ใน `<project-id>` ครบ (custom role get/update, SA `watchtower-pubsub-admin`), key อยู่โฟลเดอร์ secret, env audience คงที่ `watchtower-gmail-push` · `gmail-tunnel` healthy, subscribe สำเร็จ, self-check 401 · **ยังไม่ได้ทดสอบอีเมลจริงจากบัญชีภายนอก**
- **AI บน POC:** worker image เก่ายอมแค่ `host.docker.internal` → bridge publish `127.0.0.1:4317` (ชั่วคราว) แล้ว `claude -p` ผ่าน bridge ตอบจริง `[TESTED]` · เจ้าของตั้ง sonnet ทุก tier เอง · หลัง rebuild POC + migrate 0082/0083 ให้เปลี่ยนเป็น `http://claude-bridge:4317` แล้วเอา port ออก
- ของเดิม: T-154/T-155, T-158 rail counts, T-159, T-141…147, B-002/B-003/B-004, T-113/T-114/T-207, T-115, T-161 flaky
- ไม่แก้/commit `.agents/` และ `.codex/`

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] เงื่อนไขบริการ Anthropic กับการใช้ subscription แบบอัตโนมัติ + ข้อมูลลูกค้าผ่าน `claude -p` (ADR-019)
- [ ] จะเปิด Watchtower ผ่าน internet เมื่อไร: ตอนนี้ claude-cli ถูกปฏิเสธเมื่อ APP_URL ไม่ใช่ loopback → ต้องเลือก: คง local / แก้ ADR ยอมให้ / ใช้ API key ใน production
- [ ] หลังแก้ compose รอบนี้ ต้อง `docker compose --env-file D:\Works\secret\watchtower.env --profile ai up -d claude-bridge worker` และตั้ง `CLAUDE_CLI_BRIDGE_URL=http://claude-bridge:4317`
- [ ] ส่งอีเมลทดสอบจากบัญชีภายนอกเข้ากล่อง support (พิสูจน์ push ครบวงจร) · กำหนดรอบ rotate key ของ `watchtower-pubsub-admin`
- [ ] push `main` ขึ้น origin (ยังไม่ทำตามคำสั่งเจ้าของ), malware scanning (T-155), ข้อความไทยให้เจ้าของภาษาตรวจ, T-115 pilot

## ขั้นต่อไป (เรียงลำดับ)
1. full-stack e2e + Playwright ของฟีเจอร์ใหม่บน service ทิ้ง (api unit ครบชุดผ่านแล้ว 39 ไฟล์ / 266 test) แล้วค่อย push
2. เจ้าของตั้ง SA + key แล้วรัน `gmail-tunnel` (runbook §4) → ทดสอบรับ-ส่งอีเมลจริงกับ composer ใหม่ (ยืนยัน Bcc)
3. T-170, T-171
4. ปิด demo `wt-year` เมื่อไม่ใช้ (`docker compose -p wt-year down -v`)
5. ของเดิมตาม BACKLOG

## วิธีเปิดระบบและทดสอบต่อ
- `docs/runbooks/local-poc.md` (§3/§3b claude-bridge + KB) + `docs/07-TESTING.md`; integration/fullstack ห้ามใช้ DB/Redis/MinIO ของ POC
- seed demo: `pnpm db:seed` แล้ว `pnpm db:seed:year` (ฐานต้องว่าง/มีแค่ demo; ใส่ `S3_*` เพื่อให้มีรูปแนบ)
- gate บน Windows: `pnpm exec turbo run test test:boundaries --concurrency=1 -- --maxWorkers=4`; build/typecheck/browser เรียงลำดับ
- compose build: `migrate` กับ `api` ใช้ image เดียวกัน → `up --build` ครั้งแรกอาจล้ม "image already exists" ให้ `build api` ก่อนแล้วค่อย `up`
- ห้ามพิมพ์ค่า env/credential

## ยังไม่ยืนยัน
- Gmail จริงกับ composer ใหม่ (HTML/cc/bcc/inline image), cid image ใน browser จริงจากข้อความที่ส่งจริง, bridge ใน container login ด้วย token, offline detection บนเครื่องจริง
- api unit ครบชุดหลังแก้, full-stack e2e, Playwright ของฟีเจอร์ใหม่ ยังไม่รัน
- mobile จริง, ข้อความไทยโดยเจ้าของภาษา

## วันตรวจซ้ำ
- security review: 2026-11-03 (diff รอบนี้)
