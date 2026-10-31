import type { Domain, DomainContext, DomainResult, TicketNotifier } from '@watchtower/domain';

import { AuditScope, type AuditActor } from '../audit/audit-scope.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';

/**
 * The context of one domain call: who acts, and where the request came from. The source ip and
 * request id live in the request's `AuditScope` (AsyncLocalStorage), which only the api has; the
 * domain gets them as plain values.
 */
export function domainContext(
  domain: Domain,
  actor: AuditActor,
  notifier?: TicketNotifier,
): DomainContext {
  const meta = AuditScope.current()?.meta;
  return domain.context({
    actor,
    auditMeta: { ip: meta?.ip ?? null, requestId: meta?.requestId ?? null },
    ...(notifier === undefined ? {} : { notifier }),
  });
}

/**
 * Hands what a domain operation produced to the request: realtime events go out after the commit,
 * and an audit row already written in the transaction stops the request's audit interceptor from
 * writing a second one.
 */
export function settle<T>(uow: UnitOfWork, result: DomainResult<T>): T {
  for (const event of result.events) uow.emit(event);
  return markAudited(result);
}

/** For a caller without a `UnitOfWork` (no events to publish): only the audit mark. */
export function markAudited<T>(result: DomainResult<T>): T {
  if (result.audited) AuditScope.set({ persisted: true });
  return result.value;
}
