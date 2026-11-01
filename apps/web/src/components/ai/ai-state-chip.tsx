import type { AiState } from '@watchtower/shared';
import { type ChipIcon, cn, TintChip, type TintId } from '@watchtower/ui';
import { CircleOff, Hand, PenLine, Search, Tag } from 'lucide-react';

import { useT } from '@/i18n/provider';

type Shown = Exclude<AiState, 'none'>;

/** The magnifier breathes while the AI looks; it is still under reduced motion. */
const Searching: ChipIcon = ({ className, ...rest }) => (
  <Search {...rest} className={cn(className, 'motion-safe:animate-pulse')} />
);

const LOOK: Record<Shown, { icon: ChipIcon; tone: TintId }> = {
  classified: { icon: Tag, tone: 'teal' },
  investigating: { icon: Searching, tone: 'violet' },
  draft_ready: { icon: PenLine, tone: 'teal' },
  needs_human: { icon: Hand, tone: 'amber' },
  failed: { icon: CircleOff, tone: 'slate' },
};

/**
 * Where the AI is with a ticket, as a soft tinted chip with an icon and words (never colour alone):
 * `Classified` (teal, tag), `Investigating` (violet, a breathing magnifier), `Draft ready` (teal,
 * pen), `Needs you` (amber, hand), `AI failed` (slate, circle-off). The state `none` draws nothing.
 * In the compact queue only the icon shows and the words stay for screen readers
 * (docs/design/friendly-polish.md section 3).
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
  const { icon, tone } = LOOK[state];
  return (
    <TintChip
      tone={tone}
      icon={icon}
      iconOnly={iconOnly}
      data-ai-state={state}
      className={className}
    >
      {t(`ai.state.${state}`)}
    </TintChip>
  );
}
