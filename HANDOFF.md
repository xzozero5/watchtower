# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-01 00:25 (เวลากรุงเทพ) โดย Claude Code (main thread, Phase 0) — เจ้าของสั่งพักเพื่อย้ายไปทำต่อบน cloud session
> กฎขนาด ≤ 40 KB — เขียนทับสถานะ ไม่ append ประวัติ · เรื่องที่จบย้ายไป `docs/handoff-archive/` · บันทึกรายชั่วโมงอยู่ `logs/daily/`

> ⚠️ **T-005 ค้างอยู่บน branch `wip/t-005` ไม่ใช่ `main`** — งานถูกหยุดกลางคัน ต้องทำต่อจาก branch นี้ ห้ามเริ่มใหม่

## สถานะปัจจุบัน
- **Phase:** 0 — Foundation · เสร็จ T-000, T-001, T-002, T-003, T-004 · T-005 ทำค้าง
- **Build/Test:**
  - `main`: lint, typecheck, test, build, `test:integration`, e2e 22 เคส ผ่านตอน T-004 (`c130f66`) `[TESTED]`
  - `wip/t-005`: lint, typecheck, unit test ผ่าน (api 107, shared 103, db 19, worker 19, ui 121, web 60, boundaries 94) `[TESTED]` · **`test:integration` และ e2e ยังไม่ได้รัน** · ยังไม่รู้ว่าข้อส่งมอบ T-005 ครบกี่ข้อ เพราะ agent ถูกหยุดก่อนรายงาน
- **Repo:** `xzozero5/watchtower` public, Apache-2.0, เป็นกลางไม่ผูกกับองค์กรใด (PRD §13) `[CONFIRMED 2026-10-31]`
- **Deployment:** Docker Compose บน local ก่อน → production บน GCP ภายหลัง (ADR-001) `[CONFIRMED 2026-10-31]`
- **Credential ที่มีแล้ว:** ไม่มี ทุก integration เป็น mock mode (`[ASK-HUMAN]` ก่อนต่อของจริง)
- **เงิน:** บัญชีเป็น Max plan ไม่คิดราย API จึงวัดงบ `build_ai` เป็นดอลลาร์ไม่ได้ ดู % plan limit แทน `[ASSUMED]`

## ⚠️ ตั้งค่าก่อนเริ่มบนเครื่องหรือ cloud ใหม่ (ไม่ติดมากับ git)
1. `git config core.hooksPath tools/githooks` — เปิด pre-commit
2. `WT_MAIN_THREAD=1` — ต้องมีใน environment ของ session ไม่งั้น `guard.py` บล็อกการแก้ `HANDOFF.md`, `docs/STATUS.md`, `docs/BACKLOG.md` · บนเครื่องเดิมตั้งใน `.claude/settings.local.json` ซึ่ง gitignore · **agent ตั้งเองไม่ได้ (auto mode ปฏิเสธ) เจ้าของต้องตั้ง** · ค่านี้ปลดให้ sub-agent ด้วย main thread จึงต้องตรวจ diff ของสามไฟล์นี้หลัง agent ทุกตัว
3. `.git/info/forbidden-terms` — รายการคำต้องห้ามของ pre-commit อยู่นอก repo โดยตั้งใจ clone ใหม่จะไม่มีและ hook จะข้ามการตรวจเงียบ ๆ · ขอรายการจากเจ้าของก่อน commit แรก · ถ้าไม่มี ให้ตรวจ diff เองตามกฎ N1
4. ตั้ง `TURBO_TELEMETRY_DISABLED=1` และ `NEXT_TELEMETRY_DISABLED=1` ทุกครั้งที่รัน turbo/next
5. e2e ต้องมี browser: เครื่องเดิมใช้ `PW_CHANNEL=msedge` ที่อื่นให้ `pnpm --filter @watchtower/web exec playwright install --with-deps chromium` `[VERIFY บน Linux]`
6. Integration test และ `docker compose up` ต้องมี Docker · ยังไม่รู้ว่า cloud session มี Docker หรือไม่ `[VERIFY]` ถ้าไม่มีให้ใช้ Postgres (pgvector) กับ Redis ของ environment นั้นผ่าน `TEST_DATABASE_URL` / `TEST_REDIS_URL` ถ้าทำไม่ได้ให้รายงาน ห้ามนับว่าผ่าน

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ชื่อโปรเจกต์ **Watchtower** — 2026-10-31 20:57
- Tech stack ตาม ADR-001 — 2026-10-31 21:01
- รัน Docker local ก่อน, deploy จริงบน GCP — 2026-10-31 21:01
- Feature set ตาม PRD v0.1 รวม CSAT email, GCP Monitoring, product-usage dashboard + proactive ticket — 2026-10-31 20:43–20:45
- Repo public และเป็นกลาง ห้ามมีชื่อหรือข้อมูลขององค์กรที่นำไปใช้ องค์กรจะ fork ไปใส่ข้อมูลตัวเอง — 2026-10-31 21:25
- SSO domain อ่านจาก env — 2026-10-31 21:25
- Secret ของ infra อยู่ใน env, credential ของ integration ตั้งผ่าน admin UI แบบเข้ารหัสได้ — 2026-10-31 — ADR-004, N1
- `.env.example` ไม่อยู่ใน deny rule — 2026-10-31 — `.claude/settings.json`
- โลโก้ Option 3B-3 ออกแบบโดย Gemini ยึดตาม `docs/brand/` — 2026-10-31 22:04
- Default autonomy = stage 2 ทุก intent; เป้าหมายระยะยาว AI support 100% — PRD §6.4
- commit และโค้ดเป็นอังกฤษ, เอกสารการทำงานเป็นไทย, PRD เป็นอังกฤษ — 2026-10-31

## ทำเสร็จใน session นี้
| งาน | ผล | ไฟล์ |
|---|---|---|
| T-000 | repo ต่อจาก `f848253`, hook, เอกสารเป็นกลาง | `.gitignore`, `.gitattributes`, `tools/githooks/pre-commit` |
| T-001 | monorepo + boundary lint | `tools/eslint/`, `packages/*`, `docs/04-ARCHITECTURE.md`, ADR-002 |
| T-002 | api, worker, migration runner, compose ครบ | `apps/api`, `apps/worker`, `packages/db`, `docker-compose.yml`, ADR-003 |
| T-003 | web shell, design tokens, three-pane เปล่า, โลโก้ | `apps/web`, `packages/ui` |
| T-004 | auth, session, RBAC, audit log | `apps/api/src/{auth,audit,rbac,users}`, ADR-005 (Proposed) |
| Credential policy | แก้ N1 ตามเจ้าของ, เพิ่ม T-116 | ADR-004, `AGENTS.md` |

## ค้าง / ติดอะไร
- **T-005 บน `wip/t-005`** — มี migration `0002_ticketing`, `apps/api/src/{orgs,intents,sla,team-queues,tickets,realtime}`, `packages/shared/src/{sla,ticketing,realtime,directory,channels}`, `examples/intents/` — ต้องตรวจกับข้อส่งมอบใน `docs/BACKLOG.md` T-005 แล้วทำส่วนที่ขาด รวมถึง WebSocket, `CLIENT_ORG_RESOLVER`, และ FK `users.org_id` → `organization`
- Checksum ของ migration: DB ใน stack local เดิมได้ apply `0002` ไปแล้ว ถ้าแก้ไฟล์นี้ต่อ DB local เดิมต้อง reset (DB ใหม่บน cloud ไม่กระทบ)
- image MinIO เป็น fork ชุมชน `pgsty/minio` — ทบทวนใน T-010 (ADR-003)

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] ตั้ง `WT_MAIN_THREAD=1` และส่ง term list บน cloud session (หัวข้อด้านบน)
- [ ] ตอบ PRD §16 เท่าที่ตอบได้ (ไม่บล็อก Phase 0)
- [ ] ปิด Turbo telemetry บนเครื่องตัวเอง (`pnpm exec turbo telemetry disable`) ถ้ายังไม่ได้ทำ

## ขั้นต่อไป (เรียงลำดับ)
1. Checkout `wip/t-005` → รัน `pnpm test:integration` → ทำ T-005 ให้ครบ → ตรวจซ้ำ → merge เข้า `main` แบบไม่ force → ลบ branch เมื่อเจ้าของตกลง — `backend-dev`
2. T-006 three-pane จริง + หน้า login — `frontend-dev` · contract ของ auth ดู JSDoc ของ `AuthController` และ `packages/shared/src/auth.ts` · refresh ต้องทีละ tab เท่านั้น (ADR-005) · PWA manifest/service worker ยังไม่ทำ ต้องอยู่ในงานนี้
3. T-007 portal, T-008 seed — `backend-dev` + `frontend-dev`
4. T-009 e2e AC-1 + RBAC — `qa-engineer` · รวมขั้นตอน magic link ครบวงจรที่ T-004 ยังไม่ได้รันผ่าน `curl`
5. T-010 `security-reviewer` — ตรวจ ADR-005 แล้วเปลี่ยนเป็น Accepted, ตรวจ ADR-003
6. T-011 `po` — พิจารณา: ย้ายงาน deploy GCP มาก่อน T-115 (pilot ต้องมีข้อมูลจริงและ webhook สาธารณะ) · การรองรับ OIDC ทั่วไปสำหรับองค์กรที่ไม่ใช้ Google
7. T-012 `/handoff`, `CHANGELOG.md` 0.0.1, tag `v0.0.1`

## ยังไม่ยืนยัน (ห้ามเขียนเป็นข้อเท็จจริง)
- Flow กับ Google จริง ทดสอบกับ fake OIDC เท่านั้น `[UNVERIFIED 60%]` — ADR-005
- Permission matrix `[ASSUMED]` — PRD §2.2 · web/api same-site `[ASSUMED]` — ADR-005
- สี link/focus และ surface ที่ palette ไม่ได้กำหนด `[ASSUMED]` — `packages/ui/src/tokens/colors.ts`
- e2e และ boundary test ยังไม่เคยรันบน Linux/CI `[UNVERIFIED 80%]`
- สาเหตุที่ image ทางการของ MinIO ดึงไม่ได้ `[VERIFY]` — ADR-003
- `docs/brand/watchtower-logo.svg` เป็นแบบย่อของ PNG — UI ใช้ PNG
- LINE OA ราคา/โควตาแผนไทย `[VERIFY]` — PRD §4.2 R-2.10 · Mark-as-read API ของ LINE `[VERIFY]`
- Product DB ของ deployment อ้างอิง = Cloud SQL Postgres `[ASSUMED]` · GCP mapping `[ASSUMED]` — ADR-001

## วันตรวจซ้ำ
- LINE pricing/feature: ก่อน T-103
- Google managed MCP (BigQuery/Logging) availability: ก่อน T-203
