import { sql } from 'drizzle-orm';

/**
 * The database clock at the moment the statement runs. Every time the alert code decides with (is a
 * step due, is a snooze over, is a roster window open, is a heartbeat late) is compared with this and
 * nothing else, so a process whose clock is off cannot page too early or too late (ADR-015 section 2,
 * STATUS lesson of T-122: one clock per comparison).
 */
export const dbNow = sql`clock_timestamp()`;
