# ADR-027 — ตัวหาชื่อคนที่ไม่มี cue แบบรันในเครื่อง (T-153)

- **Status:** Accepted (ขั้น 1) · ขั้น 2 รอเจ้าของอนุมัติการดาวน์โหลด model
- **Date:** 2026-11-04 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread ตามที่เจ้าของอนุมัติ dependency NER ใน Phase 3 (2026-11-04) · ร่างโดย `ai-engineer`
- **Context:** ADR-008 ยอมรับว่าชื่อที่ไม่มี cue และไม่อยู่ใน dictionary หลุดไป LLM · eval ของ redactor (T-302e, `evals/runner/redaction/corpus.json` 92 เคส) วัด recall `name_nocue` = 0/16 `[TESTED]` · ข้อจำกัด: ไม่มี network ตอน runtime, license เข้ากับ Apache-2.0, redactor เป็น sync, over-redact ได้ (N4) แต่ไม่ทำลายข้อมูลที่ต้องคง

## Decision
1. **ขั้น 1 (ทำแล้ว):** `REDACTION_NER=off|local` (ค่าเริ่ม off) ใช้ `compromise@14.19.0` (MIT, ~2.8 MB, sync, ภาษาอังกฤษเท่านั้น, ไม่มี network, ไม่มีไฟล์ model) ใน `packages/ai/src/redaction/ner-local.ts` · fail closed: finder throw หรือข้อความยาวเกินเพดาน → `redact` throw · ไม่ใช้เป็นเหตุให้ลดการ redact อย่างอื่น
2. **ขั้น 2 (ชื่อไทย):** transformers.js + ONNX NER ภาษาไทย (`@huggingface/transformers` Apache-2.0 + `onnxruntime-node` MIT ~307 MB + model ≥ ~100 MB `[ยังไม่ยืนยัน 60%]`) · ต้องเปลี่ยน redactor เป็น async · model เป็น artifact pin sha256 mount read-only ไม่ดาวน์โหลดตอน runtime · **`[ASK-HUMAN]` อนุมัติการดาวน์โหลด model + ตรวจ license/ขนาดกับต้นทางก่อน**
3. **เกณฑ์รับ (ทั้งสองขั้น):** recall `name_nocue` ≥ 80% แยกไทย/อังกฤษ, false positive ในเคส keep ≤ 2%, p95 ≤ 100 ms ต่อ ticket 5 KB · วัดด้วย corpus เดียวกัน และ re-run ทุกครั้งที่เปลี่ยน finder

## ผลวัดขั้น 1 `[TESTED]` (corpus ที่ผู้ผลิตเขียนเอง — ต้องให้ผู้ตรวจอิสระเพิ่มเคส N7)
| ตัวชี้วัด | off | local |
|---|---|---|
| name_nocue recall | 0/16 | 8/16 (อังกฤษ 4/5, ไทย 0/3) |
| recall รวม | 81% | 90% |
| false positive (keep) | 1/66 | 1/66 |
| เวลา ticket 5 KB | 0.6 ms | 13.9 ms |

ยังไม่ผ่านเกณฑ์ข้อ 3 → คง default off

## Options considered
1. compromise (เลือกสำหรับขั้น 1) — เล็ก sync อังกฤษอย่างเดียว
2. transformers.js + ONNX (ขั้น 2) — ครอบไทย แต่ใหญ่และ async
3. sidecar Python (spaCy/PyThaiNLP) — ขัด ADR-001 เพิ่ม service · ตัด
4. gazetteer + `Intl.Segmenter('th')` — ไม่มีรายชื่อไทยที่ license ชัด · ตัด

## Consequences
อังกฤษดีขึ้นเมื่อเปิด flag · ชื่อไทยยังเป็น known gap (ADR-008) จนกว่าขั้น 2 · dependency ใหม่ 1 ตัวไม่มี network

## Links
ADR-008, T-114-review (C-9), T-153, T-157, T-302e · `packages/ai/src/redaction/ner-local.ts`, `evals/runner/src/redaction-eval.ts`
