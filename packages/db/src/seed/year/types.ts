import type { BusinessCalendar, SlaTargets } from '@watchtower/shared';

import type { ShiftDef } from './roster.js';

/** A row in database column names (snake_case), values as the JSON the bulk insert sends. */
export type Row = Record<string, unknown>;

export interface PolicyRef {
  readonly id: string;
  readonly targets: SlaTargets;
  readonly calendar: BusinessCalendar;
}

export interface IntentRef {
  readonly id: string;
  readonly key: string;
  readonly defaultPriority: string;
  readonly autonomyStage: number;
}

/** What the scenario needs from the reference data the default seed already loaded. */
export interface Reference {
  readonly policies: Readonly<Record<'gold' | 'silver' | 'standard', PolicyRef>>;
  readonly intents: readonly IntentRef[];
  readonly queues: Readonly<Record<'Support' | 'Integrations' | 'Billing', string>>;
  readonly channelAccounts: {
    readonly gmail: string;
    readonly line: string;
    readonly portal: string;
  };
  readonly shifts: readonly ShiftDef[];
  /** `YYYY-MM-DD` of public holidays (from the default business calendar). */
  readonly holidays: ReadonlySet<string>;
  readonly ticketKeyPrefix: string;
}

export interface YearOptions {
  /** "Today": the scenario covers the 365 days before it. */
  readonly now: Date;
  /** Seed of the pseudo-random stream; the same value gives the same data. */
  readonly seed?: number;
  /** Approximate number of tickets (3 000 to 5 000). */
  readonly ticketTarget?: number;
  /** Write attachment records (needs the files to be in object storage). */
  readonly attachments?: boolean;
}

export interface StoredAttachmentFile {
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Everything the scenario writes, by table, in insertion order. */
export interface YearPlan {
  readonly tables: ReadonlyMap<string, Row[]>;
  /** Files to upload to object storage before the rows that refer to them exist. */
  readonly files: readonly StoredAttachmentFile[];
  readonly summary: Readonly<Record<string, number>>;
}
