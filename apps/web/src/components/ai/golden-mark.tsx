'use client';

import type { Message } from '@watchtower/shared';
import { toast, Tooltip } from '@watchtower/ui';
import { Star } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { canMarkGolden, goldenErrorKey } from '@/lib/ai/golden';
import { useMarkGolden, useTicketGolden } from '@/lib/ai/grade-queries';
import { useSession } from '@/lib/auth/session';

/**
 * "Mark as golden answer" on a reply that was sent (T-302a, lead and head). The api keeps the text with
 * personal details removed and the drafter reads it as an example of tone. Once marked, the star is filled
 * and named "Golden answer": the state is the icon and the words, not the colour. Nothing is drawn for
 * anyone who may not mark, or for a message that is not a sent reply.
 */
export function GoldenMarkButton({ message, className }: { message: Message; className?: string }) {
  const { t } = useI18n();
  const { can, isClient } = useSession();
  const allowed = can('ai.golden.manage') && !isClient && canMarkGolden(message);
  const golden = useTicketGolden(message.ticketKey, allowed);
  const mark = useMarkGolden(message.ticketKey);
  if (!allowed) return null;

  const marked =
    mark.isSuccess || (golden.data?.items.some((item) => item.messageId === message.id) ?? false);
  if (marked) {
    return (
      <Tooltip content={t('grade.golden.markedTip')}>
        <button
          type="button"
          aria-disabled="true"
          aria-label={t('grade.golden.marked')}
          data-golden="marked"
          className={className}
        >
          <Star aria-hidden className="size-3.5 fill-current text-tint-amber-icon" />
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={t('grade.golden.markTip')}>
      <button
        type="button"
        aria-label={t('grade.golden.mark')}
        disabled={mark.isPending}
        className={className}
        onClick={() => {
          mark.mutate(message.id, {
            onSuccess: () => {
              toast(t('grade.golden.done'));
            },
            onError: (error) => {
              toast(t(`grade.golden.errors.${goldenErrorKey(error)}`));
            },
          });
        }}
      >
        <Star aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  );
}
