# HANDOFF — Watchtower

> อัปเดตล่าสุด 2026-11-11 17:50 (Asia/Bangkok) โดย Codex main · ก่อนdeploy: docs/handoff-archive/HANDOFF-2026-11-11-pre-t449-deploy.md

## สถานะปัจจุบัน
- [TESTED] T451เสร็จและdeploylocalแล้ว: main runtime sourcecb506cf3; sourceCI43003199367และmainCI43005062353เขียวครบ4jobsทั้งคู่
- UIsummary-first: ถามต่อท้ายsummaryพร้อมcontextเดิม, ลดtinybirdซ้ำตามrow/loading/state/provenance, identitybrief32/panel40/bubble32px; bubbleเป็นXเมื่อเปิดpanelและไม่มีheroavatarซ้ำ
- [TESTED] Main255/255affectedunit, lint/typecheck/formatผ่าน, exactartifactbrowser8/8รวม2visualcapturesและaxe0lightdark; independentreview+postdeployPASS ไม่มีP0/P1/P2ค้าง
- Runtimewebimage120cdc8dc9fb1e60a90699010b3d4cc2daf757d51e23b1a5ca6fcec1d604154e /BUILD_IDD61Q1tYWpzMvbTWyyi-ET /OCIrevisioncb506cf308bdd9dbfcbdab78a9f2fd279077beda
- POC9healthy, web/API/worker/proxy/bridgehealth200, APIworkerIDs/imagesเดิม flags/providerเดิม; ไม่มีmigration/login/ข้อความจริง/LLMgenerationtest
- รายงานT451 docs/qa/2026-11-11-contextual-ai.md; รายงานmerge/deployรอบก่อนT449 docs/qa/2026-11-11-local-deploy.md

## Backup / rollback
- Freshverifiedbackupนอกrepo D:/Works/watchtower-backups/watchtower-20261111-103637-pre-t451-final-deploy.dump (13876511bytes/243tabledata pg_restore-lผ่าน; ไม่ได้ซ้อมrestoreรอบนี้/ไม่รวมMinIOattachments)
- Rollbackimagewatchtower/web:rollback-t451 คือเว็บก่อนT451; ปัจจุบันtaggit-cb506cf3และlocalตรงcandidateที่ทดสอบ
- ใช้clean gitarchivebuildcontextเสมอเพื่อกันowner/localcache T450dockerignoreถาวรยังเป็นbacklog; smokecontainerที่งานสร้างลบแล้ว

## กติกา/การอนุมัติที่ยังมีผล
- เจ้าของอนุมัติmerge/deploylocalและปรับUIsummary-firstแล้ว2026-11-11; ไม่ส่งข้อความจริงเพื่อทดสอบ
- ห้ามเปิดAI_AUTOSEND_ENABLED/INSIGHT_PERSON_NARRATION_ENABLED/EMBEDDING_PROVIDER=local หรือเปลี่ยนCodexprovider/credentialsเอง
- .agents/.codexเป็นของเจ้าของ ห้ามadd/commit/readเพื่อทำbuildcontext; sourcebundleใช้trackedarchiveเท่านั้น
- ADR029amendpresentationคง36non-Xregistrycapabilityตามinventoryจริง/RBAC/citations/states/budgets/read-only ไม่เพิ่มmodelcalls/auto-send

## Tests / pitfalls
- CIแรก36f07485ล้ม3unitfiles แก้exactaccessible-name selectors/reorderliteralpropsโดยไม่แตะinventoryrubric; พบactualfollowupremount/focusclicklost แก้stableframe+deferredregression fail-before/afterpass; currentcb506cf3CIgreenครบแล้ว ห้ามนำfirstcandidate1647...กลับมาใช้แทนfinalimage120...
- Localignoredlogs t451-main-final-unit.log,t451-main-lint-final.log,t451-main-typecheck-final.log,t451-fixed-image-browser.log,t451-fixed-ci-watch.log,t451-main-ci-watch.log
- ภาพfinal .cache/t451-image-final/{summary,assistant}-{1440,390}.png; before .cache/t451-before/; visualcapturesต้องตั้งUI_SHOTS ปกติCIskip2captures ไม่ใช่functionalpasses
- Known B003Gmailautoack expectedfailureเดิม/optionalstage3ONruns/externalจริงไม่อยู่ในผลUIนี้

## ค้าง / ขั้นต่อไป
- ไม่มีงานT449/T451ค้าง; sourcepush/main/deploy/CIครบ เอกสารสรุปfollow-upไม่เปลี่ยนruntimecodeและไม่อ้างCIของdocsheadว่าเขียวล่วงหน้า
- หลังpushเอกสารนี้completecheckpointT451/releaseowner31996และลบheartbeatwatchtower-quota-checkpoint เพราะงานที่เจ้าของอนุมัติครบแล้ว
- งานถัดไปที่ยังไม่อนุมัติ: T450Dockerignoreguard; T433localembeddings/C27personnarration/C25retention/pilotT412รอownerตามเดิม
- quota guard/runbookใช้ต่อได้ในงานใหม่ ทุกsafe boundaryfreshcheck≤5%/unknownsave+pause ไม่ใช้contextwindowเป็นaccountquota

## วันตรวจซ้ำ
- Pilotreadiness2026-11-16; key/retentionreview2027-02-01ตามรอบเดิม
