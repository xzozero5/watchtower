'use client';

import { useMutation } from '@tanstack/react-query';
import {
  ASSISTANT_FEEDBACK_REASONS,
  ASSISTANT_MEMORY_LIMITS,
  type AssistantFeedbackRequest,
  type AssistantFeedbackReason,
} from '@watchtower/shared';
import { Button } from '@watchtower/ui';
import { useId, useState } from 'react';

import { useT } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useAssistantMemory, usePinAssistantMemory } from '@/lib/assistant/library';

export function RememberClaim({
  messageId,
  claim,
  open,
}: {
  messageId: string;
  claim: number;
  open: boolean;
}) {
  const t = useT();
  const memory = useAssistantMemory(open);
  const pin = usePinAssistantMemory();
  const saved =
    pin.data !== undefined && memory.data?.items.some((item) => item.id === pin.data.id);
  const full = (memory.data?.items.length ?? 0) >= ASSISTANT_MEMORY_LIMITS.maxPerUser;
  return (
    <div className="text-xs">
      <Button
        size="sm"
        variant="ghost"
        disabled={pin.isPending || memory.isPending || memory.isError || saved || full}
        onClick={() => {
          pin.mutate({ messageId, claim });
        }}
      >
        {saved ? t('assistant.library.remembered') : t('assistant.library.remember')}
      </Button>
      {full && !saved ? <p role="status">{t('assistant.library.full')}</p> : null}
      {memory.isError ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void memory.refetch();
          }}
        >
          {t('assistant.library.retryMemory')}
        </Button>
      ) : null}
      {pin.isError ? (
        <p role="alert">
          {isApiError(pin.error) && pin.error.code === 'assistant_memory_full'
            ? t('assistant.library.full')
            : t('assistant.library.pinError')}
        </p>
      ) : null}
    </div>
  );
}

export function AnswerFeedback({ messageId }: { messageId: string }) {
  const t = useT();
  const api = useApi();
  const id = useId();
  const [choosing, setChoosing] = useState(false);
  const [reason, setReason] = useState<AssistantFeedbackReason | ''>('');
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const feedback = useMutation({
    mutationFn: (body: AssistantFeedbackRequest) => api.assistantFeedback(body),
    retry: false,
    onSuccess: (result) => {
      setRating(result.rating);
      setChoosing(false);
    },
  });
  const send = (value: 'up' | 'down') => {
    feedback.mutate({
      target: { kind: 'message', id: messageId },
      rating: value,
      ...(value === 'down' && reason !== '' ? { reason } : {}),
    });
  };
  return (
    <div
      role="group"
      aria-label={t('assistant.feedback.label')}
      className="flex flex-wrap items-center gap-2 text-xs"
    >
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={rating === 'up'}
        disabled={feedback.isPending}
        onClick={() => {
          send('up');
        }}
      >
        {t('assistant.feedback.up')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={rating === 'down'}
        disabled={feedback.isPending}
        onClick={() => {
          setChoosing(true);
        }}
      >
        {t('assistant.feedback.down')}
      </Button>
      {choosing ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id}>{t('assistant.feedback.reason')}</label>
          <select
            id={id}
            value={reason}
            disabled={feedback.isPending}
            className="max-w-full rounded-md border border-border bg-surface p-1 text-foreground"
            onChange={(event) => {
              const value = event.target.value;
              if (ASSISTANT_FEEDBACK_REASONS.some((item) => item === value))
                setReason(value as AssistantFeedbackReason);
            }}
          >
            <option value="" disabled>
              {t('assistant.feedback.choose')}
            </option>
            {ASSISTANT_FEEDBACK_REASONS.map((item) => (
              <option key={item} value={item}>
                {t(`assistant.feedback.reasons.${item}`)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={reason === '' || feedback.isPending}
            onClick={() => {
              send('down');
            }}
          >
            {t('assistant.feedback.submit')}
          </Button>
        </div>
      ) : null}
      {feedback.isSuccess ? <p role="status">{t('assistant.feedback.saved')}</p> : null}
      {feedback.isError ? (
        <div role="alert">
          <p>{t('assistant.feedback.error')}</p>
          <Button
            size="sm"
            onClick={() => {
              feedback.mutate(feedback.variables);
            }}
          >
            {t('assistant.library.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
