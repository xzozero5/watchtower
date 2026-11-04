# ADR-028 — PDF export ของ CEO view ด้วย pdfkit (T-305d)

- **Status:** Accepted
- **Date:** 2026-11-04 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread ตามที่เจ้าของอนุมัติ dependency PDF export ใน Phase 3 (2026-11-04 `[CONFIRMED]`) · ร่างโดย `backend-dev`
- **Context:** T-305b ส่งออก CSV/HTML แล้ว CEO ต้องการ PDF · ข้อจำกัด: ไม่มี network ตอน runtime, รองรับภาษาไทย, ไม่ดาวน์โหลด browser

## Decision
- ใช้ `pdfkit` (MIT, pure JS, ใช้ fontkit ทำ shaping ไทย, ฝัง subset + ToUnicode ให้ข้อความ extract ได้) ใน `apps/api/src/reports/ceo-pdf.ts`
- ฟอนต์ IBM Plex Sans Thai (OFL 1.1) จาก `@fontsource/ibm-plex-sans-thai` ที่ web ใช้อยู่ (ADR-018) — ไม่เพิ่มไฟล์ฟอนต์เข้า repo · ตัวอักษรไทยใช้ subset thai ที่เหลือ subset latin · ตัดบรรทัดด้วย `Intl.Segmenter('th')`
- PDF เป็นมุมมองที่ได้จาก `ceoViewSchema` เดียวกับ CSV/HTML (ตัวเลขเดียวกัน) · RBAC `ceo.view` + audit `ceo.export` (`metadata.format='pdf'`) · `Cache-Control: no-store` · ไม่มี JavaScript/Launch/URI action ในไฟล์ (มี test)

## Options considered
1. headless browser (puppeteer/playwright) — ต้องดาวน์โหลด Chromium ~150–300 MB, image ใหญ่, attack surface ใหญ่ (รัน JS engine บนข้อมูลที่ผู้ใช้ใส่) · ตัด
2. pdf-lib (MIT) — ไม่มี layout/ตัดบรรทัด, shaping ไทยต้องทำเอง · ตัด
3. **pdfkit (เลือก)**

## Consequences
- dependency ใหม่: `pdfkit` (+ fontkit, linebreak, png-js, crypto-js, brotli — MIT ทั้งหมด) และ `@fontsource/ibm-plex-sans-thai` ใน api · image api ใหญ่ขึ้นเล็กน้อย
- ฟอนต์อ่านด้วย `require.resolve` ตอน boot ของโมดูล — ยังไม่ได้ build image ตรวจ `[ยังไม่ยืนยัน 75%]`
- layout เป็นตารางเรียบ ไม่มีกราฟ · ยังไม่ได้ดู render เป็นภาพ (ตรวจด้วย `pdftotext` ว่าข้อความไทยออกมาได้ `[TESTED]`)
- Google Docs export: mock/fixture เท่านั้น ยังไม่ทำ
- ตรวจซ้ำเมื่อ: pdfkit/fontkit มี CVE, ต้องการ PDF/A หรือกราฟ

## Links
T-305b, T-305d · ADR-018 · `apps/api/src/reports/ceo-pdf.ts`
