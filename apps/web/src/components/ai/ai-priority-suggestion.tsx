'use client';

import type { AiPrioritySuggestion, TicketPriority } from '@watchtower/shared';
import { Button, toast } from '@watchtower/ui';
import { Flag } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { formatConfidence } from '@/lib/ai/model';
import { isApiError } from '@/lib/api/errors';
import { useTicketMutations } from '@/lib/tickets/queries';

import { AiProse } from './ai-prose';

/**
 * A priority the AI proposes (T-147, QA-29). The ticket does not change by itself (N2, N3): the person
 * accepts it, and that goes through the same ticket update as any edit, so the event log and the audit
 * record who changed it (with `source: 'ai_suggestion'` and the AI run, T-175a). Nothing shows when the AI
 * agrees with the current priority. A move to P1 pages people, so it asks one more time before it is sent.
 */
export function AiPrioritySuggestionRow({
  ticketKey,
  current,
  suggestion,
  aiRunId,
  canAccept,
}: {
  ticketKey: string;
  current: TicketPriority;
  suggestion: AiPrioritySuggestion;
  /** The AI run the brief came from, for the audit log. */
  aiRunId?: string | undefined;
  canAccept: boolean;
}) {
  const { t } = useI18n();
  const { update } = useTicketMutations(ticketKey);
  const [confirming, setConfirming] = useState(false);
  if (suggestion.priority === current) return null;

  const apply = () => {
    setConfirming(false);
    update.mutate(
      {
        priority: suggestion.priority,
        source: 'ai_suggestion',
        ...(aiRunId === undefined ? {} : { aiRunId }),
      },
      {
        onSuccess: () => {
          toast(t('ai.priority.done', { priority: suggestion.priority }));
        },
        onError: (error) => {
          toast(
            isApiError(error) && error.status === 403
              ? t('ai.priority.forbidden')
              : t('ai.priority.failed'),
          );
        },
      },
    );
  };
  // Raising to P1 is the one change that wakes people up: ask once more.
  const needsConfirm = suggestion.priority === 'P1';

  return (
    <div
      data-testid="ai-priority-suggestion"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
    >
      <Flag aria-hidden className="size-3.5 shrink-0 text-ai-accent" />
      <span className="font-medium text-foreground">
        {t('ai.priority.suggest', { priority: suggestion.priority })}
      </span>
      <span className="text-xs text-muted-foreground">
        {t('ai.priority.confidence', { value: formatConfidence(suggestion.confidence) })}
      </span>
      <span className="min-w-0 text-xs text-muted-foreground">
        <AiProse text={suggestion.reason} />
      </span>
      {canAccept ? (
        confirming ? (
          <span
            role="group"
            aria-label={t('ai.priority.confirmTitle')}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-xs font-medium text-foreground">
              {t('ai.priority.confirmP1')}
            </span>
            <Button className="rounded-full" disabled={update.isPending} onClick={apply}>
              {t('ai.priority.confirm', { priority: suggestion.priority })}
            </Button>
            <Button
              variant="ghost"
              className="rounded-full"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('ai.priority.cancel')}
            </Button>
          </span>
        ) : (
          <Button
            className="rounded-full"
            disabled={update.isPending}
            onClick={() => {
              if (needsConfirm) setConfirming(true);
              else apply();
            }}
          >
            {t('ai.priority.accept', { priority: suggestion.priority })}
          </Button>
        )
      ) : null}
    </div>
  );
}
