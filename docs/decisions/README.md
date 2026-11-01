# Architecture Decision Records — สารบัญ

- [ADR-001](ADR-001-stack.md) — Tech stack + deployment target (Docker local → GCP) · Accepted 2026-10-31
- [ADR-002](ADR-002-boundary-enforcement.md) — กลไกบังคับ boundary และ dependency matrix · Accepted 2026-10-31
- [ADR-003](ADR-003-minio-image.md) — แหล่ง image ของ MinIO ใน compose · Accepted (ชั่วคราว) 2026-10-31
- [ADR-004](ADR-004-credential-storage.md) — ที่เก็บ secret และการตั้ง credential ของ integration ผ่าน UI · Accepted 2026-10-31
- [ADR-005](ADR-005-auth-session-audit.md) — Auth, session, CSRF, RBAC และ audit log (T-004) · Accepted 2026-11-01
- [ADR-006](ADR-006-outbox.md) — Transactional outbox + relay ใน worker สำหรับ enqueue แบบ at-least-once (T-013) · Accepted 2026-11-01
- [ADR-007](ADR-007-portal-human-verification.md) — Human verification ของ client portal แบบ self-hosted (PoW + honeypot + rate limit) หลัง `HumanVerificationProvider` (T-007) · Accepted 2026-11-01
- [ADR-008](ADR-008-ai-layer.md) — AI layer: ports (`LlmProvider`, `EmbeddingProvider`, `AiRunSink`, `ToolRegistry`, `SettingsSource`), provider adapters, PII redaction ด้วย `RedactedText`, audit record `ai_run` (T-106 a–c) · Accepted 2026-11-01
- [ADR-009](ADR-009-inbound-ingestion-and-domain-package.md) — Inbound ingestion: webhook บางใน api → orchestration ใน worker + workspace ใหม่ `packages/domain` + `inbound_event`/`inbound_message` (แก้ matrix ADR-002, T-122a) · Proposed 2026-11-01
- [ADR-010](ADR-010-outbound-delivery.md) — Outbound delivery ถึงลูกค้าแบบ at-most-once (`outbound_delivery`), undo-send ฝั่ง server, reply-vs-push + LINE quota, policy gate N3 (T-122a/d/e) · Accepted 2026-11-01 (มีเงื่อนไข: T-122f)
- [ADR-011](ADR-011-autonomy-policy-gate.md) — Autonomy stage ต่อ intent + policy gate (`decide()`/`createPolicyGate`) + สวิตช์ฉุกเฉิน 2 ตัว + ceiling stage ≤ 2 ใน DB (T-112a) · Accepted 2026-11-01
- [ADR-013](ADR-013-investigator-drafter-tools.md) — Investigator, drafter และ tools read-only: runbook ที่โค้ดสร้าง (model ไม่เลือก tool), scope จาก intent ที่คนยืนยันหรือ confidence ≥ เกณฑ์ (SR106-R8), budget ใน `tool_execution` นอก handle, role `watchtower_ai_ro` บน view allow-list, disclosure/citation ด้วยโค้ด, approve/edit/reject, KB author ที่ผู้สั่ง AI อนุมัติไม่ได้ (T-108) · Proposed 2026-11-01
- [ADR-012](ADR-012-integration-credential-store.md) — Integration credential store: ตาราง `integration_credential` แยกจาก `channel_account`, envelope encryption (DEK ต่อแถว + KEK จาก HKDF + `KmsPort`), `key_version` + `credentials rotate`, env ชนะ DB, write-only ผ่าน HTTP (แก้ ADR-004, T-116a) · Accepted 2026-11-01
- [ADR-015](ADR-015-connectors-package.md) — workspace `packages/connectors` (client read-only + normalizer ของ alert, fake ก่อน live) แก้ matrix ของ ADR-002 และข้อตกลง alert ingest (idempotency, fingerprint, `closed` ไม่ปิด incident, นาฬิกา DB) (T-200/T-201) · Proposed 2026-11-02
- ADR ใหม่: `ADR-00x-<slug>.md` ตาม `docs/templates/adr.template.md` แล้วเพิ่มบรรทัดที่นี่
- Review records (security/po) เก็บเป็น `T-xxx-review.md` ในโฟลเดอร์นี้
