import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { readCeoExternalTiles, readCeoView } from '@watchtower/domain';
import type { CeoExternalTile, CeoPoint, CeoView } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import { forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { SeedFilter } from './seed-filter.js';

type Config = Pick<ApiConfig, 'CEO_MINUTES_SAVED_PER_AI_TICKET' | 'CEO_STAFF_COST_USD_PER_HOUR'>;

/**
 * The CEO view (PRD 9.2, T-305b): the figures are read by `readCeoView` in the domain, the same code the
 * weekly brief of the worker uses (T-305c); this service adds the access rule and the pluggable tiles' writes.
 * Read only, except the head's data points for the pluggable tiles (audited).
 */
@Injectable()
export class CeoViewService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(SeedFilter) private readonly seed: SeedFilter,
  ) {}

  /** The clock; a test replaces it. */
  now: () => Date = () => new Date();

  async read(days: number, principal: Principal): Promise<CeoView> {
    if (principal.orgScope.kind !== 'all') throw forbidden();
    return readCeoView(this.database.db, {
      now: this.now(),
      days,
      minutesPerTicket: this.config.CEO_MINUTES_SAVED_PER_AI_TICKET,
      staffCostUsdPerHour: this.config.CEO_STAFF_COST_USD_PER_HOUR ?? null,
      seed: this.seed,
    });
  }

  /** The newest point of each pluggable tile and the one before it. */
  externalTiles(): Promise<CeoExternalTile[]> {
    return readCeoExternalTiles(this.database.db);
  }

  /** Records points (a repeat of a metric and instant replaces the value). Returns how many were written. */
  async recordPoints(
    points: readonly CeoPoint[],
    source: 'api' | 'csv',
    userId: string,
  ): Promise<number> {
    await this.database.db.transaction(async (tx) => {
      for (const point of points) {
        await tx
          .insert(schema.ceoExternalPoint)
          .values({
            metricKey: point.key,
            label: point.label,
            unit: point.unit,
            higherIsBetter: point.higherIsBetter,
            value: point.value,
            observedAt: new Date(point.observedAt),
            source,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [schema.ceoExternalPoint.metricKey, schema.ceoExternalPoint.observedAt],
            set: {
              label: point.label,
              unit: point.unit,
              higherIsBetter: point.higherIsBetter,
              value: point.value,
              source,
              createdBy: userId,
            },
          });
      }
    });
    return points.length;
  }

  async deleteMetric(key: string): Promise<void> {
    const removed = await this.database.db
      .delete(schema.ceoExternalPoint)
      .where(and(eq(schema.ceoExternalPoint.metricKey, key)))
      .returning({ id: schema.ceoExternalPoint.id });
    if (removed.length === 0) throw notFound('No such tile');
  }
}
