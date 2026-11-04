import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { UploadScanMode, UploadScanState, UploadScanSummary } from '@watchtower/shared';
import { count, inArray } from 'drizzle-orm';

import { ApiHttpError } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';

/**
 * The api's side of the malware scan (ADR-022). The worker scans; this class only reads the verdicts.
 *
 * With `UPLOAD_SCAN=off` every file is served as before. With `clamav` a file is served only when its
 * `object_scan` row says `clean`: a file with no row, a `pending` one and an `error` one are all "not
 * yet" (fail closed, so a stopped scanner never opens the door), and an `infected` one is gone.
 */
@Injectable()
export class UploadScanGate {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Pick<ApiConfig, 'UPLOAD_SCAN'>,
  ) {}

  get mode(): UploadScanMode {
    return this.config.UPLOAD_SCAN;
  }

  get enabled(): boolean {
    return this.config.UPLOAD_SCAN === 'clamav';
  }

  /** The state of each key. With the scan off, everything is `unscanned` (and served). */
  async states(keys: readonly string[]): Promise<Map<string, UploadScanState>> {
    const wanted = [...new Set(keys)];
    const result = new Map<string, UploadScanState>();
    if (!this.enabled) {
      for (const key of wanted) result.set(key, 'unscanned');
      return result;
    }
    if (wanted.length === 0) return result;
    const rows = await this.database.db
      .select({ key: schema.objectScan.objectKey, status: schema.objectScan.scanStatus })
      .from(schema.objectScan)
      .where(inArray(schema.objectScan.objectKey, wanted));
    const byKey = new Map(rows.map((row) => [row.key, row.status]));
    for (const key of wanted) result.set(key, byKey.get(key) ?? 'pending');
    return result;
  }

  /** Throws unless the file may be handed to a person: 409 while it is being checked, 410 once found infected. */
  async assertServable(key: string): Promise<void> {
    if (!this.enabled) return;
    const state = (await this.states([key])).get(key) ?? 'pending';
    if (state === 'clean') return;
    if (state === 'infected') {
      throw new ApiHttpError(
        HttpStatus.GONE,
        'file_infected',
        'This file was removed because the malware scan found a threat in it',
      );
    }
    throw new ApiHttpError(
      HttpStatus.CONFLICT,
      'scan_pending',
      'This file is still being checked for malware; try again in a moment',
    );
  }

  /** Counts per state for the admin screen; all zero when the scan is off (nothing is tracked then). */
  async summary(): Promise<UploadScanSummary> {
    const counts = { pending: 0, clean: 0, infected: 0, error: 0 };
    if (this.enabled) {
      const rows = await this.database.db
        .select({ status: schema.objectScan.scanStatus, n: count() })
        .from(schema.objectScan)
        .groupBy(schema.objectScan.scanStatus);
      for (const row of rows) counts[row.status] = row.n;
    }
    return {
      mode: this.mode,
      notice: this.enabled ? null : 'scan_off',
      counts,
    };
  }
}
