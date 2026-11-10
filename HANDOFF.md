# HANDOFF — Watchtower

> อัปเดตล่าสุด 2026-11-11 06:14 (Asia/Bangkok) — Codex main; ฉบับก่อน docs/handoff-archive/HANDOFF-2026-11-11-pre-workflow-recovery.md

## สถานะปัจจุบัน
- Phase1–3 done pending pilot/livegate ตามฉบับก่อน; T-448 localacceptanceผ่านแล้ว branch codex/workflow-recovery worktreecfe0 รอcommit/push/ตรวจCIก่อนcompletecheckpoint
- [TESTED] build11/11(cache9–10), lint19/19(cache16), typecheck18/18(cache16), fullunit19/19tasks(cache0,14m46.112s; web1811tests)
- [TESTED] Browser284pass32skip; fullstack70ordinarypass+1knownexpectedfailureB003+19skip; pending6/6, targetedunit55/55, independent42/42, quota13/13ผ่าน; SIGINTprocess-tree/ownedcontainercleanupผ่าน
- ไม่deploy/merge/ส่งข้อความจริง ไม่ใช้POCเป็นtestservices; disposablecontainerscleanupครบ รายงาน docs/qa/2026-11-11-workflow-recovery.md

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ห้ามเปิดAI_AUTOSEND_ENABLED, INSIGHT_PERSON_NARRATION_ENABLED หรือ EMBEDDING_PROVIDER=local บนPOC; ห้ามเปลี่ยนHostAIBridgecodex:4317/ใช้credentialใหม่เอง
- .agents/ และ .codex/ เป็นของเจ้าของ ห้ามgitadd/commit
- งานนี้ทดลองworkflow/แก้จากหลักฐานและE2E ไม่deploy/ส่งข้อความถึงบุคคลอื่น
- เมื่อaccountquota≤5%พักพร้อมcheckpoint; resumeต้องfreshquota>5%+resetgate ไม่ใช้contextwindowเป็นaccountquota

## ทำเสร็จในsessionนี้
| งาน | ผล | ไฟล์ |
| --- | --- | --- |
| Composerpending | ล็อกeditor/mode/recipients/subject/attachments/shortcuts; failureคงdraft | apps/web/src/components/conversation/, portal/reply-form.tsx, e2e/composer-pending.e2e.ts |
| E2Elocal | คำสั่งเดียวisolatedinfra/build/browser/fullstack/cleanup | tools/e2e-stack/local.mjs, package.json |
| Quotaguard | freshaccountRPC/threshold/unknownfailclosed/PIDtokenclaim | tools/codex-continuation/quota*.mjs, continuation.node-test.mjs |
| Actualpause/resume | 01:19primary5%พักจริง;06:12heartbeatfresh100%/weekly85%→admittedrunningใหม่ ไม่ทำงานซ้ำ | ADR032, runbook, QAreport |

## ค้าง / ติดอะไร
- Finaldocs/commit/pushbranch/ดูCI sourcecommit; ห้ามอ้างCIgreenก่อนเห็นจริง ไม่merge/deploy
- Independentreviewไม่มีP0/P1/P2ค้าง Mainตรวจไฟล์/รันfullgatesแล้ว ไม่ต้องรันfullsuiteซ้ำหากไม่มีcodechange
- Localignoredlogs: unit-session.log, e2e-local-session.log, lint-session.log, typecheck-session.log, interruption-session.log

## Quota / continuation
- Gitcommoninfo checkpointT448 running owner44408 (finitefinalizationclaimprocess ไม่มีpolling/LLM), tokenเฉพาะlocal ห้ามprint
- ใช้ quota-cli.mjs check ทุกsafeboundary; syncก่อนclaimต้องadmitted=true ถ้ามีliveownerต้องPID+WT_CONTINUATION_CLAIM_TOKENตรง ห้ามreclaimซ้ำ
- Heartbeatwatchtower-quota-checkpointACTIVEรายชั่วโมง แชต01a1c6a0-3f88-7fa3-b8e4-671094178bb0; เมื่องานcompleteให้completecheckpoint/releaseownerและลบheartbeat
- T407checkpointเก่าที่docsปิดแล้วเก็บsnapshot .T-407-20261111.archiveก่อนcomplete/สร้างT448 ไม่ทับงานactive
- guardไม่หยุดกลางturn; เครื่อง/appต้องเปิด schedulerอาจเริ่มช้า ไม่รับประกันเวลาwake

## รอเจ้าของ / ยังไม่ยืนยัน
- T433localembeddings/C27personnarrationยังรออนุมัติ; T412/C25/pilotรอretentiondecisionและผลใช้งานจริง2สัปดาห์
- B003Gmailautoackknownfailureเดิมยังไม่ปิด externalจริง/optionalstage3ONrunsไม่อยู่ในผลนี้

## ขั้นต่อไป
1. commit/push/ดูCI → updateSTATUS/QAผลจริง → completecheckpoint/ลบheartbeat
2. Pilot/localembeddingsเมื่อเจ้าของอนุมัติ

## วันตรวจซ้ำ
- Pilotreadiness2026-11-16; key/retentionreview2027-02-01ตามรอบเดิม
