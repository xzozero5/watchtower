'use client';

import type { AssistantElement, AssistantEntity } from '@watchtower/shared';
import { assistantEntityRefSchema } from '@watchtower/shared';
import { Button, IconButton } from '@watchtower/ui';
import { MessageCircle } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { requestAssistantOpen } from '@/lib/assistant/assistant-ui';
import { isAssistantWorkspace } from '@/lib/assistant/access';
import { useSession } from '@/lib/auth/session';

export interface AskAiButtonProps {
  entity?: AssistantEntity;
  element?: AssistantElement;
  disabledReason?: string;
  /** What the person calls it (`INC-12`, the intent name). Shown on the chip and in the button's name; never sent. */
  label: string;
  className?: string;
  presentation?: 'icon' | 'follow-up';
}

/**
 * "Ask AI about this" (ADR-029 section 1): a small button on a row, a card or a header that opens
 * the assistant with that one thing as the chip above the input. It sends nothing by itself: the
 * person still types and presses send, and can remove the chip. Same rule as the bubble: only people
 * who can read tickets see it, and it renders nothing when the reference is not a valid one.
 */
export function AskAiButton({
  entity,
  element,
  disabledReason,
  label,
  className,
  presentation = 'icon',
}: AskAiButtonProps) {
  const { t } = useI18n();
  const { can, session } = useSession();
  if (!isAssistantWorkspace(session) || (!element && !can('assistant.use'))) return null;
  if (entity && !assistantEntityRefSchema.safeParse(entity.ref).success) return null;
  const name = t('assistant.askAbout.named', { name: label });
  const controls = {
    'aria-disabled': disabledReason ? true : undefined,
    'aria-description': disabledReason,
    'data-element': element?.key,
    'aria-haspopup': 'dialog' as const,
    'data-testid': 'ask-ai-about',
    onClick: () => {
      if (disabledReason) return;
      requestAssistantOpen({
        ...(entity ? { entity } : {}),
        ...(element ? { element } : {}),
        label,
      });
    },
  };
  if (presentation === 'follow-up') {
    return (
      <Button
        {...controls}
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`${name} · ${t('assistant.askAbout.followUp')}`}
        title={disabledReason ?? t('assistant.askAbout.label')}
        className={className}
      >
        <MessageCircle aria-hidden className="size-4" />
        {t('assistant.askAbout.followUp')}
      </Button>
    );
  }
  return (
    <IconButton
      {...controls}
      label={name}
      tooltip={disabledReason ?? t('assistant.askAbout.label')}
      className={className ? `group ${className}` : 'group'}
      icon={<MessageCircle aria-hidden className="size-4" />}
    />
  );
}
