# T-207 — Security review ปิด Phase 2

- **ผู้ตรวจ:** `security-reviewer` (อ่านอย่างเดียว) · **โค้ด:** `main` @ `731b0fa` · **วันที่:** 2026-11-04 (เวลากรุงเทพ)
- **ผล:** ไม่มี P0/P1 · P2 × 4 (gate ของการเปิดใช้ ไม่ใช่ช่องโหว่ใน default) · P3 × 6 → T-207a (C-2 → T-208)

| ID | Sev | ที่ | ปัญหา | วิธีแก้ |
|---|---|---|---|---|
| C-1 | P2 | `examples/metrics/product-mock.grants.sql`, `packages/db/src/product-db.ts`, compose postgres (ไม่มี mem_limit) | `array_agg(repeat())` ผ่าน guard และทำ Postgres OOM ทั้ง cluster `[TESTED]` · product_mock อยู่ cluster เดียวกับ DB ของ Watchtower | แยก product_mock เป็น service ของตัวเอง + mem_limit, ปิด ad-hoc data เป็นค่าเริ่มต้นบน DB ที่ไม่ใช่ sandbox, text check courtesy, ลดเพดาน ad-hoc |
| C-2 | P2 (ก่อน T-208) | `packages/connectors/src/data/guard.ts` | ปิด `EXTERNAL_QUERY` ด้วย lexer แบบ Postgres — comment `#` ของ BigQuery หลบได้ `[TESTED]` | ด่านจริงที่ IAM (ไม่ให้ connections.use), dry-run ตรวจ statementType/referencedTables/maximumBytesBilled, lexer ตาม dialect |
| C-3 | P2 (ก่อนเปิด status page สาธารณะ) | `apps/api/src/statuspage/*`, rate-limiter | subscribe ส่งอีเมลยืนยันไปที่ใดก็ได้ ไม่มีเพดานรวม, IPv6 ไม่จัด /64 | เพดานรวม/ชม./วัน + alert, /64, PoW (ADR-007), เพดานต่อโดเมน |
| C-4 | P2 (ก่อน T-208) | grants.sql, `hardeningProblems()` | revoke function เฉพาะที่ระบุ; ไม่ตรวจ extension ที่ออกเน็ต/อ่านไฟล์ และ role อ่านไฟล์ server `[UNVERIFIED 70%]` | REVOKE ทุก function จาก PUBLIC ทุก schema + default privileges + probe extension/role |
| C-5 | P3 | `apps/worker/src/usage/*` | dims ของ metric ข้าม column allow-list → ชื่อคนเข้า usage/anomaly → AI | dims ต้องอยู่ใน allow-list หรือปฏิเสธชื่อแบบ PII |
| C-6 | P3 | `packages/shared/src/features/incidents.ts`, `system-tool-ports.ts` | URL deploy feed รับ userinfo/query → ค่าลับของ CI รั่วเข้า UI/AI | ปฏิเสธ userinfo, ตัด query/fragment |
| C-7 | P3 | `apps/worker/src/statuspage/*` | hard bounce ยัง confirmed, ไม่มีหัว List-Unsubscribe | suppress หลัง N bounce + RFC 8058 |
| C-8 | P3 | `apps/api/src/discord/interactions.service.ts` | rate limit ต่อ IP ร่วมกับ ingest → ปุ่ม Discord ได้ 429 ช่วง incident | config แยก / limit ต่อ Discord user |
| C-9 | P3 | `apps/api/src/tools/tool-runner.service.ts` | excerpt ข้าม org ใช้ dictionary ชื่อของ org เดียว | dictionary ทุก org ในผล หรือ mask |
| C-10 | P3 info | `apps/api/src/gmail/push-verifier.ts` | OIDC ไม่ผูก body (ข้อจำกัดของ Pub/Sub) | ยืนยันว่า `LOG_REDACT_PATHS` ครอบหัว authorization |

ตรวจแล้วไม่พบปัญหา: Discord Ed25519 + replay + RBAC รายคน · Pub/Sub OIDC ครบ · template bind + charset ของ param · executor READ ONLY/role/cursor/cap `[TESTED]` · status page XSS/double opt-in/unsubscribe/ปิดเป็นค่าเริ่มต้น · anomaly ticket ไม่เปิดเผยให้ unverified · dashboard RBAC · SMTP 535/451 ของ T-204 แก้แล้ว
ตรวจไม่ได้: BigQuery adapter (ยังไม่มี, T-208), product DB จริง/GCP live/Caddy, integration, `pnpm audit`
ข้อสังเกตเชิง functional: R-8.3 draft proactive notice ถึง primary contact ยังไม่ทำ
