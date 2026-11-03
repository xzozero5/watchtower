# กลยุทธ์การทดสอบ Watchtower

เอกสารนี้บันทึกวิธีตรวจระบบจากเครื่องมือใน repo ผลจริงของแต่ละรอบอยู่ใน `docs/STATUS.md` และ `docs/qa/` การมี test อยู่ไม่ถือว่า feature ผ่าน ต้องมีผลรันและระบุขอบเขต mock/real เสมอ (N5)

## ชั้นการตรวจ

| ชั้น | คำสั่งจาก root | สิ่งที่พิสูจน์ / ข้อจำกัด |
| --- | --- | --- |
| Static | `pnpm lint`, `pnpm typecheck` | รูปแบบ โค้ด type และ boundary; ไม่พิสูจน์พฤติกรรม |
| Unit + boundaries | `pnpm test` | pure rules, component interactions, redaction, API client, package boundaries; อาจมี Turbo cache ต้องระบุ |
| Integration | `pnpm test:integration` | API/domain/worker/DB กับ service ทิ้งได้; อ่าน env และ harness ก่อนรัน |
| Browser, mocked API | `pnpm test:e2e` | production web build, keyboard, a11y, responsive, error states; ไม่พิสูจน์ API authorization จริง |
| Full stack | `pnpm test:e2e:fullstack` | browser → web → API → worker → DB/Redis/Mailpit; external adapters ยังเป็น mock ตาม runner |
| External sandbox / pilot | runbook ของ integration นั้น | ต้องได้สิทธิ์ใช้ credential/ส่งข้อความจริงตาม AGENTS; ไม่ใช้ผล mock แทน |

API harness อยู่ `apps/api/src/testing/harness.ts`; browser config อยู่ `apps/web/playwright.config.ts` และ `apps/web/playwright.fullstack.config.ts`; full-stack runner อยู่ `tools/e2e-stack/` รายละเอียด `apps/web/e2e-fullstack/README.md`

## แยกข้อมูลทดสอบ

- ห้ามใช้ DB/Redis/MinIO/Mailpit ของ POC หรือ production แม้ test จะสร้าง database ของตัวเอง เพราะ shared rate counter/object/email ยังชนกันได้
- ใช้ container ทิ้งได้ของรอบนี้และ port แยก ตาม `docs/runbooks/local-poc.md` §6 ตั้ง env ก่อนรันทุกครั้ง ห้ามพิมพ์ env จริงหรือ credential
- Full-stack ต้องตั้ง `E2E_ADMIN_DATABASE_URL` (หรือ `TEST_DATABASE_URL`), `E2E_REDIS_URL`, `E2E_MAILPIT_URL`, `E2E_SMTP_PORT` ให้ชี้ชุดทิ้งได้ทั้งหมด `E2E_STACK=external` เขียนข้อมูล จึงห้ามชี้ stack ของผู้ใช้
- Full-stack worker ใช้ object store ใน memory ตาม `tools/e2e-stack/worker-runner.mjs`; ไม่ถือว่าได้พิสูจน์ MinIO download ด้วย
- บน Windows ใช้ `PW_CHANNEL=chrome` ตาม runbook ปัจจุบัน browser UI ใช้ port 3100 จองคนรันคนเดียวต่อครั้ง
- รัน build ให้จบก่อน browser และ typecheck: `next build` ลบ/สร้าง `.next` ส่วน browser รันจาก `.next/standalone`; รันชนกันเกิด EBUSY หรือ type files หายได้
- เครื่องที่มี logical CPU มากและรันหลายชุดพร้อมกัน ใช้ `pnpm exec turbo run test test:boundaries --concurrency=1 -- --maxWorkers=4` เพื่อตรวจ targets เดียวกับ `pnpm test` โดยจำกัดงานพร้อมกัน ไม่เพิ่ม timeout/retry หรือตัด tests; บันทึกรอบ unbounded ที่ล้มไว้ด้วย

## Regression ที่ต้องรักษา

ใช้ checklist ใน `docs/08-QA-CHECKLIST.md` และ PRD §5 เป็น acceptance หลัก ผู้ผลิตแก้ implementation; QA/security/PO คนละ agent ตรวจผลตาม N7 ห้ามปรับ rubric หรือ known-failure marker เพื่อให้ผลเขียวโดยไม่มีหลักฐาน

- บั๊กใหม่ต้องมี repro ที่ล้มก่อนแก้ และ assertion ที่ตรวจพฤติกรรมหลังแก้
- ทุก action ตรวจทั้งสำเร็จ ยกเลิก ปฏิเสธสิทธิ์ network/error และ stale response เมื่อมี async
- ค่าบน dashboard ต้องใช้แหล่งข้อมูล/filters เดียวกับรายการที่เปิด ไม่แสดงยอด preview เป็นยอดทั้งหมด
- `test.fail()` คือ known defect ไม่ใช่ test ผ่าน นำออกหลัง test เดิมผ่านเพราะแก้บั๊กแล้ว พร้อมบันทึก evidence
- Test flaky ต้องบันทึกรอบที่ล้มและสาเหตุ ห้ามรายงานเฉพาะ retry ที่ผ่าน และไม่เพิ่ม sleep/retry เพื่อซ่อน regression
- หลังแก้ shared package ให้ build dependencies ใหม่ตามบทเรียนใน STATUS ก่อนทดสอบ consumer

## รายงานผล

แต่ละรอบระบุ commit/branch, command, service isolation, pass/fail/skip/expected-failure, reviewer, สิ่งที่ยังไม่ทดสอบ และ residual risk ใน STATUS/HANDOFF ใช้ checklist เป็นประตูตรวจตาม scope ของงาน ไม่ใช่การรับรองว่าทั้งระบบพร้อม production
