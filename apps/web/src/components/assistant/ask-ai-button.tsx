'use client';

import type { AssistantEntity } from '@watchtower/shared';
import { assistantEntityRefSchema } from '@watchtower/shared';
import { IconButton } from '@watchtower/ui';
import { Bot } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { requestAssistantOpen } from '@/lib/assistant/assistant-ui';
import { useSession } from '@/lib/auth/session';

export interface AskAiButtonProps {
  entity: AssistantEntity;
  /** What the person calls it (`INC-12`, the intent name). Shown on the chip and in the button's name; never sent. */
  label: string;
  className?: string;
}

/**
 * "Ask AI about this" (ADR-029 section 1): a small button on a row, a card or a header that opens
 * the assistant with that one thing as the chip above the input. It sends nothing by itself: the
 * person still types and presses send, and can remove the chip. Same rule as the bubble: only people
 * who can read tickets see it, and it renders nothing when the reference is not a valid one.
 */
export function AskAiButton({ entity, label, className }: AskAiButtonProps) {
  const { t } = useI18n();
  const { can } = useSession();
  if (!(can('ticket.read') || can('ticket.read.masked'))) return null;
  if (!assistantEntityRefSchema.safeParse(entity.ref).success) return null;
  const name = t('assistant.askAbout.named', { name: label });
  return (
    <IconButton
      label={name}
      tooltip={t('assistant.askAbout.label')}
      aria-haspopup="dialog"
      data-testid="ask-ai-about"
      {...(className ? { className } : {})}
      icon={<Bot aria-hidden className="size-4 text-ai-accent" />}
      onClick={() => {
        requestAssistantOpen({ entity, label });
      }}
    />
  );
}
