import type { Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import type { OpsNotificationKind } from '@watchtower/shared';

import type { WorkerLogger } from './logger.js';
import type { RealtimeSink } from './realtime.js';

export interface OpsNoticeDeps {
  readonly database: Pick<Database, 'db'>;
  readonly domain: Pick<Domain, 'context' | 'notifications'>;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
}

/**
 * Tells the heads in the app that the system needs them (T-176), at most once an hour per kind (the
 * domain keeps that rule). Never throws: the fault being reported is the job's real problem, and a
 * failure to report it must not replace it. Codes and counts only in `data`.
 */
export async function tellHeads(
  deps: OpsNoticeDeps,
  kind: OpsNotificationKind,
  data?: Readonly<Record<string, string | number>>,
): Promise<void> {
  try {
    const notice = await deps.domain.notifications.opsAlert(
      deps.database.db,
      deps.domain.context({ actor: { type: 'system', id: null } }),
      { kind, data },
    );
    for (const event of notice.events) {
      try {
        await deps.realtime.publish(event);
      } catch (error) {
        deps.logger.warn({ err: error, eventType: event.type }, 'realtime publish failed');
      }
    }
  } catch (error) {
    deps.logger.warn({ err: error, kind }, 'the heads could not be notified');
  }
}
