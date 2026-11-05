# ADR-030 — Embedding ของ KB ด้วยโมเดลที่รันในเครื่อง (Ollama + โมเดล multilingual) เพื่อให้ semantic search ใช้ได้จริง

- **Status:** Proposed
- **Date:** 2026-11-05 (เวลากรุงเทพ) · **ผู้ตัดสิน:** เจ้าของ (เลือกทาง ก. รันโมเดลเอง + อนุมัติดาวน์โหลดโมเดลหนึ่งครั้ง `[CONFIRMED 2026-11-05]`) + main thread (รายละเอียด) · รอ `security-reviewer` (N7) ก่อน Accepted
- **Context:**
  - KB ค้นแบบ hybrid อยู่แล้ว (`packages/domain/src/kb/search.ts`: keyword + vector ผ่าน pgvector รวมด้วย RRF, chunk + `kb_embedding_index` ที่ active ได้ทีละ index, migration 0019) `[TESTED: อ่านโค้ด 2026-11-05]`
  - provider ของ embedding มีแค่ `mock` (vector ปลอม ไม่สื่อความหมาย) และ `vertex` (`EMBEDDING_PROVIDERS` ใน `packages/shared/src/config.ts`) · POC ใช้ `claude -p` ซึ่งไม่มี embedding (Anthropic ไม่มี embedding API) → semantic search บน POC ใช้ไม่ได้จริง เหลือแต่ keyword `[ยังไม่ยืนยัน 80%: ยังไม่ได้ดูค่า env ของ POC]`
  - เจ้าของต้องการให้ KB (จาก folder `WATCHTOWER_KB_DIR` / `pnpm kb:sync`) ค้นเชิงความหมายได้ ภาษาไทยและอังกฤษ · Jarvis (ADR-029) ใช้ `kb_search` / `kb_get`
  - AGENTS.md: dependency ที่มี network ไปปลายทางใหม่ต้องให้เจ้าของอนุมัติ — อนุมัติแล้วเฉพาะการดาวน์โหลดโมเดลครั้งแรก

## Decision
1. **Service ใหม่ `embedder` ใน docker compose (profile `ai`)** ใช้ image ทางการของ Ollama (pin tag + digest ที่ตรวจจาก Docker Hub/เอกสารทางการ ณ วันที่ implement แล้วบันทึกวันที่/ลิงก์ใน ADR นี้) · อยู่บน network `ai` เท่านั้น (api + worker เข้าถึงได้, web/caddy/minio ไม่ได้) · **ไม่ publish port ออก host** · volume `embeddermodels` เก็บโมเดล
2. **โมเดล:** `bge-m3` (multilingual รวมไทย, 1024 มิติ, ~1.2 GB) เป็นค่าเริ่มต้น `[ASSUMED]` · ตัวเลือกสำรองที่เล็กกว่า `multilingual-e5` ตั้งผ่าน env `EMBEDDING_MODEL` · ไม่ hardcode ชื่อโมเดลในโค้ด (ค่าอยู่ใน env/`config/models.yaml`)
3. **ดาวน์โหลดโมเดลครั้งเดียว:** init container `embedder-init` สั่ง pull โมเดลลง volume ถ้ายังไม่มี (เหมือนแบบ `minio-init`) · หลังจากนั้น service ทำงานได้โดยไม่ต้องออก internet · ปลายทางเดียวที่ออก internet คือ registry ของโมเดลตอน pull — บันทึกใน `docs/09-SECURITY.md` · pull ล้ม = embedder ไม่ healthy → search ถอยไป keyword อย่างเดียว (ทำงานแบบเดิม ไม่ใช่ mock)
4. **Provider `local` ใน `packages/ai`:** `EMBEDDING_PROVIDERS = ['mock','vertex','local']` · adapter เรียก HTTP endpoint embed ของ Ollama ที่ `EMBEDDING_LOCAL_URL` (default `http://embedder:11434`) ด้วย timeout + retry + เพดานขนาด batch · ผ่าน `createAuditedEmbedding` เดิม (audit ใน `ai_run`, cost = 0) · ข้อความผ่าน redaction ตามนโยบายเดิมของ embedding (ADR-008) · host allow-list: ยอมเฉพาะ host ใน compose network หรือ loopback (กันชี้ไปปลายทางภายนอก)
5. **Index:** สร้าง `kb_embedding_index` ใหม่ `(provider 'local', model, dimensions)` แล้ว re-embed ทุก chunk ใน worker (job เดิมของ kb) · สลับ active เมื่อ embed ครบ (atomic) · `pnpm kb:sync` และการแก้บทความ embed ใหม่ตามปกติ · ไม่เปลี่ยน schema (vector ไม่จำกัดมิติอยู่แล้ว; trigger ตรวจมิติกับ index) → **ไม่มี migration** ยกเว้นพบว่าต้องมี index ANN ต่อมิติ
6. **Query embedding:** api embed คำค้นด้วย provider เดียวกัน (timeout สั้น เช่น 1.5 s) ล้ม/ช้า = keyword อย่างเดียว ไม่ทำให้ search ล้ม
7. **ค่าความใกล้เคียงขั้นต่ำ** (`KB_MIN_VECTOR_SIMILARITY`, ตอนนี้ 0.25 `[ASSUMED]`) ปรับด้วยชุดคำถาม TH/EN ของ KB ตัวอย่าง (`examples/`) และบันทึกค่าใน ADR นี้เมื่อวัดแล้ว
8. **ทรัพยากร:** CPU อย่างเดียวได้ (ไม่ต้องมี GPU) · ตั้ง memory limit ของ container · concurrency ของ embed จำกัดใน worker เพื่อไม่แย่ง CPU กับ service อื่น

## Options considered
- **ก. Ollama + bge-m3 ในเครื่อง (เลือก, เจ้าของ)** — ไม่มีค่าใช้จ่ายต่อครั้ง ข้อมูลไม่ออกนอกเครื่อง รองรับไทย / ดาวน์โหลดโมเดลครั้งแรก, ใช้ CPU/RAM
- ข. Vertex AI — มีโค้ดแล้ว / ต้องมี GCP key, ข้อมูลออกนอกเครื่อง
- ค. API แบบเสียเงิน (เช่น Voyage) — คุณภาพดี / มีค่าใช้จ่าย, ข้อมูลออกนอกเครื่อง
- Hugging Face text-embeddings-inference — เร็ว / image ใหญ่, จัดการโมเดลยุ่งกว่า Ollama สำหรับเครื่อง Windows + Docker Desktop
- โมเดลใน process ของ Node (transformers.js/onnx) — ไม่ต้องมี service เพิ่ม / โหลดโมเดลซ้ำทุก process (api + worker), กิน RAM ของ process หลัก

## Consequences
- งาน T-430 (`ai-engineer`/`integration-engineer`): service + init + provider `local` + test (contract test ด้วย fake HTTP, ไม่ต้องมีโมเดลจริงใน CI) · T-431 re-embed + สลับ index + ปรับ threshold ด้วยชุดคำถาม · T-432 `security-reviewer`
- CI ไม่ดาวน์โหลดโมเดล (ใช้ mock/fake) · e2e ที่ต้องใช้โมเดลจริงรันมือบนเครื่องเจ้าของ
- ตรวจซ้ำเมื่อ: คุณภาพภาษาไทยไม่พอ (ลองโมเดลอื่น), เครื่อง pilot RAM ไม่พอ, ย้ายไป GCP (อาจใช้ Vertex)

## Links
- ADR-001 (pgvector), ADR-008 (redaction), ADR-019/021 (network `ai`), ADR-029 (`kb_search`), `packages/domain/src/kb/search.ts`, `packages/ai/src/audited-embedding.ts`, `packages/ai/src/providers/vertex.ts`
- เอกสาร Ollama (embed API, Docker image) และ model card ของ bge-m3 — `[VERIFY]` ตอน implement พร้อมวันที่
