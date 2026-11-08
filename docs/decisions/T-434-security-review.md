# T-434 Security & Architectural Review — KB Multi-Index & Manual Re-embed (`ADR-033`)

- **Date:** 2026-11-09 (เวลากรุงเทพ)
- **Reviewer:** `security-reviewer` (independent read-only review + re-review, N7)
- **Scope:** `T-434` (`T-434a` `pnpm kb:reembed` CLI + `T-434b` `0119_kb_chunk_embeddings.sql` / `searchKb` / `KbEmbeddingService` + `T-434c` `0120_kb_reembed_lease.sql` / durable fencing / dual-embedding publish / atomic switch)
- **Verdict:** **PASS** (`P0: 0` | `P1: 0` | `P2: 0` | `P3: 1` cosmetic note) — **`ADR-033` Accepted**

## Summary of Reviewed Controls & Resolved Findings

| ID | Area | Finding & Resolution | Status |
|---|---|---|---|
| `T-434a C-1..C-3` | Manual CLI (`packages/db/src/kb-reembed.ts`) | อ่าน `role_permissions` จริงตาม DB RBAC, ปฏิเสธ actor `system`/`client`/inactive, ใช้ DB `clock_timestamp()`, และเก็บเฉพาะ `{ actorId, reason }` ใน `outbox.payload` (ไม่เก็บอีเมล PII) พร้อม dedup 60s + 1-per-day rate limit `[TESTED]` | **PASS** |
| `T-434b/c C-1` | Cross-dimension `pgvector` safety (`packages/domain/src/kb/{search,chunks}.ts`) | แทนที่ `coalesce(ce.embedding, c.embedding)` ทั้งใน `WHERE` และ `ORDER BY` ด้วย `CASE WHEN ce.embedding IS NOT NULL THEN ce.embedding WHEN c.embedding_index_id = ${embedding.indexId}::uuid THEN c.embedding END` และจำกัดให้ `kb_chunk.embedding` เก็บเฉพาะเวกเตอร์ของ `isActive === true` เท่านั้น ป้องกัน PostgreSQL โยน `ERROR: different vector dimensions` (500) ระหว่างสร้าง index ต่างมิติ (`4d` vs `8d` / `1024d`) `[TESTED]` | **PASS** |
| `T-434b/c C-2` | Durable lease duration & target spec pinning (`chunks.ts`, `embed.ts`) | ปรับ default `leaseDurationSeconds = 300`s รองรับ cold load ของ local Ollama `bge-m3` (`120s` ต่อ batch), ห้าม fallback ไปหา `deps.ai.embedder` เมื่อระบุ `targetSpec`, และตรวจ `(provider, model, dimensions)` ครบทุก batch `[TESTED]` | **PASS** |
| `T-434b/c C-3` | Advisory lock ordering & stale manifest cleanup (`chunks.ts`) | ขอ `pg_advisory_xact_lock_shared(hashtext('kb_article_publish_and_switch'))` ก่อน `FOR UPDATE` row lock ในทั้ง `replaceArticleChunks` และ `dropArticleChunksIfNotLive` ตรงตามลำดับ lock ของ `ADR-033 §6` (`advisory -> row`) และล้างแถวเก่าใน `kb_version_chunk_manifest` เมื่อเปลี่ยน version/fingerprint หรือถอดจาก `published` `[TESTED]` | **PASS** |
| `T-434b/c C-4` | Finite vector validation (`kb-embedding.service.ts`, `embed.ts`) | ตรวจ `Number.isFinite` บนทุกองค์ประกอบของ query vector ใน API (ถอยกลับ `keyword` อย่างปลอดภัยหากผิดปกติ) และตรวจ spec + `Number.isFinite` ครบในทุกเส้นทางของ secondary dual-embedding `[TESTED]` | **PASS** |

## Non-blocking Residual Note (P3)
- ในกิ่งบทความว่าง (`input.chunks.length === 0`, `chunks.ts:455`) แถว manifest ของ version ก่อนหน้าอาจยังค้างจนกว่าจะแก้กลับมามีเนื้อหาหรือ deprecate บทความ — ไม่มีผลกระทบต่อความถูกต้องเพราะ `articlesNeedingEmbedding` กรอง `m.version_id = a.published_version_id` เสมอ `[CONFIRMED]`.

## Verification Evidence (`[TESTED]`)
- `@watchtower/db`: `src/kb-reembed.integration.test.ts` (`15/15`)
- `@watchtower/domain`: `src/kb/kb-multi-index.integration.test.ts` (`5/5` รวม mixed-dimension `4d` active vs `8d` inactive) + `src/kb/kb.integration.test.ts` (`70/70`)
- `@watchtower/worker`: `src/kb/kb-reembed-race.integration.test.ts` (`5/5` รวม stale lease fencing, V2 publish dual-embed race, empty article manifest) + `src/kb/kb.integration.test.ts` (`10/10`)
- `@watchtower/api`: `src/kb/kb.integration.test.ts` (`39/39`)
- `pnpm test:boundaries`: `298/298`
- **Live local embedder activation (`T-433`)**: ยังไม่เปิดบน POC ตามกฎ `[ASK-HUMAN]` (คง `EMBEDDING_PROVIDER` เดิมไว้ รอเจ้าของสั่งเปิดตาม `docs/runbooks/local-poc.md §3c`).

