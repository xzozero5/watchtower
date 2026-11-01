'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import type { AiProgress, TicketAiInsight } from '@watchtower/shared';
import {
  Button,
  IconButton,
  IntentChip,
  Skeleton,
  StageBadge,
  TintChip,
  toast,
  Tooltip,
} from '@watchtower/ui';
import {
  ArrowUpRight,
  Bot,
  Check,
  CircleCheck,
  Hourglass,
  type LucideIcon,
  PauseCircle,
  PenLine,
  RefreshCw,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

import { AiStateChip } from '@/components/ai/ai-state-chip';
import { usePreferences } from '@/lib/preferences';
import { useStatusMove } from '@/components/ticket/use-status-move';
import { useI18n } from '@/i18n/provider';
import { useAutonomy } from '@/lib/admin/queries';
import { confidenceBand, formatConfidence, hasBrief } from '@/lib/ai/model';
import { useAiRequest } from '@/lib/ai/queries';
import { isApiError } from '@/lib/api/errors';
import { formatAge, formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import type { TicketItem } from '@/lib/tickets/model';

import { AiDraftCard } from './ai-draft';
import { AiReportDetails } from './ai-report';
import { ConfidenceMeter } from './confidence-meter';
import { EVIDENCE_ICONS } from './evidence-icons';

const STAGE_KEYS = { 0: 'ai.stage.0', 1: 'ai.stage.1', 2: 'ai.stage.2' } as const;

/**
 * The autonomy stage in force (PRD section 6.4), with its tooltip. Phase 1 renders stages 0 to 2
 * only: a higher number from the api draws nothing (`StageBadge` in `packages/ui` has no value
 * for it).
 */
export function AiStageBadge({ stage }: { stage: number }) {
  const { t } = useI18n();
  if (stage !== 0 && stage !== 1 && stage !== 2) return null;
  return (
    <Tooltip content={t('ai.stage.tip')}>
      <StageBadge stage={stage} label={t(STAGE_KEYS[stage])} />
    </Tooltip>
  );
}

/** What the suggested next step does, as an icon on its button. */
const STEP_ICONS: Partial<Record<string, LucideIcon>> = {
  approve_draft: Check,
  reply: Send,
  escalate_dev: ArrowUpRight,
  wait_customer: Hourglass,
  resolve: CircleCheck,
};

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

/** Where a running job is: a named step and a bar, not a spinner (T-108d). */
function Progress({ progress }: { progress: AiProgress }) {
  const { t } = useI18n();
  const label = `${t(`ai.brief.phases.${progress.phase}`)} · ${t('ai.brief.progress', { step: Math.min(progress.step + 1, progress.steps), steps: progress.steps })}`;
  return (
    <div className="flex flex-col gap-1" data-testid="ai-progress">
      <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <RefreshCw aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
        {label}
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={progress.steps}
        aria-valuenow={progress.step}
        className="h-1 max-w-xs overflow-hidden rounded-full bg-border/60"
      >
        <div
          className="h-full bg-ai-accent transition-[width] duration-(--wt-motion-duration-fast)"
          style={{ width: `${String(Math.round((progress.step / progress.steps) * 100))}%` }}
        />
      </div>
    </div>
  );
}

/** One line for the cases where there is no card/** One line for the cases where there is no card: loading, unavailable, not looked at. */
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
  canRequest,
  onOpenEvidence,
  onWriteMyself,
}: {
  ticket: TicketItem;
  query: UseQueryResult<TicketAiInsight>;
  canReview: boolean;
  canWrite: boolean;
  /** May ask the AI for a draft or a new investigation (`ticket.handle`). */
  canRequest: boolean;
  onOpenEvidence: (id: string) => void;
  onWriteMyself: () => void;
}) {
  const { t } = useI18n();
  const { singleKeyShortcuts } = usePreferences();
  const status = useStatusMove(ticket);
  const autonomy = useAutonomy(true);
  const aiRequest = useAiRequest(ticket.key);
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

  const { intent, nextStep, draft, evidence, report, progress } = insight;
  const paused =
    autonomy.data?.switches.some((item) => item.key === 'ai_kill_switch' && item.on) ?? false;
  const running = insight.state === 'investigating' || aiRequest.isPending;
  const canAsk = canRequest && !running && !paused;
  const ask = (kind: 'draft' | 'investigate') => {
    aiRequest.mutate(
      { kind },
      {
        onSuccess: () => {
          toast(t('ai.request.done'));
        },
        onError: (error) => {
          toast(
            isApiError(error) && error.status === 409
              ? t('ai.request.conflict')
              : t('ai.request.failed'),
          );
        },
      },
    );
  };
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
        className="relative mx-4 mt-3 flex shrink-0 flex-col gap-3 overflow-hidden rounded-lg bg-ai-subtle py-4 pr-5 pl-6 shadow-soft ring-1 ring-ai-accent/20 ring-inset"
      >
        {/* The subtle teal edge: 4px, fading toward the bottom. */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-linear-to-b from-ai-accent to-ai-accent/20"
        />
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            aria-hidden
            className="inline-flex size-6 items-center justify-center rounded-full bg-tint-teal-bg text-tint-teal-icon"
          >
            <Bot className="size-3.5" />
          </span>
          <AiStateChip state={insight.state} />
          <AiStageBadge stage={insight.stage} />
          {paused ? (
            <TintChip tone="slate" icon={PauseCircle} title={t('ai.brief.pausedTip')}>
              {t('ai.brief.paused')}
            </TintChip>
          ) : null}
          {uncited > 0 ? (
            <TintChip tone="amber" icon={TriangleAlert} title={t('ai.brief.uncitedTip')}>
              {t('ai.brief.uncited', { count: uncited })}
            </TintChip>
          ) : null}
          <span className="ml-auto">
            <Provenance insight={insight} />
          </span>
        </header>

        {insight.summary ? (
          <p className="max-w-[72ch] text-sm text-foreground">{insight.summary}</p>
        ) : null}

        {progress && insight.state === 'investigating' ? <Progress progress={progress} /> : null}

        {insight.state === 'failed' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('ai.brief.failed')}
          </p>
        ) : null}

        {intent ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span title={t('ai.brief.intent')} className="inline-flex">
              <span className="sr-only">{t('ai.brief.intent')}: </span>
              <IntentChip plain intentKey={intent.key} name={intent.key} />
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
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-tint-amber-icon" />
            {t('ai.brief.lowConfidence')}
          </p>
        ) : null}

        {nextStep || canWrite ? (
          <div role="group" aria-label={t('ai.brief.nextStep')} className="flex flex-wrap gap-2">
            {nextStep && stepAction ? (
              <Button variant="primary" className="rounded-full px-4" onClick={stepAction}>
                {(() => {
                  const StepIcon = STEP_ICONS[nextStep.kind];
                  return StepIcon ? <StepIcon aria-hidden className="size-4" /> : null;
                })()}
                {nextStep.label}
              </Button>
            ) : nextStep ? (
              <p className="self-center text-sm font-medium text-foreground">{nextStep.label}</p>
            ) : null}
            {canWrite ? (
              <IconButton
                variant="secondary"
                label={t('ai.brief.writeMyself')}
                shortcut={singleKeyShortcuts ? ['C'] : []}
                icon={<PenLine aria-hidden className="size-4" />}
                onClick={onWriteMyself}
              />
            ) : null}
          </div>
        ) : null}

        {canRequest ? (
          <div role="group" aria-label={t('ai.request.group')} className="flex flex-wrap gap-2">
            {!draft && insight.stage >= 1 ? (
              <Button
                className="rounded-full"
                disabled={!canAsk}
                onClick={() => {
                  ask('draft');
                }}
              >
                <PenLine aria-hidden className="size-4" />
                {t('ai.request.draft')}
              </Button>
            ) : null}
            <IconButton
              variant="secondary"
              label={t('ai.request.investigate')}
              icon={<RefreshCw aria-hidden className="size-4" />}
              disabled={!canAsk}
              onClick={() => {
                ask('investigate');
              }}
            />
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
                    className="inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-full bg-surface px-2.5 text-xs shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)] transition-[background-color,transform] duration-(--wt-motion-duration-fast) ease-out hover:bg-primary-subtle motion-safe:hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
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

        {report ? <AiReportDetails report={report} evidence={evidence} /> : null}
      </section>

      {draft && canReview ? (
        <AiDraftCard
          key={draft.id}
          ticket={ticket}
          draft={draft}
          evidence={evidence}
          onOpenEvidence={onOpenEvidence}
          approveOpen={approveOpen}
          onApproveOpenChange={setApproveOpen}
        />
      ) : null}
    </>
  );
}
