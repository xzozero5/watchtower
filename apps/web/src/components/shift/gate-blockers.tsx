'use client';

import type { HandoffIncomplete } from '@watchtower/shared';

import { AppLink } from '@/components/app-link';
import { PriorityBadge } from '@/components/shift/shift-bits';
import { useT } from '@/i18n/provider';
import { BLOCKER_CAUSE_KEYS, BLOCKER_REASON_KEYS, nextActionFieldId } from '@/lib/shifts/model';

/**
 * What AC-7 says is missing, one line per ticket: the key (a link to its field in the handoff),
 * the priority as icon + code + word, why it blocks, and for a ticket the person moved away or
 * downgraded, why it still counts.
 */
export function GateBlockers({ gate }: { gate: HandoffIncomplete }) {
  const t = useT();
  if (gate.blockers.length === 0) return null;
  return (
    <ul aria-label={t('shift.gate.listLabel')} className="flex flex-col gap-1 text-sm">
      {gate.blockers.map((blocker) => (
        <li
          key={`${blocker.ticketId}-${blocker.reason}`}
          className="flex flex-wrap items-center gap-x-2"
        >
          <AppLink
            href={`/shift/handoff#${nextActionFieldId(blocker.ticketId)}`}
            className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {blocker.key}
          </AppLink>
          <PriorityBadge priority={blocker.priority} />
          <span>{t(BLOCKER_REASON_KEYS[blocker.reason])}</span>
          {blocker.cause ? (
            <span className="text-muted-foreground">— {t(BLOCKER_CAUSE_KEYS[blocker.cause])}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
