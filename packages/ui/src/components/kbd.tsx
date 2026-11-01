import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/** A keyboard key cap, for shortcut hints such as "Ctrl K". */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border/60 bg-surface-muted px-1 font-sans text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
