import type { AiState } from '@watchtower/shared';
import { cn } from '@watchtower/ui';
import { CircleAlert, Loader, type LucideIcon, PenLine, Bot, UserRoundCheck } from 'lucide-react';

import { useT } from '@/i18n/provider';

const ICONS: Record<Exclude<AiState, 'none'>, LucideIcon> = {
  classified: Bot,
  investigating: Loader,
  draft_ready: PenLine,
  needs_human: UserRoundCheck,
  failed: CircleAlert,
};

/**
 * Where the AI is with a ticket, as an icon and words (never colour alone): `Classified`,
 * `Investigating` (the icon turns; static under reduced motion), `Draft ready`, `Needs you`,
 * `AI failed`. The state `none` draws nothing. In the compact queue only the icon shows and the
 * words stay for screen readers. AI work wears the AI accent so it reads as the AI's.
 */
export function AiStateChip({
  state,
  iconOnly = false,
  className,
}: {
  state: AiState;
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useT();
  if (state === 'none') return null;
  const Icon = ICONS[state];
  const label = t(`ai.state.${state}`);
  return (
    <span
      data-ai-state={state}
      title={iconOnly ? label : undefined}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs font-medium whitespace-nowrap',
        state === 'needs_human' || state === 'draft_ready'
          ? 'border-ai-accent text-ai-accent'
          : 'border-transparent text-ai-accent',
        state === 'failed' && 'border-danger text-danger',
        iconOnly && 'px-1',
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn('size-3.5 shrink-0', state === 'investigating' && 'animate-spin')}
      />
      <span className={cn(iconOnly && 'sr-only')}>{label}</span>
    </span>
  );
}
