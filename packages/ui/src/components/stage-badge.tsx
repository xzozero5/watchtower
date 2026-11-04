import { Eye, Lightbulb, Send, UserCheck } from 'lucide-react';
import type { ComponentType, HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/**
 * The autonomy stages (PRD section 6.4, ADR-025). Stage 3 (the AI sends on its own) is the owner's
 * decision (N3): it exists on an intent only after a promotion the owner approved, and a person never sets
 * it by hand. A stage above 3 does not exist, so no screen can render one.
 */
export const AUTONOMY_STAGES = [0, 1, 2, 3] as const;
export type AutonomyStage = (typeof AUTONOMY_STAGES)[number];

const ICONS: Record<
  AutonomyStage,
  ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: true }>
> = {
  0: Eye,
  1: Lightbulb,
  2: UserCheck,
  3: Send,
};

export interface StageBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  stage: AutonomyStage;
  /** Translated words, for example "Stage 1 · Suggest". Required so callers go through i18n. */
  label: string;
}

/**
 * An autonomy stage as an icon and words (eye = observe, lightbulb = suggest, user-check = a person
 * approves, send = the AI sends on its own). A soft slate chip: the stage is told apart by icon and text, never by colour.
 */
export function StageBadge({ stage, label, className, ...props }: StageBadgeProps) {
  const Icon = ICONS[stage];
  return (
    <span
      data-stage={stage}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-tint-slate-bg px-2 text-xs font-medium whitespace-nowrap text-tint-slate-fg',
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-tint-slate-icon" strokeWidth={2} />
      <span>{label}</span>
    </span>
  );
}
