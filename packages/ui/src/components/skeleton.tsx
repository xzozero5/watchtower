import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Shape preset: `rect` (default rounded block), `pill` (badge/button), or `circle` (avatar/icon). */
  variant?: 'rect' | 'pill' | 'circle';
}

/**
 * Placeholder block shown while content loads. Uses a directional pearl shimmer under
 * `prefers-reduced-motion: no-preference` and stays calm when reduced motion is active.
 * Decorative: the region that owns it must announce loading via `aria-busy` or status text.
 */
export function Skeleton({ variant = 'rect', className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      data-slot="skeleton"
      className={cn(
        'bg-skeleton motion-safe:animate-shimmer',
        variant === 'rect' && 'rounded-md',
        variant === 'pill' && 'rounded-full',
        variant === 'circle' && 'rounded-full',
        className,
      )}
      {...props}
    />
  );
}

export interface SkeletonTextProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of placeholder lines to render. Defaults to 3. */
  lines?: number;
}

const LINE_WIDTHS = ['w-full', 'w-11/12', 'w-3/4', 'w-5/6', 'w-2/3'] as const;

/** Multi-line editorial text placeholder with staggered natural line lengths. */
export function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps) {
  const count = Math.max(1, lines);
  return (
    <div aria-hidden className={cn('flex flex-col gap-2', className)} {...props}>
      {Array.from({ length: count }, (_, i) => {
        const isLast = i === count - 1 && count > 1;
        const widthClass = isLast ? 'w-3/5' : (LINE_WIDTHS[i % LINE_WIDTHS.length] ?? 'w-full');
        return (
          <Skeleton
            key={i}
            className={cn('h-3.5', widthClass)}
            style={{ animationDelay: `${String(i * 90)}ms` }}
          />
        );
      })}
    </div>
  );
}

export interface SkeletonCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of body lines inside the card placeholder. Defaults to 3. */
  lines?: number;
}

/** Structured Soft Beacon card skeleton with header pill + natural body lines. */
export function SkeletonCard({ lines = 3, className, ...props }: SkeletonCardProps) {
  return (
    <div
      aria-hidden
      className={cn('flex flex-col gap-3.5 rounded-card bg-surface p-5 shadow-card', className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Skeleton variant="circle" className="size-6 shrink-0" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton variant="pill" className="h-5 w-16" />
      </div>
      <SkeletonText lines={lines} />
    </div>
  );
}
