# HANDOFF — Watchtower

> อัปเดตล่าสุด 2026-11-11 11:55 (Asia/Bangkok) โดย Codex main · ก่อนdeploy: docs/handoff-archive/HANDOFF-2026-11-11-pre-t449-deploy.md

## สถานะปัจจุบัน
- [TESTED] T449 merge/deploy localเสร็จ: mainfb3e1a29, mainCI42948052133ผ่าน4jobs; POCwebใหม่healthy9containers ผู้ใช้เปิดhttp://localhost:3000ได้
- งานปัจจุบัน T451: เจ้าของต้องการลดนกที่ซ้ำ/เล็ก ทำsummary-firstแล้วถามต่อในบริบทนั้น ไม่ใช่tinybirdbuttonsทุกsection
- Agentcontextual_aiกำลังimplement source/tests/i18n; mainดูdocs/ADR/merge/deploy เท่านั้น อย่าNextbuildชนagent
- Partialก่อนresume4ไฟล์ AskAiButton/AskAiElement/TH/EN เพิ่มfollow-up presentationและneutralmessageicon; unit54/54ผ่าน(contextual-ai-batch1.log) ยังไม่ใช่featureเสร็จ
- ส่วนที่ต้องทำ: ElementInsight.followUp/footer+fallbackจริง/callersคงscopeperiodpermissions/AiBrieffollowup+mascotidentity32–40px/ลดdecorations/tests+screenshots+review แล้วmerge/deploylocalเมื่อgatesผ่าน

## กติกา/การอนุมัติ
- เจ้าของอนุมัติmerge mainและdeploylocalแล้ว2026-11-11; T451เป็นการปรับUIต่อเนื่องในแอปที่deploy ไม่ต้องส่งข้อความจริงเพื่อทดสอบ
- ห้ามเปิดAI_AUTOSEND_ENABLED/INSIGHT_PERSON_NARRATION_ENABLED/EMBEDDING_PROVIDER=local หรือเปลี่ยนCodexprovider/credentialsเอง
- .agents/.codexเป็นของเจ้าของ ห้ามadd/commit; Dockerbuildใช้clean gitarchive เพื่อไม่ส่งowner/localcacheเข้าcontext
- ADR029ท้ายไฟล์amendpresentationตามเจ้าของแล้ว คง30-elementcapability/RBAC/citations/state/budgets/read-only ไม่เพิ่มmodelcallsหรือauto-send

## Deployปัจจุบัน (T449)
- Webimage sha256:7c11a23d9dbc26a9218105966c3fcb7c36479f0f3fea68280d7fa3e0e8f30cff, BUILD_ID VHR-QKl9sBCLUBQ4DW0Op, aliaswatchtower/web:git-fb3e1a29
- Exactimagereplica6/6composerpendingtestsผ่าน+independentpostreviewPASS; web/API/worker/proxyhealth200; APIworkerIDs/config/flagsเดิม ไม่migrateDB
- Backupverifiedpg_dumpcustom+pg_restore-l: D:/Works/watchtower-backups/watchtower-20261111-024454-pre-t449-deploy.dump (13862043bytes/243tabledata); rollbackimagewatchtower/web:rollback-t449
- Hostbridgeofflineตั้งแต่ก่อนdeploy เปิดrunnerเดิมCodex+pinnedoverlayกลับPID5228 host/API/workerhealth200/online ไม่มีgenerationtest
- รายงาน docs/qa/2026-11-11-local-deploy.md; T450follow-updockerignoreยังค้าง การใช้archiveป้องกันเฉพาะรอบนี้

## Quota/continuation
- [TESTED] 11:53freshprimary100%/weekly69% ไม่มีrunnerเก่า; checkpointT449เดิมownerหมดอายุ→completeแล้วnewT451runningowner45548 (finiteclaimowner1h ไม่ใช่scheduler/LLMdaemon)
- Heartbeatwatchtower-quota-checkpointACTIVEทุกชั่วโมงสำหรับT451จนเสร็จ อ่านfreshquotaทุกsafe boundary; ≤5%/unknownsave+pause; agentหยุดที่≤10%เพื่อreserveให้main
- CheckpointGitcommoninfoใช้ร่วมworktrees ห้ามreclaimliveowner/printclaimtoken; actualguardไม่interruptmodelturnกลางทาง
- ก่อนทำซ้ำตรวจlogs/process ผลunit54และmainCIเดิมจบแล้ว ไม่รันซ้ำโดยไม่มีchange

## ขั้นต่อไป
1. ปิดdocsT449/commitเฉพาะdocsและfastforwardmain โดยห้ามเอาpartialT451sourceเข้าmain
2. รับT451implementation ตรวจsource/testเอง+reviewคนละagent+visualQA จากนั้นcommit/push/CI/cleanarchivebuild/deploylocalตามscope
3. T451เสร็จแล้วcompletecheckpoint/releaseowner/ลบheartbeat

## รอเจ้าของ/ข้อจำกัดเดิม
- T433localembeddings/C27personnarration/C25retention/pilotT412ยังรอowner; B003Gmailautoackknownfailureเดิม
- Externalจริง/optionalstage3ONrunsไม่ใช่ผลทดสอบงานUIนี้
