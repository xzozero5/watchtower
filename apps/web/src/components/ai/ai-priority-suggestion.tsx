'use client';

import type { AiPrioritySuggestion, TicketPriority } from '@watchtower/shared';
import { Button, toast } from '@watchtower/ui';
import { Flag } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { formatConfidence } from '@/lib/ai/model';
import { isApiError } from '@/lib/api/errors';
import { useTicketMutations } from '@/lib/tickets/queries';

import { AiProse } from './ai-prose';

/**
 * A priority the AI proposes (T-147, QA-29). The ticket does not change by itself (N2, N3): the person
 * accepts it, and that goes through the same ticket update as any edit, so the event log and the audit
 * record who changed it. Nothing shows when the AI agrees with the current priority.
 */
export function AiPrioritySuggestionRow({
  ticketKey,
  current,
  suggestion,
  canAccept,
}: {
  ticketKey: string;
  current: TicketPriority;
  suggestion: AiPrioritySuggestion;
  canAccept: boolean;
}) {
  const { t } = useI18n();
  const { update } = useTicketMutations(ticketKey);
  if (suggestion.priority === current) return null;

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
        <Button
          className="rounded-full"
          disabled={update.isPending}
          onClick={() => {
            update.mutate(
              { priority: suggestion.priority },
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
          }}
        >
          {t('ai.priority.accept', { priority: suggestion.priority })}
        </Button>
      ) : null}
    </div>
  );
}
