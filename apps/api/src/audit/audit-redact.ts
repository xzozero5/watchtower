// The implementation moved to @watchtower/shared so packages/domain writes the same redacted audit
// rows as the api (ADR-009). This re-export keeps the api's import paths.
export { REDACTED, redactForAudit } from '@watchtower/shared';
