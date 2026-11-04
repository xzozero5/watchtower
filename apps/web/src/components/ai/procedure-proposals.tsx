'use client';

import type { ProcedureProposal } from '@watchtower/shared';
import { Alert, Button, Skeleton, TintChip } from '@watchtower/ui';
import { Check, CircleSlash, Clock } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { useApplyProcedureProposal, useProcedureProposals } from '@/lib/ai/queries';
import { isApiError } from '@/lib/api/errors';

/**
 * The cards a procedure step `escalate` left on the ticket (T-303f, ADR-026 sections 7 and 10), in the AI
 * sidebar. Nothing is done until a person presses Apply: one press, no dialog (it is a plain ticket change that
 * the audit log records), and focus is never moved to the button when a card appears, so a stray Enter cannot
 * press it (the same rule as the assistant's cards, ADR-023). A card that was applied or has expired says so.
 */
export function ProcedureProposals({
  ticketKey,
  enabled,
  canApply,
}: {
  ticketKey: string;
  /** The report says a procedure step proposed something. */
  enabled: boolean;
  canApply: boolean;
}) {
  const { t } = useI18n();
  const query = useProcedureProposals(ticketKey, enabled);
  const apply = useApplyProcedureProposal(ticketKey);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  if (!enabled) return null;
  if (query.isPending) {
    return (
      <div role="status">
        <span className="sr-only">{t('ai.procedure.loading')}</span>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.isError) {
    // A role that may not read tickets (a developer) is not told of a failure: there is simply nothing for them.
    if (isApiError(query.error) && query.error.status === 403) return null;
    return <p className="text-xs text-muted-foreground">{t('ai.procedure.unavailable')}</p>;
  }
  const items = query.data.items;
  if (items.length === 0) return null;

  const press = (card: ProcedureProposal) => {
    setBusy(card.id);
    setErrors((current) => ({ ...current, [card.id]: '' }));
    apply.mutate(card.id, {
      onSuccess: (result) => {
        setOutcomes((current) => ({
          ...current,
          [card.id]: result.alreadyApplied
            ? t('ai.procedure.alreadyApplied')
            : result.action === 'moved_queue'
              ? t('ai.procedure.appliedQueue')
              : result.notified > 0
                ? t('ai.procedure.appliedRole', { count: result.notified })
                : t('ai.procedure.appliedRoleNone'),
        }));
      },
      onError: (failure) => {
        const message =
          isApiError(failure) && failure.status === 409
            ? t('ai.procedure.expired')
            : isApiError(failure) && failure.status === 403
              ? t('ai.procedure.forbidden')
              : t('ai.procedure.failed');
        setErrors((current) => ({ ...current, [card.id]: message }));
      },
      onSettled: () => {
        setBusy(null);
      },
    });
  };

  return (
    <section
      aria-label={t('ai.procedure.title')}
      data-testid="procedure-proposals"
      className="flex flex-col gap-2"
    >
      {items.map((card) => (
        <ProposalCard
          key={card.id}
          card={card}
          canApply={canApply}
          busy={busy === card.id}
          disabled={busy !== null}
          outcome={outcomes[card.id] ?? null}
          error={errors[card.id] ?? null}
          onApply={() => {
            press(card);
          }}
        />
      ))}
    </section>
  );
}

function ProposalCard({
  card,
  canApply,
  busy,
  disabled,
  outcome,
  error,
  onApply,
}: {
  card: ProcedureProposal;
  canApply: boolean;
  busy: boolean;
  disabled: boolean;
  outcome: string | null;
  error: string | null;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const titleId = `procedure-proposal-${card.id}`;
  const toQueue = 'queueKey' in card.to;
  const role = 'role' in card.to ? card.to.role : null;
  const title = toQueue
    ? t('ai.procedure.queue', { queue: 'queueKey' in card.to ? card.to.queueKey : '' })
    : t(role === 'head' ? 'ai.procedure.role_head' : 'ai.procedure.role_lead');
  const done = card.status === 'applied' || outcome !== null;

  return (
    <article
      aria-labelledby={titleId}
      data-testid="procedure-proposal"
      className="flex flex-col gap-1.5 rounded-card bg-surface p-3 ring-1 ring-border ring-inset"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 id={titleId} className="text-sm font-semibold text-foreground">
          {title}
        </h4>
        <TintChip tone="violet" className="shrink-0">
          {t('ai.procedure.label')}
        </TintChip>
      </div>
      <p className="text-xs text-muted-foreground">
        {toQueue ? t('ai.procedure.queueHint') : t('ai.procedure.roleHint', { role: role ?? '' })}
      </p>
      {card.priority ? (
        <p className="text-sm text-foreground">
          {t('ai.procedure.priority', { priority: card.priority })}
        </p>
      ) : null}
      {card.note !== '' ? (
        <p className="rounded-md bg-surface-muted p-2 text-sm break-words whitespace-pre-wrap text-foreground">
          <span className="sr-only">{t('ai.procedure.note')}: </span>
          {card.note}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-success">
          <Check aria-hidden className="size-4 shrink-0" />
          {outcome ?? t('ai.procedure.applied')}
        </p>
      ) : card.status === 'expired' ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock aria-hidden className="size-4 shrink-0" />
          {t(`ai.procedure.expired_${card.expiredReason ?? 'version_changed'}`)}
        </p>
      ) : canApply ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={disabled} onClick={onApply}>
            {busy ? t('ai.procedure.applying') : t('ai.procedure.apply')}
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleSlash aria-hidden className="size-3.5 shrink-0" />
          {t('ai.procedure.cannot')}
        </p>
      )}
      {error ? <Alert tone="error" title={error} /> : null}
    </article>
  );
}
