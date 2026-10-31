import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** Shown when a pane or list has nothing in it yet. Says what is missing and what to do next. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-8 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden className="text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
