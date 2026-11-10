# HANDOFF — Watchtower

> อัปเดตล่าสุด 2026-11-11 06:29 (Asia/Bangkok) — Codex main; ฉบับก่อน: docs/handoff-archive/HANDOFF-2026-11-11-pre-workflow-recovery.md

## สถานะปัจจุบัน
- T-448 เสร็จ: แก้ composer pending, เพิ่ม E2E แยกบริการ และ account quota checkpoint/resume; branch codex/workflow-recovery ไม่ merge/deploy
- [TESTED] Source CI 0db32624 / run42921797797 เขียวครบ4jobs: lint/typecheck/unit, integration, browser/fullstack E2E, Docker Compose build/up/health. ผลCIนี้ยืนยันsourcecommitดังกล่าว; commitเอกสารสรุปภายหลังไม่ได้เปลี่ยนโค้ด
- [TESTED] Local fullunit19/19tasks cache0 (web1811tests), build11/lint19/typecheck18ผ่านตามcacheในQAreport; browser284pass32skip, fullstack70ordinarypass+1expectedfailureB003+19skip
- [TESTED] Independent review ไม่มีP0/P1/P2ค้าง, targetedunit55/55, reviewer42/42, quota13/13; SIGINTprocess-tree/ownedcontainercleanupผ่าน
- ผลทดสอบและข้อจำกัด: docs/qa/2026-11-11-workflow-recovery.md; phase1–3ยังdone pending pilot/livegateตามฉบับก่อน ไม่ถือผลนี้เป็นproduction signoff

## การตัดสินใจของเจ้าของที่มีผลอยู่
- ห้ามเปิด AI_AUTOSEND_ENABLED, INSIGHT_PERSON_NARRATION_ENABLED หรือ EMBEDDING_PROVIDER=local บนPOC; ห้ามเปลี่ยนHostAIBridgecodex:4317/ใช้credentialใหม่เอง
- .agents/ และ .codex/ เป็นของเจ้าของ ห้ามgitadd/commit
- งานนี้ไม่มีdeploy/merge/ข้อความจริง ไม่ใช้POCเป็นtestservices; disposablecontainerscleanupครบ
- accountquota≤5%พักพร้อมcheckpoint; resumeต้องfreshquota>5%+resetgate ไม่ใช้contextwindowเป็นaccountquota

## ทำเสร็จ
| งาน | ผล / ไฟล์ |
| --- | --- |
| Composerpending | ล็อกeditor/mode/recipients/subject/attachments/shortcuts; failureคงdraft — apps/web/src/components/conversation/, portal/reply-form.tsx, e2e/composer-pending.e2e.ts |
| E2Elocal | pnpm e2e:local สร้างdisposableinfra/build/browser/fullstack/cleanup — tools/e2e-stack/local.mjs |
| Quotaguard | freshaccountRPC/threshold/unknownfailclosed/PIDtokenclaim — tools/codex-continuation/quota*.mjs |
| Actualpause/resume | 01:19primary5%พักจริง;06:12heartbeatfresh100%/weekly85%→claimใหม่และทำต่อจากlogsเดิม ไม่รันซ้ำ |

## ค้าง / ขั้นต่อไป
- ไม่มีงานโค้ดT448ค้าง SourcepushและCIผ่านแล้ว; หลังpushเอกสารสรุปให้completecheckpoint/releaseowner44408และลบheartbeatwatchtower-quota-checkpoint เพราะงานที่อนุมัติครบแล้ว
- Localignoredlogs: unit-session.log, e2e-local-session.log, lint-session.log, typecheck-session.log, interruption-session.log, ci-watch-session.log
- งานใหม่ใช้runbook docs/runbooks/codex-continuation.md; ตรวจGitcommoninfo checkpointก่อนclaim ห้ามพิมพ์claimtokenหรือreclaimliveowner
- T407checkpointเก่าที่docsปิดแล้วเก็บsnapshot .T-407-20261111.archiveก่อนcomplete/สร้างT448 ไม่ทับงานactive

## รอเจ้าของ / ยังไม่ยืนยัน
- T433localembeddings/C27personnarrationยังรออนุมัติ; T412/C25/pilotรอretentiondecisionและผลใช้งานจริง2สัปดาห์
- B003Gmailautoackknownfailureเดิมยังไม่ปิด externalจริง/optionalstage3ONrunsไม่อยู่ในผลนี้
- guardไม่หยุดกลางmodelturn; เครื่อง/appต้องเปิด schedulerอาจปลุกช้า ไม่รับประกันเวลาwake/power-losscleanup

## วันตรวจซ้ำ
- Pilotreadiness2026-11-16; key/retentionreview2027-02-01ตามรอบเดิม
