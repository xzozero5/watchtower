// The implementation moved to @watchtower/db so packages/domain can translate database errors too
// (ADR-009). This re-export keeps the api's import paths.
export { PG, isPgError, pgCode, pgConstraint } from '@watchtower/db';
