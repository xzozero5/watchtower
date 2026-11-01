import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import type { TintId } from '../tokens/colors.js';
import { TINT_CLASSES } from './tint.js';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** One lucide line icon, drawn large in a soft tinted circle. Never a mascot or a sparkle. */
  icon?: ReactNode;
  /** The hue of the circle. A calm slate unless the state has a mood (teal for "all caught up"). */
  tone?: TintId;
  /** One human sentence. */
  title: string;
  description?: string;
  /** One secondary action. */
  action?: ReactNode;
  /** A keyboard hint, for example "Press J to open the first ticket". */
  hint?: ReactNode;
}

/** Shown when a pane or list has nothing in it yet: a friendly icon, one line, at most one action. */
export function EmptyState({
  icon,
  tone = 'slate',
  title,
  description,
  action,
  hint,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden
          data-tone={tone}
          className={cn(
            'mb-1.5 flex size-14 items-center justify-center rounded-full motion-safe:animate-pop-in [&_svg]:size-6 [&_svg]:stroke-[1.75]',
            TINT_CLASSES[tone].chip,
            TINT_CLASSES[tone].icon,
          )}
        >
          {icon}
        </div>
      ) : null}
      <p className="text-base font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-xs text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
