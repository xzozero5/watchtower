import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/**
 * Placeholder block shown while content loads. Decorative: the region that owns it must say
 * "loading" to assistive technology (`aria-busy` plus a status text).
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-surface-muted', className)}
      {...props}
    />
  );
}
