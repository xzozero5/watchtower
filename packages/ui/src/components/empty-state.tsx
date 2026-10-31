import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** One small line icon (16 to 20px). Never a mascot or a sparkle. */
  icon?: ReactNode;
  /** One human sentence. */
  title: string;
  description?: string;
  /** One secondary action. */
  action?: ReactNode;
  /** A keyboard hint, for example "Press J to open the first ticket". */
  hint?: ReactNode;
}

/** Shown when a pane or list has nothing in it yet. Says what is missing and what to do next. */
export function EmptyState({
  icon,
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
          className="mb-1 flex size-9 items-center justify-center rounded-full bg-surface-muted text-muted-foreground [&_svg]:size-[18px]"
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
