# ADR-003 — แหล่ง image ของ MinIO ใน compose

- **Status:** Accepted (ชั่วคราว รอเจ้าของทบทวน)
- **Date:** 2026-10-31 (เวลากรุงเทพ) · **ผู้ตัดสิน:** main thread
- **Context:** ADR-001 กำหนด object storage local เป็น MinIO · `minio/minio`, `minio/mc` และ `quay.io/minio/minio` ไม่มี manifest ให้ดึง (`docker manifest inspect` ล้มเหลว ขณะที่ registry อื่นตอบปกติ, ตรวจ 2026-10-31) `[TESTED]` · สาเหตุที่หายไปยังไม่ได้ตรวจกับต้นทาง `[VERIFY]`

## Decision
- ยังคงใช้ MinIO ผ่าน S3 interface ตาม ADR-001 ไม่เปลี่ยน stack
- compose ใช้ fork ชุมชน `pgsty/minio` และ `pgsty/mc` แบบปักเวอร์ชัน override ได้ด้วย `MINIO_IMAGE` / `MINIO_MC_IMAGE`
- ใช้กับ local/dev เท่านั้น bind `127.0.0.1` · production ใช้ GCS ตาม ADR-001 จึงไม่มี image นี้

## Options considered
- **`pgsty/minio` (เลือก)** — รันได้จริง ไม่ต้องแก้โค้ด แต่เป็น image ของบุคคลที่สาม
- **Build จาก source ของ MinIO** — ไม่ต้องเชื่อ image ของคนอื่น แต่เพิ่มเวลา build และภาระดูแล
- **ตัวอื่นที่รองรับ S3 เช่น RustFS, Garage** — ไม่ผูกกับ MinIO แต่เบี่ยงจาก ADR-001 มากกว่า และยังไม่ได้ทดสอบ

## Consequences
- ความเสี่ยง supply chain จำกัดอยู่ที่เครื่อง dev และ deployment แบบ self-host ที่ใช้ค่าเริ่มต้น → ระบุใน `docs/04-ARCHITECTURE.md` §5
- โค้ดแอปคุยผ่าน S3 interface เท่านั้น เปลี่ยนตัว storage ภายหลังไม่ต้องแก้โค้ด
- `security-reviewer` ตรวจเรื่องนี้ใน T-010 · ทบทวนก่อน release สาธารณะ

## Links
- ADR-001 · `docker-compose.yml` · `docs/04-ARCHITECTURE.md` §5
