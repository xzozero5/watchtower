# T-451 — Summary-first contextual follow-up

เจ้าของ 2026-11-11: โลโก้นกกระจายหลายจุดและเล็กเกินไป ต้องการอ่าน AI summary แล้วถามต่อจากจุดนั้น

## สิ่งที่เปลี่ยน
- ย้าย contextual AskAiElement ที่อยู่แยกก่อน summary ไป footer ของ ElementInsight ผ่าน followUp composition; คงscope/period/entity/disabledreasonและfallbackจริงเมื่อไม่มีsummary
- ใช้ข้อความ 'ถามต่อ / Ask a follow-up' พร้อมneutralmessageicon; row actionsใช้neutraliconรองแทนมาสคอต ไม่เพิ่มข้อความยาวทุกrow
- ลด tiny bird ใน loading/state/provenance/quiet/queue/home และต่อticketcontextจากAiBrief รวมloading/error/none/phone/no-outbound
- เก็บmascotที่briefheader32px/assistantheader40px; bubble32pxและเป็นXเมื่อpanelเปิด ไม่มีemptyhero/avatarซ้ำ
- ไม่ส่งคำถาม/summary/PIIโดยอัตโนมัติ ไม่เพิ่มmodelcalls ไม่เปลี่ยนAPI/RBAC/budget/citations/read-only gates

## หลักฐานก่อน commit
- [TESTED] Main rerun196/196unit (5files, t451-main-unit.log); producer196/196เช่นกัน, build11/11(cache10), scopedlint/formatผ่าน
- [TESTED] Browser8/8: 4behavior +2visualcaptures +2existingaxe(light/dark0violations), retries0; productionstandalone/mockedAPI, ไม่ทดสอบกับPOCdata
- [TESTED] Independent /root/deploy_review sourcePASS: scope/RBAC/context/noauto-send/nomodeldiff; mainเปิดsourceและดูภาพafterdesktop/mobileเอง หลังbubbleX/hero cleanup
- ASTauditเดิมทุกbindingคงscope/period/disabledreason ยกเว้นticket.workspaceย้ายheader→AiBrief+conditionalfallbackตามintentionaldesign; ไม่มีAPI/worker/domain/AI/shareddiff
- [TESTED] Mainwholeweblintหลังfreeze exit0 (existingemail-bodyhookwarning1/0errors), typecheckexit0, fullsourcePrettierผ่าน; t451-main-lint-final.log/t451-main-typecheck-final.log/t451-main-format.log. รอบเก่าก่อนsyntaxcleanupล้ม7errors ไม่ซ่อนผล

## Failuresที่พบและแก้
- Browserรอบแรก4failเพราะaxe label-content-name-mismatch: visibleAskfollowupไม่อยู่ในaccessibleName แก้implementationaria-labelให้รวมvisiblecopy ไม่ลดaxeassertion
- รอบสอง2failเพราะnewtestคาดchipแค่Volume แต่UIถูกต้องเป็นVolume · instance · d7; แก้testให้ตรวจscope/periodครบ (strongerassertion)
- Newtestlintแก้non-nullassertionเป็นsafequery/explicitguardsและString(width) ไม่ลดbehaviorassertion; email-bodyexistinghookwarningอยู่นอกscope

## Visual evidence (local ignored)
- .cache/t451-before/{summary,assistant}-{1440,390}.png จากbaselineimagefb3e1a29
- .cache/t451-after/{summary,assistant}-{1440,390}.png จากcandidateproductionbuild พร้อมactualsummary/citation/contextchip
- Mainเห็นsummaryCTAอยู่หลังเนื้อหาและcitationชัด, mobile390ไม่มีhorizontaloverflowในภาพ, panelมีmascotidentityหลักเพียงจุดเดียว
- Logs: contextual-ai-browser-verified.log, contextual-ai-build-a11y.log, contextual-ai-unit-a11y.log, contextual-ai-lint-verified.log
- UI_SHOTSต้องตั้งเพื่อรัน2visualcapturecases; CIปกติจะskipสองcaptureนี้ ไม่ถือเป็นfunctionaltestผ่าน

## Quota / deploy status
- พัก12:07เมื่อfreshquotaถึง4%(finalguardอ่าน1%) เก็บwaiting_limitและreleaseowner; resume16:57 freshprimary100%/weekly53%ผ่านresetgate ไม่เริ่มงานซ้ำ
- T449เว็บเดิมmerge/deployแล้วพร้อมCI42948052133เขียว; T451ยังรอmainlint/commit/push/CI/merge/cleanarchivebuild/backup/deploylocal

## Candidate artifact — 2026-11-11 17:10
- [TESTED] Source36f07485pushแล้ว CI43000389023กำลังรัน ไม่merge/deployก่อนgateจบ. Mainlint/typecheck/formatผ่านและcandidateDockerbuildexit0จากcleantrackedarchive ไม่มีowner/localcache.
- [TESTED] Exactcandidateimage sha256:1647d5409d4a3ff572550bf4b0be763ab402b8c561608090e417daf45756c0f6 /BUILD_ID GebJ2JZX5saPw2z5SoGHo รันreplica3339กับAPI4999mock browser8/8passed(29.3s), axe0lightdark รวม2visualcaptures ไม่ใช้POCdata.
- [TESTED] Predeploybackup D:/Works/watchtower-backups/watchtower-20261111-100402-pre-t451-deploy.dump 13875705bytes/243tabledata pg_restore-lอ่านผ่าน; rollbackimagewatchtower/web:rollback-t451เก็บไว้.


## CI regression gate (ยังไม่deploy)
- CI43000389023staticunitล้ม3files: 2oldexactaccessible-name selectorsไม่รวมvisiblefollow-upcopy และinventoryregexต้องelementเป็นpropแรก Mainแก้selectorsแบบexactเต็มใหม่/reorderliteralpropsโดยไม่แตะinventoryrubric; reviewerตรวจ19productionfiles onlyproporder/whitespace ไม่มีvalues/spreadเปลี่ยน และinventory1/1ผ่านอิสระ
- Mainrerun3filesได้57pass1fail: dashboardCTAfound/enabledแต่clickไม่dispatch เพราะloading→ready/errorเปลี่ยนroot/ancestorจนremountfollowUpnode เป็นactualfocus/clickcontinuitybug ไม่ใช่flakytest ให้producerแก้stableframe/slot+newdeferredregression โดยคงoldtestassertionไว้ก่อนcommitfixใหม่


## Stable follow-up fix verified
- [TESTED] Main8files255/255และscopedlint0; independentreviewPASS sourceframe/proporder/selectors, inventoryrubricไม่ถูกแก้. Deferredfocusregressionfail-before/afterpassedครบstates. Sourcefixcb506cf3pushแล้ว CI43003199367รันใหม่
- [TESTED] Finalcandidateimage120cdc8dc9fb1e60a90699010b3d4cc2daf757d51e23b1a5ca6fcec1d604154e /BUILD_IDD61Q1tYWpzMvbTWyyi-ET /OCIrevisioncb506cf308bdd9dbfcbdab78a9f2fd279077beda exactartifact8/8(17.4s), axe0. Mainเปิดภาพfinaldesktopเองแล้ว; ภาพ .cache/t451-image-final/ ไม่deployoldcandidate1647...


## Deployจริง — 2026-11-11 17:38
- [TESTED] SourceCI43003199367ที่cb506cf3ผ่าน4jobsก่อนmerge; mainfastforward/pushcb506cf3และweb-onlycomposeup--no-deps--no-build--wait exit0 ไม่migrate/recreateAPIworker
- [TESTED] Backupfreshpredeploy D:/Works/watchtower-backups/watchtower-20261111-103637-pre-t451-final-deploy.dump 13876511bytes/243tabledata pg_restore-lผ่าน; rollbacktagwatchtower/web:rollback-t451
- [TESTED] MainและindependentreviewerตรวจPOCจริง: webimage120cdc8d.../OCIrevisioncb506cf3/BUILD_IDD61Q1tYWpzMvbTWyyi-ETตรงexactartifactที่ผ่าน8tests; 5healthURLs200, APIworkerIDs/imagesคงเดิม, flags/providerเดิมและbridgeonline=true ไม่มีP0/P1/P2 หลังตรวจ
- Smokecontainerที่งานสร้างถูกลบแล้วเหลือPOC9healthy ไม่มีlogin/POCdata/LLMtest/customerwrite MainCI43005062353ที่sourcecb506cf3ยังรัน ห้ามอ้างmainCIgreenก่อนผลจริง


## ปิดงาน — 2026-11-11 17:50
[TESTED] sourceCI43003199367และmainCI43005062353ที่cb506cf3ผ่านครบ4jobs; merge/pushmain/deployจริง/independentpostreviewผ่าน เว็บhttp://localhost:3000ใช้finalimage120.../OCIrevisioncb506cf3 ไม่มีงานUIค้าง. SourceCIfailureเดิมแก้แล้วโดย255localtests+fullCIgreen ไม่เปลี่ยนrubric/skipเพื่อกลบ. เอกสารสรุปfollow-upไม่เปลี่ยนruntimeและไม่อ้างCIของdocsheadล่วงหน้า; lifecyclecompletecheckpoint/releaseowner/ลบheartbeatหลังpushเอกสาร
