# T-448 — ทดลอง workflow และ quota recovery (2026-11-11)

## ปัญหาและสิ่งที่แก้
- [TESTED] P2/B-005: staff/portal ยังพิมพ์ระหว่าง POST pending ได้ แต่ success ล้าง draft ทำข้อความใหม่หาย; staff สลับ reply/note เพื่อส่งซ้อนด้วย uploads ชุดเดียวกันได้ ก่อนแก้ regression ใหม่ 4 fail / ของเดิม 38 pass
- [TESTED] ล็อก transaction ด้วย disabled fieldset, rich editor contenteditable=false/aria-disabled และ guards สำหรับ keyboard/imperative/template/handoff; portal disable textarea ส่งล้มเหลวเก็บ draftและปลดล็อก ส่งสำเร็จจึงล้าง
- [TESTED] เพิ่ม `pnpm e2e:local`: สร้าง disposable Postgres/Redis/Mailpit บน random loopback ports → build → browser → fullstack → cleanup เฉพาะ container ที่ ownership label ตรงกัน ไม่ใช้ POC URLs หรือ credentials

## ผลตรวจจริง
| Gate | ผล |
| --- | --- |
| Full unit + boundaries | 19/19 tasks, cache0, 14m46.112s; web156files/1811tests ผ่าน |
| Targeted / independent unit | 55/55 staff/portal/email-flow/email-guard; reviewerแยกรัน composer/portal42/42 ผ่าน |
| Quota continuation | mainและreviewer13/13 ผ่าน รวม threshold≤5%, unknown/stale/context, atomic checkpoint, fresh reset/resume, duplicate/live/deadclaims, RPC handshake |
| Browser (Edge) | 284passed /32existing skipped (3.4m), ไม่มีretry รวม delayed success/failure6/6 staff/Gmail/portal |
| Fullstack (Edge) | Playwrightรายงาน71passed/19skipped (5.0m): รวม known expected failure B-003 หนึ่งกรณี จึงเป็น70ordinarypasses +1knownfailure ไม่ใช่ Gmailauto-ackผ่าน |
| Build / lint / typecheck | build11/11(cache9–10), lint19/19(cache16), typecheck18/18(cache16) |
| Interruption smoke | Dockerจริง + controlled child launcher, injectSIGINTระหว่างbuild: exit1ตามคาด, descendantAlive=False, probecontainersถูกลบครบ/maintestcontainersยังอยู่ |

[TESTED] `pnpm e2e:local` exit0 และ cleanupครบ ไม่มีcontainer label watchtower.e2e.run เหลือ Fullstackครอบ portal submit→assign→reply→internalnoteisolation→resolve, Gmailingest/draft/approve/thread/dedup/merge, LINEadapter, alertdedup/escalation/ack, KB/investigation, shifts/handoff, auth/RBAC/incident

ผลละเอียด local (ignored): e2e-local-session.log, unit-session.log, lint-session.log, typecheck-session.log, interruption-session.log; probeอยู่ .cache/interrupt-probe/. ทำซ้ำ E2Eด้วย `pnpm e2e:local` เมื่อ Dockerและbrowserพร้อม

## Independent review N7
Reviewer /root/independent_review ไม่ผลิตimplementation พบและแก้ก่อนaccept: Windows pnpm.exe launcher, process-tree termination, quota duplicate-admission. Re-review sourceไม่มีP0/P1/P2ค้าง; quota13/13 + UI42/42 + scopedlint/formatผ่าน Mainเปิดsourceและรันทดสอบซ้ำเองตามผลข้างบน

## Account quota: pause/reset/resume จริง
- [TESTED] อ่าน `account/rateLimits/read` ผ่าน signed-in Codex app-server stdio ไม่อ่านauthfile/เรียกLLM ไม่ใช้contexttokencounts ไม่มีaccount/claimtokenในstdout
- [TESTED] 2026-11-11 01:19กรุงเทพ primaryเหลือ5%จริง → checkpointwaiting_limit/releaseclaim, nextEligible06:00:12. Heartbeats02:10/03:10/04:14/05:13เห็นquota≤5% จึงไม่เริ่มงานซ้ำ
- [TESTED] Heartbeat06:12ตรวจfreshquota primary100%/weekly85%, ผ่านresetgateและไม่มีrunnerเดิม จากนั้นsyncclaimใหม่ admitted=true/running (owner44408สำหรับfinalization) และทำงานต่อจากlogsเดิม ไม่รันfulltestsซ้ำ เป็นautomaticresumeจริงหลังreset ไม่ใช่แค่fixture
- ข้อมูลเกิน60วินาที/ขาด/ผิดรูปแบบ failclosed; applicablewindowใดremaining≤5%พัก; resumeต้องfreshread+resetgate+PID/claimtoken
- ข้อจำกัด: ตรวจที่safe boundary ไม่interruptmodelturnกลางทาง; app/เครื่องต้องเปิดและschedulerอาจปลุกช้าหากเริ่มturnไม่ได้ ไม่ซื้อcredit/เปลี่ยนบัญชี/เพิ่มdaemon ตัวownerfinalizationเป็นprocessถือclaimชั่วคราว ไม่มีpolling/LLM

## ขอบเขตและสิ่งที่ยังไม่ยืนยัน
- ไม่มีdeploy/ข้อความจริง/ทดสอบกับPOC; DockerengineคืนPOCcontainersเดิมอัตโนมัติเมื่อเปิด แต่ไม่ได้ใช้เป็นtestservices
- externalGmail/LINE/Discord/GCP/LLMใช้testadapters; พิสูจน์browser/web/API/worker/DB/Redis/Mailpitจริง ไม่ใช่externalproduction signoff
- B-003 Gmailauto-ackยังเป็นknownfailure; standardcommandไม่เปิดoptionalstage3flagONruns (19skips) ไม่เปลี่ยนmarkers/assertionsเพื่อให้เขียว
- ไม่ทดสอบpower-losscleanup; ไม่อ้างCIผ่านจนเห็นrunจริง ไม่มีmerge/deploy
