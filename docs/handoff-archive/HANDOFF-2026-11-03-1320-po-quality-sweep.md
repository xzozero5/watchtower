# HANDOFF — Watchtower

> อัปเดตล่าสุด: 2026-11-03 13:20 (เวลากรุงเทพ) โดย Codex main thread — PO takeover / stakeholder quality sweep
> ฉบับก่อน: `docs/handoff-archive/HANDOFF-2026-11-03-pre-po-quality-sweep.md` · รายงานรอบนี้ `docs/qa/2026-11-03-po-quality-sweep.md`

## สถานะปัจจุบัน
- **Branch:** `codex/po-quality-sweep` จาก `main` @ `d7b70d2`; งานรอบนี้แยก branch ไม่มี merge เข้า main หรือ deploy POC
- **Phase:** 0/1 MVP และ 2 mock พร้อมของเดิม; รอบนี้ปิด T-156/T-162/T-163/T-164 และ T-158 เฉพาะ QA-06 ยังไม่เริ่ม Phase 3
- **ผลตรวจ:** final unit+boundaries4911ผ่าน/29contractskip (18tasks,0cached), lint18/typecheck17ผ่าน; รายละเอียดอยู่ entry PO quality sweep ใน STATUS; browser อิสระ 186 pass /32 screenshot-only skip, fullstack 38 completed (37 pass + 1 expected failure B-003 Gmail ack), independent PO/security ผ่าน
- **Deployment เดิม:** localhost web3000/api4000; staff Google login จริง (POC gmail allow-list, dev loginปิด), Gmailจริง, AI `claude -p`; LINE/Discord/SMTPออก/GCPยังmock ไม่ได้ทดสอบข้อมูลจริงรอบนี้
- **ต้นทุน:** ไม่มี external AI/cloud API call รอบนี้; token/ต้นทุน build agents ไม่มี meter รวมให้ตรวจ ไม่ได้ประมาณเป็น0

## การตัดสินใจของเจ้าของที่มีผลอยู่
- เจ้าของมอบให้ PO เข้าใจระบบ ทดสอบหลาย stakeholder และปรับปรุงตามดุลยพินิจ 2026-11-03; รอบนี้ agent จำลองมุมผู้ใช้ ไม่ใช่สัมภาษณ์ stakeholderจริง
- AI ในผลิตภัณฑ์ยังใช้ `claude -p` ตาม ADR-017; ไม่เปลี่ยน provider/stack/schema/autonomy และไม่เพิ่ม dependency
- ใช้ Soft Beacon ตาม ADR-018; stage ≥3 ยังต้องผ่าน gate/เจ้าของอนุมัติ

## ทำเสร็จใน session นี้
| งาน | ผล | ไฟล์หลัก |
| --- | --- | --- |
| T-156 | Staffเห็นชื่อ/ขนาดไฟล์ ดาวน์โหลดผ่าน authenticated API, coordinated refresh, pending/error/retry; devไม่มีraw download; ไม่เผยstorage URL | conversation/message-attachments.tsx, lib/api/client.ts |
| T-158 QA-06 | AI Waitอ่านtimelineล่าสุดก่อนยืนยัน/ยกเลิก; error/incompleteไม่เขียน; ออกหน้าแล้วcallbackเก่าไม่เปลี่ยนสถานะ | ai/ai-brief.tsx, ticket/waiting-customer-confirm.tsx |
| T-162 | Home SLA/unassigned/oldest filtersตรงจำนวน, show-allยอดจริง/lower bound, devไม่ปนworkload, No queueไม่ลิงก์ไปทุกqueue | home/home-page.tsx, home-sections.tsx, lib/admin/queries.ts |
| T-163/B-001 | Portalรับhashchangeและrefetchแม้tokenเดิม; stale GET/POST401ไม่ลบลิงก์ใหม่; current401ยังrevoke; ลบknown-fail markerหลังพิสูจน์จริง | portal/tracking-page.tsx, e2e-fullstack/ac1-portal.e2e.ts |
| T-164 | เติมtesting/checklistที่AGENTSอ้างแต่ไม่มี, stakeholder report, independent acceptance5ข้อ, scope retry testให้ถูกsection | docs/07-TESTING.md, docs/08-QA-CHECKLIST.md, e2e/po-audit.e2e.ts |

## ค้าง / ติดอะไร
- T-154 slow upload admission/slot starvation และ T-155 quota/retention/orphan sweep/streaming ยังเปิด; รอบนี้ไม่ใช่ internet-readiness signoff
- T-158 rail countsยังไม่ทำ; T-159 history/trend APIยังเปิด; T-141 lead morning workflowยังมีส่วนเหลือ
- B-002 unverified LINE requester, B-003 Gmail ack และ B-004 critical banner a11y ยังต้องตรวจ/ปิดแยก; อย่าอ้าง test.fail เป็นfeatureผ่าน
- T-113/T-114/T-207 phase QA/security/PO gate กับ T-115 pilot ยังไม่ปิด
- T-161 ส่วน PoW batch test แก้โดย QA (bounded known vector, ไม่เพิ่ม timeout/retry); flakyอื่นยังไม่สรุป root cause; รอบนี้พบ boundary lint fixture test timeout90sใต้โหลดหนัก เคยผ่านเมื่อจำกัดTurbo concurrency2; พบcomposer-send fixture5sหมดก่อนassertใต้โหลดหนักเพิ่ม (ยังเปิด); final gateใช้concurrency1/maxWorkers4ตามdocs/07; build/typecheck/browserต้องเรียงลำดับบนWindows
- ไม่แก้/commit `.agents/` และ `.codex/` ที่ untracked อยู่ก่อนเริ่ม

## รอเจ้าของ (`[ASK-HUMAN]`)
- [ ] malware scanning dependency (T-155) และข้อกำหนดการเก็บไฟล์จริง
- [ ] ข้อความไทยใหม่/เดิมยังต้องเจ้าของภาษาตรวจ
- [ ] T-115 pilot: ย้ายจากPOCไปWorkspace/stagingตามrunbookก่อนเปิดinternet; GCP stagingยังไม่เคยรันจริง
- [ ] Gmail tunnel เจ้าของเปิดเองเมื่อจะทดสอบpushจริงตามrunbook §4; ไม่ต้องเปิดเพื่อunit/mock/fullstackรอบนี้

## ขั้นต่อไป (เรียงลำดับ)
1. Review/merge branchรอบนี้ตามgit workflow แล้วdeploy/rebuild POCด้วยconfigเดิมเมื่อพร้อม (ยังไม่ได้ทำ)
2. T-154/T-155 ทำstorage/capacityให้พร้อมก่อนpublic portal; malwareต้องถามตามdependency guard
3. T-159 history/trend และ T-158 railcounts; ต่อ T-141/T-142/T-143/T-144/T-145/T-146/T-147 ตามBACKLOG
4. เติมrole-based fullstack AC-3/5/7/dev, วิเคราะห์T-161, ปิดT-113/T-114/T-207
5. Pilotกับผู้ใช้จริง เก็บผลก่อนเริ่มPhase3/gate stage3

## วิธีเปิดระบบและทดสอบต่อ
- อ่าน `docs/runbooks/local-poc.md` + `docs/07-TESTING.md` ก่อนใช้service; integration/fullstackห้ามใช้DB/Redis/MinIO/MailpitของPOC
- **bridgeไม่ได้รันค้าง:** ก่อนทดสอบAIจริง เจ้าของ/ผู้รับช่วงเปิด terminalแยก `node --env-file=D:\Works\secret\watchtower.env tools/claude-cli-bridge/server.mjs`; ทดสอบPOSTไม่มีtokenที่4317ต้อง401; bridgeไม่เปิด=audited provider_unavailable ไม่fallbackmock
- ห้ามพิมพ์ค่าenv/credential; จริงอยู่ภายนอกrepoตามrunbook
- รอบนี้ใช้containerทิ้งชื่อ `wt-codex-po-pg/redis/mailpit` บน45560/46560/41560/48560; ล้างเฉพาะcontainerที่สร้างเองหลังgate (ดูdaily)
- web browser port3100จองคนเดียว; `pnpm build`ให้จบก่อน `pnpm typecheck`/browser; Windows `.next`ชนกันเกิดEBUSY/TS6053

## ยังไม่ยืนยัน
- mobileจริง, native Thai copy, external sandbox, internet readiness และstaging deploy ไม่ได้ยืนยันรอบนี้
- file download browserทดสอบbinary mock; ไม่ได้ทดสอบของจริงในMinIOรอบนี้ (APIrouteเดิมไม่แก้)
- business-hours copy, name-cue recallกับข้อมูลลูกค้าจริง, upload memoryในcontainer, rail outageบนจอจริง และcache skeleton30s ยังไม่ยืนยันตามฉบับก่อน

## วันตรวจซ้ำ
- PO/QA/security review: 2026-11-03
