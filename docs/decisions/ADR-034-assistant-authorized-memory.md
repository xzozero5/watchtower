# ADR-034 — Reauthorize assistant history และ pinned memory

- **Status:** Accepted (implementation/tests ยังต้องผ่าน)
- **Date:** 2026-11-06 · **ผู้ตัดสิน:** main ตามอำนาจ owner มอบ PO/main แก้ T411/T445
- **Context:** Security reviewerพบ old redacted business content เข้า modelได้แม้read permissionถูกถอน; memory GETคืนbodyจากstorageโดยไม่resolveสิทธิ์. Mainตรวจservice/history/memorysourceยืนยันpath. การredactชื่อไม่ใช่การอนุญาตอ่านเนื้อหา.

## Decision
- เก็บ server-only authorization metadata แบบversioned: fingerprintของuser/role/sortedpermissions/orgscope (ไม่ผูกsessionID), stable source refs และ source tool names ที่ต้องตรวจใหม่. Clientตั้งmetadataนี้เองไม่ได้; ไม่เก็บtokenmap/secret/rawtoolarguments.
- Message metadataอยู่context JSONเดิม; memoryเพิ่มnullableprivate `authorization jsonb` (next migrationหลังตรวจเลขล่าสุด) เพื่อคงprovenance90วันแม้source_messageถูกpurge30วัน. ไม่backfillสิทธิ์เก่าจากสิทธิ์ปัจจุบันโดยเดา.
- ก่อนเข้าmodel historyแต่ละturnต้องผ่านfingerprintและsource/toolauthorizationปัจจุบันทั้งหมด; ไม่ผ่าน/metadataหาย/readerผิดพลาดให้ตัดturnนั้นจากmodel. Legacyrowsไม่ลบ แต่ไม่ใช้เป็นLLMcontextหากพิสูจน์สิทธิ์ไม่ได้.
- Pinต้องตรวจmessageและsourceปัจจุบันก่อนคัดbody. List memoryที่ใช้ไม่ได้คืนtombstone (`available:false`, ไม่มีbodyธุรกิจหรือrefsเดิม) พร้อมid/dateเพื่อให้เจ้าของForget/Clearได้และนับcap20ถูกต้อง. WebแสดงNo access TH/EN. ไม่ซ่อนrowจนผู้ใช้เคลียร์capไม่ได้.
- ก่อนใช้memoryกับmodelต้องresolve refs/toolsใหม่ทุกครั้งผ่านmodule readers/read-only/auditเดิม; role/scope/permissionเปลี่ยนให้failclosedอย่างconservative. Permissionเพิ่มเติมอาจทำให้snapshotเก่าใช้ไม่ได้เช่นกัน; ผู้ใช้ถามsourceใหม่แล้วpinใหม่ได้.
- Memoryอายุ90วันไม่ต่อจากการใช้. ไม่มีsharedmemoryข้ามuser; metadataและbodyไม่ส่งLLMเมื่อไม่ได้รับอนุญาต. APIcreate/listและLLMreuseต้องมีrevocation/crossuser/forgedmetadata/legacy/sourcepurge tests.
- การนำ≤10pinnedfactsเข้า `<user_notes>` ตามADR029ยังไม่ถูกเชื่อมในsourceปัจจุบัน (mainค้นcallsแล้ว). แยกT445dต่อหลังprivacygate; ต้องneutralize/redactใหม่ ไม่restoreplaceholderของเก่าเป็นคนอื่นในsessionใหม่ และuntrustednotesต้องไม่ทำให้investigate_runเล็ดลอด. ไม่อ้างmemoryมีผลต่อคำตอบก่อนทดสอบส่วนนี้.

## Consequences
Nullable/backwardcompatible migrationก่อนAPIใหม่หลังbackup; frontendflagoptionalรับAPIเก่าได้. Legacymemoryที่provenanceหายแสดงNo accessโดยไม่ทำลายbodyเดิมในDB; ไม่รับรองว่าmigrationหรือconcurrencyผ่านจนtests/reviewจริง. ไม่มีdependency/networkdestinationใหม่.

## Links
- [ADR-029](ADR-029-assistant-stage1.md) §3/§6 · T411/T445
