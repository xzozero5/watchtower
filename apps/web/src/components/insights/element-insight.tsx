'use client';

import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  INSIGHT_ELEMENTS,
  insightStateLabel,
  type AssistantFeedbackReason,
  type InsightElementKey,
  type InsightState,
  type Permission,
} from '@watchtower/shared';
import { Button, Dialog, DialogContent, Skeleton, TintChip, cn, type TintId } from '@watchtower/ui';
import { CirclePause, Clock, History, Layers, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';

import { ClaimLine } from '@/components/claims/claim-line';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { isAssistantWorkspace } from '@/lib/assistant/access';
import { useSession } from '@/lib/auth/session';
import { useInsight } from '@/lib/insights/use-insight';

export interface ElementInsightProps {
  element: InsightElementKey;
  scope?: string;
  period?: string;
  insightId?: string;
  className?: string;
  /** Context-bound action shown after the summary, or alone when no summary is available. */
  followUp?: ReactNode;
}

const STATE_CONFIG: Record<
  InsightState,
  {
    tone: TintId;
    icon: ComponentType<{ className?: string; 'aria-hidden'?: true }>;
  }
> = {
  fresh: { tone: 'teal', icon: Sparkles },
  system: { tone: 'slate', icon: Layers },
  stale: { tone: 'amber', icon: History },
  budget: { tone: 'purple', icon: CirclePause },
  none: { tone: 'slate', icon: Sparkles },
  paused: { tone: 'slate', icon: CirclePause },
};

/**
 * Embedded AI insight for a screen element (T-419a, ADR-029 section 9).
 * Shows the state badge (AC-J17 exact copy), facts/narration sentences with citations, and 👍/👎 feedback.
 * Does not render if the user lacks permissions or if the API returns no insight item for this element.
 */
export function ElementInsight({
  element: key,
  scope,
  period,
  insightId,
  className,
  followUp,
}: ElementInsightProps) {
  const { can, session } = useSession();
  const { t, locale } = useI18n();
  const api = useApi();

  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [showReasonDialog, setShowReasonDialog] = useState(false);
  const [selectedReason, setSelectedReason] = useState<AssistantFeedbackReason>('not_useful');
  const [submitting, setSubmitting] = useState(false);
  const [submittedMessage, setSubmittedMessage] = useState(false);

  const entry = INSIGHT_ELEMENTS[key];
  const isRuleAllowed =
    entry.rule !== null &&
    ('all' in entry.rule
      ? entry.rule.all.every((p: Permission) => can(p))
      : entry.rule.anyOf.some((p: Permission) => can(p)));

  const hasAssistant = can('assistant.use') && isAssistantWorkspace(session);
  const isAllowed = entry.mode !== 'X' && isRuleAllowed && hasAssistant;

  const resolvedScope =
    scope ?? (entry.scope === 'instance' || entry.scope === 'user' ? entry.scope : undefined);
  const resolvedPeriod =
    period ??
    (entry.periods[0]?.kind === 'now'
      ? 'now'
      : entry.periods[0]?.kind === 'none'
        ? '-'
        : undefined);

  const {
    data: item,
    isLoading,
    isError,
  } = useInsight({
    element: key,
    scope: resolvedScope,
    period: resolvedPeriod,
    enabled: isAllowed,
  });

  const fallback = followUp ? (
    <div data-testid="insight-follow-up-fallback" className={cn('flex justify-start', className)}>
      {followUp}
    </div>
  ) : null;

  if (!isAssistantWorkspace(session) || entry.mode === 'X') return null;
  if (!isAllowed) return fallback;

  if (isLoading) {
    return (
      <div
        aria-label={t('insights.elementTitle')}
        aria-busy="true"
        className={cn(
          'flex flex-col gap-2 rounded-inner bg-surface-muted/60 px-3 py-2 text-xs text-muted-foreground motion-safe:animate-rise-in',
          className,
        )}
      >
        <span className="sr-only">{t('insights.loading')}</span>
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-44" />
          <Skeleton variant="pill" className="ml-auto h-4 w-14" />
        </div>
        {followUp}
      </div>
    );
  }

  // Load failure or omitted due to permissions / missing data: do not display (card remains intact)
  if (isError || !item) return fallback;

  const state = item.state;
  const config = STATE_CONFIG[state];
  const generatedAt = item.narration ? new Date(item.narration.generatedAt) : undefined;
  const stateLabel = insightStateLabel(state, locale, generatedAt);

  // QA P0/P1: Never fallback to dummy UUID; only render feedback when narration and targetId exist
  const targetId = item.narration?.id ?? insightId;
  const showFeedback = Boolean(item.narration && targetId);

  const isPersonElement = entry.personRefs !== 'none';
  const availableReasons: AssistantFeedbackReason[] = isPersonElement
    ? ['wrong_number', 'not_useful', 'misleading', 'judges_person', 'other']
    : ['wrong_number', 'not_useful', 'misleading', 'other'];

  const handleUp = async () => {
    if (!targetId || submitting || rating === 'up') return;
    setSubmitting(true);
    try {
      await api.assistantFeedback({
        target: { kind: 'insight', id: targetId },
        rating: 'up',
      });
      setRating('up');
      setSubmittedMessage(true);
    } catch {
      // non-fatal
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownOpen = () => {
    setShowReasonDialog(true);
  };

  const handleDownSubmit = async () => {
    if (!targetId || submitting) return;
    setSubmitting(true);
    try {
      await api.assistantFeedback({
        target: { kind: 'insight', id: targetId },
        rating: 'down',
        reason: selectedReason,
      });
      setRating('down');
      setShowReasonDialog(false);
      setSubmittedMessage(true);
    } catch {
      // non-fatal
    } finally {
      setSubmitting(false);
    }
  };

  // Determine claims to show based on state
  const narrationClaims = item.narration?.claims ?? [];
  const systemClaims = item.claims;

  const primaryClaims =
    state === 'fresh'
      ? narrationClaims.length > 0
        ? narrationClaims
        : systemClaims
      : systemClaims;
  const secondaryClaims = state === 'stale' ? narrationClaims : [];

  return (
    <aside
      aria-label={t('insights.elementTitle')}
      data-testid="element-insight"
      data-element={key}
      data-state={state}
      className={cn(
        'flex flex-col gap-2 rounded-inner bg-surface-muted/40 p-3 text-sm text-foreground ring-1 ring-border/50 motion-safe:animate-rise-in',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span data-testid="insight-state-badge" data-state={state}>
            <TintChip tone={config.tone} icon={config.icon}>
              {stateLabel}
            </TintChip>
          </span>
          {item.narration?.mock && <TintChip tone="slate">{t('insights.sample')}</TintChip>}
        </div>

        {/* Feedback Controls (QA P1: only shown when AI narration with valid targetId exists) */}
        {showFeedback && (
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={t('insights.feedback.title')}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="insight-feedback-up"
              aria-label={t('insights.feedback.helpful')}
              title={t('insights.feedback.helpful')}
              disabled={submitting}
              onClick={() => {
                void handleUp();
              }}
              className={cn(
                'h-7 px-2 text-xs',
                rating === 'up' && 'text-primary font-medium bg-primary-subtle',
              )}
            >
              <ThumbsUp aria-hidden className="size-3.5" />
              <span className="sr-only">{t('insights.feedback.helpful')}</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="insight-feedback-down"
              aria-label={t('insights.feedback.notHelpful')}
              title={t('insights.feedback.notHelpful')}
              disabled={submitting}
              onClick={handleDownOpen}
              className={cn(
                'h-7 px-2 text-xs',
                rating === 'down' && 'text-danger font-medium bg-danger-subtle',
              )}
            >
              <ThumbsDown aria-hidden className="size-3.5" />
              <span className="sr-only">{t('insights.feedback.notHelpful')}</span>
            </Button>

            {submittedMessage && (
              <span className="text-xs text-muted-foreground ml-1" data-testid="feedback-submitted">
                {t('insights.feedback.submitted')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Accessible Feedback Dialog (Radix Focus trap, Escape to close, WCAG 4.1.2 radiogroup label) */}
      {showFeedback && (
        <Dialog open={showReasonDialog} onOpenChange={setShowReasonDialog}>
          <DialogContent
            title={t('insights.feedback.title')}
            description={t('insights.feedback.reasonPrompt')}
            closeLabel={t('insights.feedback.cancel')}
            data-testid="insight-feedback-dialog"
            footer={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowReasonDialog(false);
                  }}
                >
                  {t('insights.feedback.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={submitting}
                  data-testid="feedback-reason-submit"
                  onClick={() => {
                    void handleDownSubmit();
                  }}
                >
                  {t('insights.feedback.submit')}
                </Button>
              </>
            }
          >
            <div id={`feedback-prompt-${key}`} className="sr-only">
              {t('insights.feedback.reasonPrompt')}
            </div>
            <div
              role="radiogroup"
              aria-labelledby={`feedback-prompt-${key}`}
              aria-label={t('insights.feedback.reasonPrompt')}
              className="flex flex-col gap-2.5"
            >
              {availableReasons.map((reasonKey) => (
                <label
                  key={reasonKey}
                  className="flex items-center gap-2 cursor-pointer text-sm text-foreground hover:text-foreground-strong"
                >
                  <input
                    type="radio"
                    name={`feedback-reason-${key}`}
                    value={reasonKey}
                    checked={selectedReason === reasonKey}
                    onChange={() => {
                      setSelectedReason(reasonKey);
                    }}
                    className="size-4 text-primary"
                  />
                  <span>{t(`insights.feedback.reasons.${reasonKey}`)}</span>
                </label>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Sentences with citations */}
      {primaryClaims.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {primaryClaims.map((claim, index) => (
            <ClaimLine key={`${claim.text.slice(0, 20)}-${String(index)}`} claim={claim} />
          ))}
        </ul>
      ) : item.facts.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {item.facts.map((fact) => (
            <li key={fact.id} className="flex items-center gap-1.5">
              <span className="size-1 rounded-full bg-muted-foreground/60" />
              <span>{fact.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Stale previous narration below badge / notice */}
      {state === 'stale' && secondaryClaims.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/40 pt-2 mt-1 text-xs text-muted-foreground">
          <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Clock aria-hidden className="size-3" />
            {t('insights.predatesNotice')}
          </p>
          <ul className="flex flex-col gap-1.5">
            {secondaryClaims.map((claim, index) => (
              <ClaimLine key={`stale-${claim.text.slice(0, 20)}-${String(index)}`} claim={claim} />
            ))}
          </ul>
        </div>
      )}
      {followUp ? (
        <div data-testid="insight-follow-up" className="flex border-t border-border/50 pt-2">
          {followUp}
        </div>
      ) : null}
    </aside>
  );
}
