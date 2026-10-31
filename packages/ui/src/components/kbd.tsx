import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/** A keyboard key cap, for shortcut hints such as "Ctrl K". */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-6 items-center justify-center rounded border border-border-strong bg-surface-muted px-1.5 font-mono text-xs text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
