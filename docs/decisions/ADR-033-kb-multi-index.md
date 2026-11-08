# ADR-033 — KB vectors หลาย index และการสลับ index แบบ atomic

- **Status:** Accepted (2026-11-09 — implementation & independent security review `PASS`, `T-434-security-review.md` `[TESTED]`)
- **Date:** 2026-11-06 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main ตามอำนาจที่เจ้าของมอบให้ PO/main สำหรับ T-434
- **Context:** T-434 ต้อง enqueue re-embed เองและรักษา active vectors ระหว่าง rebuild. [CONFIRMED: อ่าน source] replaceArticleChunks ลบ chunks เดิมทั้ง article; API คืน keyword เมื่อ configured target ต่างจาก active index. เก็บ vector เก่าอย่างเดียวจึงยังรักษา hybrid search ไม่ได้. Architectอิสระเสนอและ main ตรวจ source ที่เกี่ยวข้องแล้ว.

## Decision
1. แยก vector ไป `kb_chunk_embedding(chunk_id,index_id,embedding)` มี PK/FK/dimension/finite validation และ backfill จากของเดิมโดยรักษา chunk ID. ย้าย readers/writers ก่อนเลิกใช้คอลัมน์เดิม; migration ต้อง backward-compatible และทดสอบก่อน deploy หลัง backup.
2. Chunk identity เป็น immutable version + chunker/input fingerprint (รวม title/section/text/preprocessing). เติม index ใหม่ต้อง upsert vectors ไม่ลบ/reinsert chunks. มี completion manifest ต่อ version/chunk set รองรับบทความว่างและ retry แบบ idempotent; rechunk สร้าง chunk set ใหม่ ไม่ประกบ vector ของข้อความเก่ากับข้อความใหม่.
3. Query embed ตาม **active index spec** ผ่าน provider factory/allow-list เดิม ไม่ตาม configured target อย่างเดียว. Pin index ID ต่อ requestและใช้audited embedderที่ผูกspecแบบimmutableต่อcall/instance; ห้าม mutate shared settingsระหว่างconcurrentrequests. ตรวจoutcomeprovider/model/dimensionsตรงpinnedindexก่อนคืนvector; ห้าม relabel vector เมื่อ active เปลี่ยนกลาง request. Old provider ไม่พร้อมให้ keyword fallback อย่างชัดเจน ไม่รับประกัน hybrid โดยไม่มี model/credential ของ provider เดิม.
4. Publish V2 ระหว่าง build: สร้าง keyword chunks V2 และ enqueue embedding ให้ active + building spec ตามที่ใช้จริง. เก็บ V1 vector แต่ห้ามค้น V1 หลัง V2 published; V2 อาจ keyword-only ชั่วคราวจน active vector พร้อม. Query ต้อง join published version และ visibility ปัจจุบันทุกครั้ง.
5. Pin target spec ต่อ rebuild run และตรวจผล batch/provider/model/dimensions/fingerprint ก่อน persist. Manual/scheduled run ใช้ durable lease/fencing + dedup; stale run ห้าม activate.
6. Publish/deprecate และ activation ใช้ advisory transaction lock เดียวกัน โดยประกาศ lock order ก่อน article lock. Network/model calls อยู่นอก transaction. Activation ตรวจ manifest/chunks/vectors ของ **published version ปัจจุบันทุก article** ครบแล้วเปลี่ยน active+audit ใน transaction เดียว. Failure ห้าม switch; kill/budget เป็น deferred ไม่มี retry loop และ resume เฉพาะสิ่งที่ขาด.
7. เพิ่ม `pnpm kb:reembed` ผ่าน request/audit/outbox pattern เดิม คืน request ID. ใช้ credential instance จาก environment โดย runner ไม่อ่าน/พิมพ์ค่า; ไม่มี endpoint/network/dependency ใหม่. การระบุ actor/permission ต้องตรง CLI admin pattern ที่มีอยู่และทดสอบการปฏิเสธ ไม่รับ claimed identity โดยไม่ตรวจสิทธิ์.
8. ไม่เพิ่ม DB dependency ใน packages/ai และไม่ import ข้าม apps. Domain ดูแล persistence/activation; API/worker ประกอบ provider. ไม่ลบ old index/model/volume อัตโนมัติ; rollback ต้องตรวจ coverage กับ published versions ใหม่อีกครั้ง.

## Options considered
- เพิ่ม vector ช่องสอง: schemaเล็กแต่จำกัดจำนวน index และยังแก้ destructive chunk replacement/query routing/publish race ไม่ครบ.
- **ตาราง vectors ต่อ index (เลือก):** รักษา snapshot identity/resume ได้โดยไม่ทับ active; เพิ่ม migration/lifecycle และ storage.
- Snapshot ทั้ง corpus ต่อ generation: isolationดีแต่ storage/lifecycleมากเกิน minimumนี้.

## Consequences
- เพิ่ม storage และอาจ embed สอง model ชั่วคราว ใช้ budget/kill switch/audit เดิมทุกครั้ง; ไม่มี API/cloud spending ใหม่ที่ข้าม config budget.
- T-434 แบ่ง bounded tasks: a manual enqueue; b vector/chunk persistence+active query routing; c worker/publish/activation+failure/race tests. Parentไม่ปิดจนทุกข้อผ่าน. T-433เปิด provider/re-embedหลังทั้งหมดผ่านและ API hybrid ยืนยันจริง.
- Required tests: backfill/constraints, active hybrid ระหว่าง rebuild, V2publishไม่คืนV1/text-vectorผิดคู่, empty article, stale/duplicate/crash resume, publish/switch concurrency, provider/audit/budget failure, queryข้ามswitch, audience/org/deprecation. ใช้ DBทิ้ง/mock provider; live T433แยกหลังbackup.
- [UNVERIFIED] implementation/race correctness/compatibility/old-model availability ยังต้องพิสูจน์ ไม่มีการเปลี่ยน schema หรือเปิด local providerจาก ADRนี้เพียงอย่างเดียว.

## Links
- [ADR-030](ADR-030-local-embeddings.md) §5 — supersede เฉพาะ single-vector transition เมื่อ implementation นี้ผ่าน
- [BACKLOG](../BACKLOG.md) T-434/T-433
