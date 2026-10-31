# Architecture Decision Records — สารบัญ

- [ADR-001](ADR-001-stack.md) — Tech stack + deployment target (Docker local → GCP) · Accepted 2026-10-31
- [ADR-002](ADR-002-boundary-enforcement.md) — กลไกบังคับ boundary และ dependency matrix · Accepted 2026-10-31
- [ADR-003](ADR-003-minio-image.md) — แหล่ง image ของ MinIO ใน compose · Accepted (ชั่วคราว) 2026-10-31
- [ADR-004](ADR-004-credential-storage.md) — ที่เก็บ secret และการตั้ง credential ของ integration ผ่าน UI · Accepted 2026-10-31
- [ADR-005](ADR-005-auth-session-audit.md) — Auth, session, CSRF, RBAC และ audit log (T-004) · Accepted 2026-11-01
- [ADR-006](ADR-006-outbox.md) — Transactional outbox + relay ใน worker สำหรับ enqueue แบบ at-least-once (T-013) · Accepted 2026-11-01
- [ADR-007](ADR-007-portal-human-verification.md) — Human verification ของ client portal แบบ self-hosted (PoW + honeypot + rate limit) หลัง `HumanVerificationProvider` (T-007) · Accepted 2026-11-01
- [ADR-008](ADR-008-ai-layer.md) — AI layer: ports (`LlmProvider`, `EmbeddingProvider`, `AiRunSink`, `ToolRegistry`, `SettingsSource`), provider adapters, PII redaction ด้วย `RedactedText`, audit record `ai_run` (T-106 a–c) · Proposed 2026-11-01
- ADR ใหม่: `ADR-00x-<slug>.md` ตาม `docs/templates/adr.template.md` แล้วเพิ่มบรรทัดที่นี่
- Review records (security/po) เก็บเป็น `T-xxx-review.md` ในโฟลเดอร์นี้
