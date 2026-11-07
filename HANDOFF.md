# HANDOFF — Watchtower

> อัปเดต 2026-11-07 18:04 Bangkok โดย Codex · เจ้าของสั่ง save งาน ส่งต่อ Claude และถอด schedule แล้ว
> ฉบับก่อน: docs/handoff-archive/HANDOFF-2026-11-07-pre-claude-handoff.md

## สถานะปัจจุบัน
- Branch **codex/t445-authorization-gates**; mainล่าสุด a6b3c22c (ปิด T407). Branchนี้มี T445a/c และ migration0117 ยังไม่ merge main และยังไม่ deploy.
- **Automation watchtower-checkpoint ถูกลบจากแอปแล้ว** ตามคำสั่งเจ้าของ 2026-11-07. ห้ามสร้างใหม่เอง. เจ้าของจะให้ Claude รับงานต่อ.
- Phase1 done pending pilot / Phase2 done pending live / Phase3 done pending live gate. งานassistant/Phase4ที่ค้างให้ดู BACKLOG ล่าสุด. LINE ภายหลัง.
- **[TESTED] POCกู้กลับแล้ว:** startเฉพาะ9containersเดิม ไม่recreate/config/migrate; ทั้ง9healthy. Login3000/APIready4000/hostbridge4317HTTP200. autosend=false. ไม่มีdeployโค้ดT445ในรอบนี้.
- Hostbridge PID35492 เปิดด้วย tools/ai-bridge/start-host.ps1, envนอกrepoและoverlay logs/ai-bridge/pinned-runtime.env, CLI pin0.166.0-alpha.5.1. อย่าสลับกลับClaude providerโดยไม่จำเป็น: เจ้าของให้Claudeทำงานพัฒนา ไม่ได้สั่งเปลี่ยนruntimeAIprovider.
- testcontainersทั้งหมดหยุดแล้ว; รอบนี้ใช้เฉพาะwt-main-pg/wt-main-redisและstopหลังtests ไม่ลบvolume. embedder/oldclaudebridgeยังหยุด.
- Codex weekly95% (5h13%): checkpoint waiting_limitจนweeklyreset10พ.ย.11:43:24Bangkok. เป็นquotaของCodex ไม่ใช่เหตุห้ามClaudeทำงานต่อ. ไม่มีagents/localtestsค้าง.

## อำนาจและกฎที่ต้องรักษา
- เจ้าของอนุมัติทำงานค้างให้ครบ ให้POตัดสินscope/default, review/test, pushGit, deployDockerหลังbackup, stoptestcontainersโดยไม่ลบvolume. ไม่ต้องถามอนุมัติเดิมซ้ำ.
- LINEภายหลัง. **ห้ามเปิด AI_AUTOSEND_ENABLED** บนPOC/prod;ห้ามส่งข้อความลูกค้าจริงเพื่อทดสอบ.
- ห้ามอ่าน/พิมพ์secrets; env D:/Works/secret/watchtower.env ให้runnerโหลดเอง. อนุญาตอ่านเฉพาะมี/ไม่มี/ความยาว ไม่ใช่ค่า.
- N7ผู้ตรวจคนละagentกับผู้ผลิต, mainเปิดไฟล์+รันtestเองก่อนcommit. ห้ามagentแก้golden/rubricตรวจตัวเอง. No forcepush/no-verify. .agents/.codexเป็นdirectoryของเจ้าของอย่าcommit.
- ข้อมูลลูกค้าอนุมัติclaude-pอัตโนมัติ;redactpassportตามdecisionเดิม, แต่อย่าคลายpolicy/auditนอกADR. ภาษาTH/ENตามglossaryก่อนเจ้าของตรวจตอนเสร็จ.

## ทำเสร็จและหลักฐาน
- **T407ปิดบนmain a6b3c22c:** route32/32; mainbrowser10specs161/161 + lint/format/webtypeผ่าน. a/b SSE/Stop/queue/history/pins/feedback/C22ก่อนหน้าตรวจแล้วและwebdeployb7671097. เป็นmockUIgate ไม่ใช่livepilot/securityapproval.
- **T445a/c source92aef072:** durable serverauthorizationfingerprint+source refs/tools, reauthorize modelhistory/conversationpreview/memory; legacyfailclosed, tombstoneNoaccessTH/ENแต่Forget/Clear/countยังทำงาน. ป้องกันnestedROpoolstarvationด้วยinReadOnlyScope. Toolbudget60/hour/user/toolRedisรวมprefetch. T445b/dยังไม่ทำ.
- IndependentreviewปิดcodefindingsROpool,previewrevocationและNoaccessUI; reviewerไม่พบP1/P2ค้างในpatchที่ตรวจ. Runtimeacceptanceใหม่ยังมีด้านล่าง.
- **Migration0117 quote fix3e33ddc1:** quote reservedidentifier "authorization" ทั้งup/downและrawSELECTtest. CI42365786279 rootstatic/unit,e2e,composehealthผ่าน; integration domain510ผ่าน / DB528ผ่าน2ล้มเพราะtest0116สมมติตัวเองเป็นlatest. ไม่ใช่0117syntaxerrorแล้ว.
- **Patchท้ายรอบ:** packages/db/src/ai-cli-provider.integration.test.ts ใช้migrationsAfter+stepsจริงทั้ง2tests;คงunknownprovider23514/auditrollbackrefusal/count1. Reviewerตรวจแล้วไม่พบfinding. MainDBlint/type/formatผ่าน.
- **[TESTED] MainจริงหลังDockerเปิด:** DBfocused2files **16/16ผ่าน** รวม0116rollbackและ0117nullable/reversibility; logs/deploy/2026-11-07-t445-db-focused.log exit0. APIfocused2files **5/5ผ่าน** authorizationrevocation/crossuser/forgery/legacy/purge/cap+realRedis61stdeny/user-toolisolation; logs/deploy/2026-11-07-t445-api-focused.log exit0.
- Mainก่อนหน้าAPI35unit/web6unit/APIwebtype/scopedlintผ่าน. Fullbackendใหม่ยังต้องrunตามขั้นถัดไป.

## งานค้างและขั้นถัดไป
1. ตรวจGitbranch/HEAD/statusและCIล่าสุดหลังpushpatchท้ายรอบ; อย่าทำT407/T419b/T418a/T432ซ้ำ.
2. **T445a/c ยังไม่ติ๊ก:** รัน API assistant-memory.integration.test.ts (รวมpreviewauthorized→revoked/legacyและpin409fixture), assistant-foundation.integration.test.ts (realticket/KB4concurrentROpoolregression). จากนั้นfullintegration/rootstatic/unit/e2eตามDoD โดยmainตรวจเอง. อย่าอ้างfocused5testsครอบสองไฟล์นี้.
3. **T446ยังไม่implement:** workerfreshintentgate report window_start==window_end millisecond truncation→tableCHECKerror. ก่อนหน้าวินิจฉัยให้รองรับequalityเฉพาะinsufficient_dataในreversiblemigrationถัด0117,เลิกbackdate1s,คงห้ามreversed/greenwindowสั้น28วัน;ต้องreviewsecurity/rollbackที่มีequalrowsและdeterministicregression. ห้ามแก้แค่sleepหรือbackdatetestเพื่อซ่อนproductionbug.
4. เมื่อT445gatesผ่านค่อยmerge main, backupverifiedก่อนmigrate0117/deployAPIworkerweb, verifyHTTP+bridgepin+autosendfalseแล้วpush;stoptestcontainersหลังใช้. POCDBยัง0116.
5. ต่อT445b C17PIIauditcatalogue(team_status/load/roster/notesรวมno-chip+auditfailwithhold), T445dเชื่อม<=10pinnedfactsเข้าuser_notesอย่างreauthorize/redact/neutralizeและไม่ใช้oldplaceholdermapผิดคน. ปัจจุบันmemoryมีแค่CRUDยังไม่มีผลต่อprompt. แล้ว410/411/412 reviews.
6. คิวfeatureจากBACKLOG: T418writer→419a→420/421; T434a/b/cตามADR033ก่อนT433localembedderenable. bge-m3เคยdownload/calibratefloor.55 recall100/noise6บนpublicexamples;runtimeยังmockและembedderหยุด อย่าเปิดก่อนhybridindexgates.

## วิธีรันทดสอบโดยไม่แตะPOC
- TEST_DATABASE_URL synthetic: postgres://watchtower:watchtower@127.0.0.1:45802/watchtower (wt-main-pg)
- TEST_REDIS_URL redis://127.0.0.1:46802 (wt-main-redis)
- TEST_S3_ENDPOINT http://127.0.0.1:49802 (wt-main-minio), TEST_SMTP_PORT41802 (wt-main-mailpit;HTTP48802)
- API/workerintegrationguardต้องมีTEST_*ครบ4ตัวแม้บางtestใช้แค่PG/Redis. ห้ามdefaultPOC5432/6379/9000/1025. Startเฉพาะtestcontainersที่จำเป็น. ดูdocs/runbooks/local-poc.mdและtools/e2e-stack.
- ตัวอย่าง: pnpm --filter @watchtower/api exec vitest run --config vitest.integration.config.ts src/assistant/assistant-memory.integration.test.ts src/assistant/assistant-foundation.integration.test.ts (ตั้งTEST_*ก่อน)
- POCbackupล่าสุด D:/Works/watchtower-backups/poc-20261106-163914-pre-t407b.dump13,758,801bytes. ต้องbackupใหม่ก่อนdeployรอบใหม่.

## รอเจ้าของ/ก่อนpilot
- Pilotใช้instanceใหม่;VAPIDenv,Weeklybriefrecipientdomains,Googleจริงstepup,graderคนละmodelจากdrafter,สิทธิ์ownerapprove,rotatepubsubkey90วัน ยังต้องตรวจตามSTATUS/runbook. ไม่มีcredentialใหม่ให้เดาหรือยืมkey.
- รายละเอียดADR/PRD/decisionsเดิมดูdocs/decisions/README.md,STATUS,BACKLOG; archiveเป็นประวัติไม่ใช่สถานะruntimeปัจจุบัน.
