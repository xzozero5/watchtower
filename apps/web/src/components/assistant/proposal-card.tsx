'use client';

import type { ProposalCard as ProposalCardData } from '@watchtower/shared';
import { Button, TintChip } from '@watchtower/ui';
import { ArrowRight, Check, CircleSlash, Clock, TriangleAlert } from 'lucide-react';

import { AppLink } from '@/components/app-link';
import { useT } from '@/i18n/provider';
import type { ProposalView } from '@/lib/assistant/use-assistant-chat';

const FIELDS = new Set(['assignee', 'status', 'tags', 'subject', 'priority']);

/**
 * A change the assistant suggests (N2): what will happen, to what, before -> after, all values from
 * the server. One press, no nested dialog. Focus is never moved to the button when the card appears,
 * so a stray Enter cannot confirm it. A reply to a customer is never sent from here: `reply_draft`
 * opens the usual draft review (N3), and the card says so.
 */
export function ProposalCard({
  view,
  onConfirm,
  onReject,
  onOpen,
}: {
  view: ProposalView;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  /** Called after a link inside the app is followed. */
  onOpen?: () => void;
}) {
  const t = useT();
  const { card, busy, outcome, href } = view;
  // What the card says it is now: the press result, or what the server already closed it as.
  const closed =
    outcome ??
    (card.status === 'confirmed'
      ? 'done'
      : card.status === 'rejected'
        ? 'rejected'
        : card.status === 'expired'
          ? 'expired'
          : card.status === 'failed'
            ? 'failed'
            : null);
  const target = card.target;
  const titleId = `proposal-${card.id}`;

  return (
    <section
      aria-labelledby={titleId}
      data-testid="assistant-proposal"
      className="flex flex-col gap-2 rounded-card bg-surface p-3 ring-1 ring-border ring-inset"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 id={titleId} className="text-sm font-semibold text-foreground">
          {t(`assistant.proposal.kind.${card.kind}`)}
        </h4>
        <TintChip tone="violet" className="shrink-0">
          {t('assistant.proposal.label')}
        </TintChip>
      </div>

      {target ? (
        target.href.startsWith('/') ? (
          <AppLink
            href={target.href}
            onClick={onOpen}
            className="w-fit max-w-full truncate rounded-sm text-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {target.label}
          </AppLink>
        ) : (
          <span className="text-sm text-foreground">{target.label}</span>
        )
      ) : null}

      {card.changes.length > 0 ? (
        <dl className="flex flex-col gap-1 text-sm">
          {card.changes.map((change, index) => (
            <div
              key={`${change.field}-${String(index)}`}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <dt className="text-xs font-medium text-muted-foreground">
                {FIELDS.has(change.field)
                  ? t(
                      `assistant.proposal.field.${change.field}` as 'assistant.proposal.field.status',
                    )
                  : change.field || t('assistant.proposal.field.other')}
              </dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1 text-foreground">
                <span className="text-muted-foreground">
                  {change.from ?? t('assistant.proposal.none')}
                </span>
                <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="sr-only">{t('assistant.proposal.arrow')}</span>
                <span className="font-medium break-words">
                  {change.to ?? t('assistant.proposal.none')}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {card.text !== undefined && card.text !== '' ? (
        <p className="rounded-md bg-surface-muted p-2 text-sm break-words whitespace-pre-wrap text-foreground">
          {card.text}
        </p>
      ) : null}

      {card.kind === 'reply_draft' ? (
        <p className="text-xs text-muted-foreground">{t('assistant.proposal.replyNote')}</p>
      ) : null}

      {closed === null ? (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              onConfirm(card.id);
            }}
          >
            {busy ? t('assistant.proposal.working') : t('assistant.proposal.confirm')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onReject(card.id);
            }}
          >
            {t('assistant.proposal.reject')}
          </Button>
        </div>
      ) : (
        <Closed closed={closed} href={href} card={card} onOpen={onOpen} />
      )}
    </section>
  );
}

function Closed({
  closed,
  href,
  card,
  onOpen,
}: {
  closed: NonNullable<ProposalView['outcome']>;
  href: string | null;
  card: ProposalCardData;
  onOpen: (() => void) | undefined;
}) {
  const t = useT();
  const good = closed === 'done';
  const Icon = good
    ? Check
    : closed === 'expired'
      ? Clock
      : closed === 'rejected'
        ? CircleSlash
        : TriangleAlert;
  const link = href ?? card.target?.href ?? null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-foreground">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
      <span>{t(`assistant.proposal.${closed}`)}</span>
      {good && link !== null && link.startsWith('/') ? (
        <AppLink
          href={link}
          onClick={onOpen}
          className="rounded-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t('assistant.proposal.open')}
        </AppLink>
      ) : null}
    </p>
  );
}
