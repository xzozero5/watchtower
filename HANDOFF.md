# HANDOFF — Watchtower

> สถานะล่าสุดของโปรเจกต์ session ใหม่อ่านไฟล์นี้ต่อจาก `AGENTS.md` แล้วทำงานต่อได้โดยไม่ต้องอ่านบทสนทนาเดิม
> อัปเดตล่าสุด: 2026-11-06 07:25 (เวลากรุงเทพ) โดย Codex — deploy/push T-419b และ T-418a
> ฉบับก่อน: `docs/handoff-archive/HANDOFF-2026-11-05-pre-ai-bridge.md` · บันทึกรายชั่วโมง `logs/daily/2026-11-05.md`

> ✅ **push แล้ว 2026-11-05** (`origin/main` = `e325c83`, CI run 41963960467 เขียวทั้ง 4 job) · ✅ **POC deploy แล้ว 2026-11-05 11:10** (เจ้าของ OK): backup `D:\Works\watchtower-backups\poc-20261105-1105-pre-phase3.dump` (13.5 MB) → build api/worker/web/bridge/gmail-tunnel → migrate 22 ตัวถึง 0111 → ทุก service healthy · `AI_AUTOSEND_ENABLED` ไม่ได้ตั้ง
> ✅ **AI เปลี่ยนเป็น Codex แล้ว 2026-11-05 23:53** — `AI_PROVIDER=ai-cli`, `AI_BRIDGE_MODE=codex`, host bridge `http://host.docker.internal:4317` (PID ตรวจที่ logs/ai-bridge/host.pid) · non-secret overrides ถูก append ลง env เดิมแล้ว มี local overlay logs/ai-bridge/pinned-runtime.env ชี้ CODEX_CLI_BIN แบบ pin · API/worker image ใหม่ healthy; DB ถึง 0116; web/Gmail tunnel เดิมไม่แตะ · backup `D:\Works\watchtower-backups\poc-20261105-ai-bridge-pre-0116.dump` (13,731,374 bytes) · old Claude container หยุดไว้ rollback ได้

> ✅ **2026-11-06 05:26:** push `635914d` แล้ว (รวม82commitเดิม); CI42121519210cancelledเพราะpushเอกสารใหม่; CI42121588809ของ31abb66ล้มops test2ตัว → T-438แก้แล้ว รอดูCIใหม่. POC api/worker/web redeploy00:21 healthy, bridgeจากapihealth200หลังpinCLI. T-437 completed; checkpoint task T-419 ready หมายถึง T-419b ที่ POเลือก (schema taskIdรับเลขเท่านั้น). งานassistantยังต้องทำต่อ

## Continuation (อ่านก่อนเริ่มรอบใหม่)
- **07:25:** push ถึง `8851e47` แล้ว; CI `42136356817` กำลังรัน. T-419b/T-418a/T-432 ตรวจอิสระและ commit แล้ว; T-419a/T-418 writer ยังไม่เสร็จ. Docker api/worker/web build+deploy หลัง backup `D:/Works/watchtower-backups/poc-20261106-pre-419b.dump`; login/ready/bridge HTTP200 ทั้งสาม. Autosend ปิดตามเดิม.
- **ผลตรวจ:** static29/29 tasksผ่าน; web targeted68 + freeze54ผ่าน; browser e2e15/15ผ่าน. Full frozen unit ยังรันที่ `logs/deploy/2026-11-06-frozen-unit.log` (exec94789); ตรวจ process/log ก่อนรันซ้ำ. รอบเก่า serial-unit มี3 availability tests failขณะworkerแก้ไฟล์ ไม่นับว่าผ่าน. CIใหม่ใช้ package concurrency1/maxWorkers2 คงทุกcase.
- **ถัดไป:** เก็บผล full frozen unit/CI แล้ว T-409 → T-407 → T-418 → T-419a ตาม PO; ตรวจ quota และ checkpoint ก่อนเริ่ม. ทำต่อใน turn เดียวเมื่อยังมีโควตา; heartbeatไว้กู้หลัง limit/interruption ไม่ใช่เหตุให้หยุดหลังงานย่อย. ไม่ชน active runner.
- เจ้าของอนุมัติ 2026-11-06: ทำงานต่อให้ครบ, deploy Docker, push Git, stop container ทิ้ง; มอบ PO ตัดสินใจ scope/default ขณะเข้านอน. คง LINE ภายหลังและ autosend ปิด
- Automation `watchtower-checkpoint` เรียกแชตนี้ทุกชั่วโมง; runbook `docs/runbooks/codex-continuation.md`, ADR-032. `node tools/codex-continuation/cli.mjs status` อ่าน checkpoint ใน Git info. ตรวจ usage ก่อนงาน; window ที่ยังใช้ได้ให้ reset gate เป็น now ไม่ใช่วัน reset รอบถัดไป
- [TESTED] quota 5h หมดก่อน 04:30 แล้ว heartbeat นี้กลับมาทำต่อ 05:21 โดยไม่ต้องเจ้าของส่ง continue; weekly เหลือ 68%. ไม่รับประกัน exact wake time
- [TESTED] POC rebuild/deploy api/worker/web สำเร็จ 00:21; backup `D:/Works/watchtower-backups/poc-20261106-pre-continuation.dump` 13,746,979 bytes. migrate ไม่มี pending; 0116. หยุด test container 12 ตัว wt-a6/wt-a7/wt-main โดยไม่ลบ volume
- Jarvis/insights ชุดใหม่ยังไม่ครบ: T-407/409/410/411/412/418/419a/419b/420/421. Phase 3 เก่าปิดแล้วไม่ได้แปลว่างานใหม่ครบ
- PO เลือกงานถัดไป **T-419b** (dep T-406 ปิด): ปุ่มถาม AI+element chip+disabled reason; acceptance mock/context/scope + independent review. จากนั้น T-409→T-407 และ T-418→T-419a; wave 420/narration รายคนต้องผ่าน privacy/eval ก่อน
- T-432 ต้องตรวจซ้ำ T-435 ก่อน Accepted, T-433/434 ค้าง. ไม่มี agent จากก่อน quota reset ที่ยังทำงาน: ต้องตรวจ process ก่อนทุก claim

## สถานะปัจจุบัน
- **Phase:** 1 = done pending pilot · 2 = done pending live (GCP/Discord จริง) · 3 = ✅ done pending live gate (งานค้างของ PO T-306c ปิดครบ, ADR-025/026 Accepted) · LINE = feature ภายหลัง · Phase 4: ดึง T-152 (ลิงก์ "คำขอของฉัน" ทางอีเมล) + Web Push live มาทำแล้ว
- **Build/Test บน local main `[TESTED]` (main thread รันเอง):** typecheck 18/18, lint 19/19, unit ทั้ง repo ผ่าน (web 1655, ui 809, shared 1130, ai 819, api 462, worker 193, domain 228, db 86, channels 592, connectors 146, eval-runner 25) · integration บน container ทิ้ง (หลัง merge ทุกอย่าง): db 511/511, domain 509/509, api 1394/1394, worker 364/364 · e2e: web 224 ผ่าน/32 skip (main thread รันเองหลังแก้ test ล้าสมัย 6 ตัว), full-stack 75 ผ่าน/0 ตก, stage 3 flag ON (stack ทิ้ง) 13 ผ่าน/0 ตก
- **T-436 gate [TESTED]:** typecheck 18/18, lint 19/19 (warning useEffect เดิม 1), unit ทุก package + boundary ผ่านแบบแบ่งรัน (nonweb17/17 tasks + web150files/1674tests ด้วย threads/maxWorkers2) · AI998, bridge29+legacy1, migration integration2 main รันบน DBทิ้ง · independent security review ไม่มี P0/P1/P2 ค้าง · exact Windows/Linux Codex mock capture `tools=[]`; live pong3tiers + API runtime/audit + classifierข้อความไทยผ่าน · Docker login volumeใหม่ writable uid1000
- **Migration ล่าสุด:** 0116 (`ai_cli_provider`) · POC migrate 0112–0116 ใน session นี้หลัง backup; ไม่มีเลข 0100 (ข้ามเลข ไม่กระทบ migrator)
- **Deployment:** POC local compose `watchtower`: API/worker rebuild 2026-11-05 รอบ AI bridge; bridge เป็น host process เปิดค้าง · pilot = instance ใหม่ตาม `docs/runbooks/pilot-instance.md` (เจ้าของ deploy เอง)
- **Flag:** `AI_AUTOSEND_ENABLED` **ห้ามตั้ง** บน POC/production จนเจ้าของสั่ง (ADR-025) · ตั้งได้เฉพาะ stack ทิ้งของ e2e (`E2E_AUTOSEND_FLAG=on`)
- **Credential ที่มี (ชื่อเท่านั้น):** env ของเจ้าของ `D:\Works\secret\watchtower.env` (ห้ามเปิดอ่าน/พิมพ์ค่า; runner โหลดเอง) · Gmail push SA `watchtower-pubsub-admin` · Codex login เดิมบน host (ไม่คัดลอก auth); Claude subscription หมดอายุ
- **AI config ปัจจุบัน:** deep `gpt-6-astra`, standard `gpt-6.1-sol`, light `gpt-6-luna`, grader standard (ต่างจาก drafter deep); ราคา subscription 0 ไม่ใช่ bill จริง · CLI pin `0.166.0-alpha.5.1` · ดู `docs/runbooks/ai-bridge.md`
- **เงิน:** synthetic Codex live smoke รวม input 31,424 / output 20 tokens (4 calls รวม API audit); subscription ไม่รายงานยอดเงินจริง · build agent ไม่มี meter รวม

## การตัดสินใจของเจ้าของที่มีผลอยู่ (`[CONFIRMED]`)
- 2026-11-05: เปลี่ยน Claude bridge เป็น AI bridge เลือก Claude/Codex และใช้ Codex ตอนนี้เพราะ Claude subscription หมดอายุ — ADR-031 แทนการเลือก Claude เป็นหลักของ ADR-019; redaction/audit/budget/policy คงเดิมและ autosend ปิด
- 2026-11-04: ใช้ `claude -p` อัตโนมัติกับข้อมูลลูกค้าได้ · ADR-021 ยอม claude-cli นอก loopback เมื่อ `CLAUDE_CLI_ALLOW_REMOTE=true` · ADR-023 residual (ชื่อลูกค้าที่พิมพ์ใน assistant ถึง model ตอน plan) = Accept · redact เฉพาะเลข passport (ที่เหลือเปิด) · ข้อความไทยตาม glossary ไปก่อน เจ้าของตรวจตอนจบ
- 2026-11-04: เกณฑ์ปิด phase (ด้านบน) · pilot = instance ใหม่ · PDF export (ADR-028) + NER local (ADR-027) ทำใน Phase 3 · LINE เลื่อน
- ADR-025 (stage 3): approver คนเดียวกันได้แต่ตรวจเพิ่ม (step-up + confirmKey) · grader = คนละ model vendor เดียวกันพอ · rollback: violation ทันที, อื่น ๆ ≥ 2 ใน 20 · footer AI เปิดเป็นค่าเริ่มต้น
- golden: Accept + hook เข้ม (`evals/GOLDEN-REVIEW.md` ต้องแก้คู่กัน, guard บล็อก shell ที่แตะ `evals/golden`) · B-007 zip ใหญ่: ปฏิเสธตอน upload · weekly brief: ใน app ได้ อีเมลไม่ · T-152 + Web Push live: ทำได้เลย
- T-436 เจ้าของสั่งสลับ POC แล้ว; **ยังไม่ push** เพราะก่อน session มี 80 commits เดิมบน main ที่ยังไม่ขึ้น origin และสถานะเดิมรอเจ้าของอนุมัติ push. Commit งานนี้ในเครื่องก่อน; ห้ามส่งทั้งชุดโดยเงียบ ๆ · deploy อื่นนอก scope ยังรอ OK ของเจ้าของ

## ทำเสร็จรอบนี้ (2026-11-04 → 05) — รายละเอียด `docs/STATUS.md` entry 2026-11-05 07:30
| งาน | ผล |
| --- | --- |
| Phase 1/2 ค้าง | T-114a, T-125a, T-155a, T-171a, T-173…T-183, T-207a ฯลฯ ปิด (ดู BACKLOG) |
| Phase 3 | T-301a–f, T-302a–c,e,g, T-303a–f, T-304a–g, T-305a–f, T-306a,b,e–j (grader, eval/replay/golden, procedures + simulation, stage 3 gate + shadow + rollback + report, CEO view, weekly brief, PDF, roster planner, NER) |
| Security | T-306a (1 P1 → แก้), T-306j ตรวจซ้ำ: ไม่มี P0/P1, T-306k แก้ C-15 P2 + C-16…C-19, C-11, C-2 · T-306l บั๊ก session refresh ใช้นาฬิกา host (แก้) · T-301f verified ไม่นับคำปฏิเสธ |
| QA | T-306b e2e full-stack stage 3 (flag OFF shadow, flag ON fake-live ส่งจริง + ระงับ 6 เหตุผล, rollback ×2, eval gate + step-up) · บั๊ก B-009/B-010/B-011 แก้แล้ว |
| Test isolation | integration config ปฏิเสธรันนอก CI ถ้าไม่ตั้ง `TEST_*` (เคยรั่วเข้า POC — ล้างแล้วด้วยอนุญาตเจ้าของ) |

## ค้าง / ติดอะไร
- **Host bridge หลัง reboot:** ต้องเริ่มใหม่ด้วย `tools/ai-bridge/start-host.ps1 -EnvFile D:/Works/secret/watchtower.env -OverlayFile logs/ai-bridge/pinned-runtime.env -Mode codex -BindAddress 0.0.0.0`; มี log เฉพาะ metadata ที่ `logs/ai-bridge/`, PID ใน `host.pid`; ไม่ได้ติดตั้ง Windows startup task
- Codex container mode ต้อง login instance แยก + model catalog cache ก่อนใช้; ยังไม่ทดสอบ container subscription login จริง (ทดสอบ tools=[] ด้วย dummy auth แล้ว)
- **Residual P3 ยอมรับไว้ก่อน (main thread):** C-4 replay ผูก alias + เชื่อตัวเลขผู้เรียก, C-6 app role ทำ gate report เขียวผ่าน DEFINER ได้, C-9 app role INSERT `ai_run` ปลอม grade ได้, C-14 web ไม่แสดง reviewers, C-16 ไม่มี DB trigger (app role เขียน `custom_fields` ตรงได้), `issue()` ของ session ตั้ง expires_at ด้วยนาฬิกา host — เหตุผล: flag ปิด + ต้องมี L0 (env) + L3 (owner approve) ก่อนส่งจริง · ทบทวนก่อนเปิด flag
- T-302d: replay อัตโนมัติเมื่อเปลี่ยน prompt/model/procedure ยังสั่งมือ (`eval-runner record`)
- T-305: CEO §9.2 ข้อ 2,3,5,6, ตั้งเวลา weekly brief ใน admin, e2e/axe หน้า cost ยังไม่ทำ (PO T-306c)
- T-207 (Phase 2 QA/po review + handoff) ยังไม่ติ๊กใน BACKLOG ทั้งที่เกณฑ์ปิดถือว่าผ่าน — ให้ po ยืนยันแล้วติ๊ก
- container `wt-main-*`, `wt-a6-*`, `wt-a7-*` หยุดแล้ว 2026-11-06 (12 ตัว) ไม่ลบ volume
- [TESTED] global Codex อัปเดตเป็น alpha.6 ทำให้ bridge fail closed; ติดตั้ง CLI ที่อนุมัติ alpha.5.1 แยกที่ .cache/ai-bridge-cli และ overlay CODEX_CLI_BIN แล้ว healthz200 (ไม่เปลี่ยน CLI ของแอป). Runbook ai-bridge มีวิธีเปิด
- ไม่แก้/commit `.agents/` และ `.codex/`

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] เลือก intent แรกสำหรับ stage 3 เมื่อมีข้อมูลจริง — po เสนอ `feature_question`, `incident_inquiry`, `workspace_config` (ไม่แนะนำ `account_access`, `billing_report`, `result_dispute`)
- [ ] รับรอง: drafter stage 2 ใช้ `contact.verifiedAt` เดิม (เข้มน้อยกว่า gate stage 3 ที่ใช้ `requesterVerified`)
- [ ] อนุมัติ eval เคส 7 ข้อของ T-301f เข้า `evals/golden/` (ลูกค้าปฏิเสธ/ยืนยัน TH+EN)
- [ ] ก่อน pilot: VAPID `pnpm push:vapid --out D:\Works\secret\vapid.env` + ตั้ง `WEB_PUSH_*` · ตั้ง AI bridge/login ของ instance ใหม่ · `WEEKLY_BRIEF_RECIPIENT_DOMAINS` · grader model ต่างจาก drafter · ให้สิทธิ์ `ai.autonomy.owner_approve` ผ่าน CLI · ตั้งเตือน rotate key `watchtower-pubsub-admin` ทุก 90 วัน
- [ ] ทดสอบ step-up ด้วย Google จริง (Google ใส่ `auth_time` เมื่อส่ง `max_age` หรือไม่ — ถ้าไม่ approve ไม่ได้เลย, fail closed)
- [ ] ทดสอบ grader จริงต่อ prompt injection · ตัดสินดาวน์โหลด model NER ขั้น 2 · ตรวจข้อความภาษาไทย

## ขั้นต่อไป (เรียงลำดับ)
1. ทำ T-419b ตามขอบเขตที่ PO เลือก (ถ้าไม่มี active runner), แล้ว checkpoint/test/review; งานใหม่ Jarvis ยังเปิดตาม BACKLOG
2. หลัง pilot: T-302d replay อัตโนมัติ, T-305 ส่วนที่เหลือ, LINE

## ยังไม่ยืนยัน
- Codex JSONL ไม่รายงาน actual response model แยก; audit ใช้ requested model id (ชื่อที่ตั้งใน tier) ไม่ใช่หลักฐานว่า backend resolve alias เป็น model ใด · ต้องทบทวนก่อน stage 3; flag ยังคงปิด
- claude-cli คืน `response_model` จริงหรือไม่ (ถ้าไม่ independence เทียบ alias) `[UNVERIFIED 50%]`
- step-up กับ Google จริง `[UNVERIFIED 70%]` · C-17 เป็น open redirect จริงหรือไม่ `[UNVERIFIED 30%]`
- คำว่า "ยัง" ถูกนับเป็นลูกค้าปฏิเสธกว้างไป (ลด class เท่านั้น) · grader เห็นแค่ข้อความลูกค้าแรก+ล่าสุด `[ASSUMED]`
- T-306h: ticket ที่คนอื่นยื่นด้วยอีเมลลูกค้าก่อนลูกค้าคลิกลิงก์จะถูก verify ด้วย (คำตอบยังไปกล่องจริง) `[ASSUMED ยอมรับได้]`

## วิธีเปิดระบบและทดสอบต่อ
- `docs/runbooks/local-poc.md` §6 (integration ต้องชี้ service ทิ้ง — config ปฏิเสธถ้าไม่ตั้ง `TEST_*`) · `docs/07-TESTING.md` · `apps/web/e2e-fullstack/README.md`
- หลัง merge ที่เพิ่ม dependency workspace ให้ `pnpm install --offline` · ก่อน integration ให้ `pnpm turbo run build --filter=@watchtower/api^... --filter=@watchtower/worker^...`
- ห้ามพิมพ์ค่า env/credential · integration ต้องใช้ stack ทิ้ง ห้ามใช้ stack `watchtower` ของเจ้าของเป็น test DB; การสลับ POC ใน T-436 ได้รับคำสั่งเจ้าของแล้ว

## วันตรวจซ้ำ
- rotate key `watchtower-pubsub-admin`: 2027-02-01 (90 วันจากสร้าง 2026-11-03)
- ทบทวน residual P3 (C-4, C-6, C-9, C-14) ก่อนเปิด `AI_AUTOSEND_ENABLED` ที่ใด

[CONFIRMED] 07:26 quota5hใช้95% (weekly46%); checkpoint waiting_limit รอ reset 10:21:44 Bangkok. Heartbeatยังactive; full frozen unitยังรัน ให้ตรวจlog/processก่อนงานถัดไป ไม่เริ่มAIงานใหม่ระหว่างรอ.
