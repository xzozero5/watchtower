/**
 * Malware scan, retention and clean-up of uploaded files (T-155, ADR-022): this feature's own audit
 * actions, ticket event types and queue names (T-123a).
 *
 * Browser-safe (no Node imports).
 */
import { z } from 'zod';

/** Audit `action` strings written by this feature. */
export const UPLOADS_AUDIT_ACTIONS = {
  /** A file was found infected and removed from the object store (the record keeps the signature name). */
  uploadScanInfected: 'upload.scan_infected',
  /** The scanner could not give an answer for a file after every retry (the file stays unserved). */
  uploadScanFailed: 'upload.scan_failed',
  /** Daily clean-up: unattached staff uploads and expired customer files that were deleted. */
  uploadSwept: 'upload.swept',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const UPLOADS_TICKET_EVENTS = {
  /** A file attached to this ticket was found infected and removed (internal; name and signature only). */
  attachmentInfected: 'ticket.attachment_infected',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer and consumer: worker). */
export const UPLOADS_QUEUES = {
  scan: 'scan',
} as const satisfies Record<string, string>;

export const SCAN_JOBS = {
  /** Enrols stored files that have no scan row, then scans the ones that are due. */
  tick: 'tick',
  /** Daily: deletes unattached staff uploads and files past the retention. */
  housekeeping: 'housekeeping',
} as const;

export const UPLOAD_SCAN_MODES = ['off', 'clamav'] as const;
export type UploadScanMode = (typeof UPLOAD_SCAN_MODES)[number];

/** How a stored file stands with the scanner, as the api tells the page. `unscanned` = the mode is off. */
export const UPLOAD_SCAN_STATES = ['unscanned', 'pending', 'clean', 'infected', 'error'] as const;
export type UploadScanState = (typeof UPLOAD_SCAN_STATES)[number];

/** Seconds between two scan ticks. `[ASSUMED]` 10: a new file waits a few seconds before it can be opened. */
export const SCAN_TICK_SECONDS = 10;
/** Files scanned per tick, so one tick stays short and the next one carries on. */
export const SCAN_BATCH_SIZE = 20;
/** Tries before a file is left at `error` for a person to look at; backoff doubles from 30 s up to 1 h. */
export const SCAN_MAX_ATTEMPTS = 8;
/** A staff upload that nothing refers to after this many hours is an orphan (the person never sent the note). */
export const STAFF_UPLOAD_ORPHAN_HOURS = 24;

/** `GET /v1/admin/upload-scan`: what an admin sees about the malware scan. `notice` is set when files are NOT being scanned. */
export const uploadScanSummarySchema = z.object({
  mode: z.enum(UPLOAD_SCAN_MODES),
  notice: z.enum(['scan_off']).nullable(),
  counts: z.object({
    pending: z.number().int().min(0),
    clean: z.number().int().min(0),
    infected: z.number().int().min(0),
    error: z.number().int().min(0),
  }),
});
export type UploadScanSummary = z.infer<typeof uploadScanSummarySchema>;
