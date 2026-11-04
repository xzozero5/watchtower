import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import { intentGradeMetrics } from '@watchtower/domain';
import type { IntentGradeMetricsResponse } from '@watchtower/shared';

import { DATABASE } from '../database/database.module.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SLACK_MS = 60_000;

/**
 * What the grader found, per intent, over a window (T-301). Read only: it reports numbers and decides
 * nothing; the promotion report and the stage gate (T-304) are built on it.
 */
@Injectable()
export class AiGradesService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** The clock; a test replaces it. */
  now: () => Date = () => new Date();

  async metrics(days: number): Promise<IntentGradeMetricsResponse> {
    // A minute of slack at the end: the database clock and this one do not agree to the millisecond.
    const to = new Date(this.now().getTime() + CLOCK_SLACK_MS);
    const from = new Date(to.getTime() - days * DAY_MS);
    return {
      windowDays: days,
      from: from.toISOString(),
      to: to.toISOString(),
      intents: await intentGradeMetrics(this.database.db, { from, to }),
    };
  }
}
