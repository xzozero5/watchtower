'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import type { AiEvidenceKind, TicketAiInsight } from '@watchtower/shared';
import { Button, cn, Skeleton, Tooltip } from '@watchtower/ui';
import {
  Bot,
  Database,
  Eye,
  FileText,
  GitCommitHorizontal,
  Lightbulb,
  type LucideIcon,
  ScrollText,
  Tag,
  Ticket,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';

import { AiStateChip } from '@/components/ai/ai-state-chip';
import { useStatusMove } from '@/components/ticket/use-status-move';
import { useI18n } from '@/i18n/provider';
import { confidenceBand, formatConfidence, hasBrief } from '@/lib/ai/model';
import { formatAge, formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import type { TicketItem } from '@/lib/tickets/model';

import { AiDraftCard } from './ai-draft';

export const EVIDENCE_ICONS: Record<AiEvidenceKind, LucideIcon> = {
  kb: FileText,
  ticket: Ticket,
  log: ScrollText,
  data: Database,
  repo: GitCommitHorizontal,
};

const STAGES = {
  0: { icon: Eye, key: 'ai.stage.0' },
  1: { icon: Lightbulb, key: 'ai.stage.1' },
  2: { icon: UserCheck, key: 'ai.stage.2' },
} as const;

/**
 * The autonomy stage in force (PRD section 6.4) as an icon and words. Phase 1 renders stages 0 to
 * 2 only: a higher number from the api draws nothing. A small local copy of the spec's
 * `StageBadge`; fold it into `packages/ui` when that component lands.
 */
export function StageBadge({ stage }: { stage: number }) {
  const { t } = useI18n();
  if (stage !== 0 && stage !== 1 && stage !== 2) return null;
  const { icon: Icon, key } = STAGES[stage];
  return (
    <Tooltip content={t('ai.stage.tip')}>
      <span
        data-stage={stage}
        className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-foreground"
      >
        <Icon aria-hidden className="size-3.5" />
        {t(key)}
      </span>
    </Tooltip>
  );
}

/** A confidence as a short bar plus the word and the number (`High 0.86`): never the bar alone. */
export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const { t } = useI18n();
  const band = confidenceBand(value);
  const text = t('ai.brief.confidence', {
    band: t(`ai.brief.band.${band}`),
    value: formatConfidence(value),
  });
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)} data-band={band}>
      <span
        role="meter"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={value}
        className="relative h-1.5 w-12 overflow-hidden rounded-full bg-surface-muted ring-1 ring-border-strong ring-inset"
      >
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            band === 'low' ? 'bg-muted-foreground' : 'bg-ai-accent',
          )}
          style={{ width: `${String(Math.round(value * 100))}%` }}
        />
      </span>
      <span aria-hidden className="tabular font-medium text-foreground">
        {t(`ai.brief.band.${band}`)} {formatConfidence(value)}
      </span>
    </span>
  );
}

function Provenance({ insight }: { insight: TicketAiInsight }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const version = insight.draft?.promptVersion;
  const text = [
    'AI',
    version ? t('ai.brief.prompt', { version }) : null,
    formatAge(insight.generatedAt, now, locale) ?? t('timeline.now'),
  ]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <time
      dateTime={insight.generatedAt}
      title={formatDateTime(insight.generatedAt, locale)}
      className="text-xs text-muted-foreground"
    >
      {text}
    </time>
  );
}

/** One line for the cases where there is no card: loading, unavailable, not looked at. */
function Quiet({ children, status = false }: { children: string; status?: boolean }) {
  return (
    <p
      role={status ? 'status' : undefined}
      className="mx-4 mt-3 flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Bot aria-hidden className="size-4 shrink-0" />
      {children}
    </p>
  );
}

/**
 * The AI brief and its draft: the focal point of an open ticket
 * (docs/design/ai-first-workspace.md section 3). It only shows what the api sent (N5): no
 * answer from `GET /v1/tickets/:id/ai` means one muted line, "AI brief unavailable", and nothing
 * that looks like AI content. With a brief it shows
 *  - what is happening, the intent with a confidence meter and the reason, a warning when the
 *    confidence is low;
 *  - one primary next step (a button for the kinds the app can do) and "Write myself";
 *  - evidence chips (each opens the Evidence tab), an uncited-claims flag, provenance and stage;
 *  - the draft with Approve / Edit / Reject when there is one.
 */
export function AiBrief({
  ticket,
  query,
  canReview,
  canWrite,
  onOpenEvidence,
  onWriteMyself,
}: {
  ticket: TicketItem;
  query: UseQueryResult<TicketAiInsight>;
  canReview: boolean;
  canWrite: boolean;
  onOpenEvidence: (id: string) => void;
  onWriteMyself: () => void;
}) {
  const { t } = useI18n();
  const status = useStatusMove(ticket);
  const [approveOpen, setApproveOpen] = useState(false);

  if (query.isPending) {
    return (
      <div role="status" className="mx-4 mt-3">
        <span className="sr-only">{t('ai.brief.loading')}</span>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.isError) return <Quiet>{t('ai.brief.unavailable')}</Quiet>;

  const insight = query.data;
  if (!hasBrief(insight)) return <Quiet>{t('ai.brief.none')}</Quiet>;

  const { intent, nextStep, draft, evidence } = insight;
  const lowConfidence = intent !== undefined && confidenceBand(intent.confidence) === 'low';
  const uncited = draft?.uncitedClaims ?? 0;

  // The one suggested step becomes a button only for the kinds the app can carry out.
  const stepTarget =
    nextStep?.kind === 'escalate_dev'
      ? 'waiting_on_dev'
      : nextStep?.kind === 'wait_customer'
        ? 'waiting_on_customer'
        : nextStep?.kind === 'resolve'
          ? 'resolved'
          : null;
  const stepAction: (() => void) | null = !nextStep
    ? null
    : nextStep.kind === 'approve_draft'
      ? draft && canReview
        ? () => {
            setApproveOpen(true);
          }
        : null
      : nextStep.kind === 'reply'
        ? onWriteMyself
        : stepTarget !== null && status.can(stepTarget)
          ? () => {
              status.move(stepTarget);
            }
          : null;

  return (
    <>
      <section
        aria-label={t('ai.brief.label')}
        data-testid="ai-brief"
        data-ai-state={insight.state}
        className="mx-4 mt-3 flex flex-col gap-2.5 rounded-lg border border-ai-accent/50 bg-surface px-3 py-3"
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Bot aria-hidden className="size-4 text-ai-accent" />
          <AiStateChip state={insight.state} />
          <StageBadge stage={insight.stage} />
          {uncited > 0 ? (
            <span
              title={t('ai.brief.uncitedTip')}
              className="inline-flex h-5 items-center gap-1 rounded-full border border-border-strong px-2 text-xs font-medium"
            >
              <TriangleAlert aria-hidden className="size-3.5" />
              {t('ai.brief.uncited', { count: uncited })}
            </span>
          ) : null}
          <span className="ml-auto">
            <Provenance insight={insight} />
          </span>
        </header>

        {insight.summary ? (
          <p className="max-w-[72ch] text-sm text-foreground">{insight.summary}</p>
        ) : null}

        {insight.state === 'failed' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('ai.brief.failed')}
          </p>
        ) : null}

        {intent ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              title={t('ai.brief.intent')}
              className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium"
            >
              <Tag aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="sr-only">{t('ai.brief.intent')}: </span>
              {intent.key}
            </span>
            <ConfidenceMeter value={intent.confidence} />
            <span className="min-w-0 text-xs text-muted-foreground">{intent.reason}</span>
          </div>
        ) : null}
        {lowConfidence ? (
          <p
            role="status"
            className="flex items-center gap-1.5 text-xs font-medium text-foreground"
          >
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {t('ai.brief.lowConfidence')}
          </p>
        ) : null}

        {nextStep || canWrite ? (
          <div role="group" aria-label={t('ai.brief.nextStep')} className="flex flex-wrap gap-2">
            {nextStep && stepAction ? (
              <Button variant="primary" onClick={stepAction}>
                {nextStep.label}
              </Button>
            ) : nextStep ? (
              <p className="self-center text-sm font-medium text-foreground">{nextStep.label}</p>
            ) : null}
            {canWrite ? <Button onClick={onWriteMyself}>{t('ai.brief.writeMyself')}</Button> : null}
          </div>
        ) : null}

        {evidence.length > 0 ? (
          <ul aria-label={t('ai.brief.evidence')} className="flex flex-wrap gap-1.5">
            {evidence.map((entry) => {
              const Icon = EVIDENCE_ICONS[entry.kind];
              const kind = t(`ai.evidence.kinds.${entry.kind}`);
              const value = formatConfidence(entry.confidence);
              return (
                <li key={entry.id} className="min-w-0">
                  <button
                    type="button"
                    data-evidence={entry.id}
                    onClick={() => {
                      onOpenEvidence(entry.id);
                    }}
                    className="inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-surface px-2 text-xs transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  >
                    <Icon aria-hidden className="size-3.5 shrink-0 text-ai-accent" />
                    <span className="sr-only">{kind}:</span>{' '}
                    <span className="truncate">{entry.title}</span>{' '}
                    <span className="tabular shrink-0 text-muted-foreground">{value}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {draft && canReview ? (
        <AiDraftCard
          key={draft.id}
          ticket={ticket}
          draft={draft}
          onOpenEvidence={onOpenEvidence}
          approveOpen={approveOpen}
          onApproveOpenChange={setApproveOpen}
        />
      ) : null}
    </>
  );
}
