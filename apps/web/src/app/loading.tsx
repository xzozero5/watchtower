'use client';

import { Skeleton, SkeletonCard } from '@watchtower/ui';

import { useT } from '@/i18n/provider';

/**
 * Skeleton shown while a route streams in. Same 3-pane layout as the real workspace so nothing jumps.
 */
export default function Loading() {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col motion-safe:animate-rise-in"
    >
      <span className="sr-only">{t('loading.label')}</span>

      {/* Simulated top navigation bar */}
      <div
        aria-hidden
        className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4"
      >
        <div className="flex items-center gap-3">
          <Skeleton variant="circle" className="size-8" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton variant="pill" className="hidden h-8 w-64 md:block" />
        <div className="flex items-center gap-2">
          <Skeleton variant="circle" className="size-8" />
        </div>
      </div>

      {/* 3-pane workspace skeleton */}
      <div
        aria-hidden
        className="grid flex-1 grid-cols-1 gap-stack p-stack lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)_minmax(15rem,24rem)]"
      >
        {/* Left Pane: Queue list skeleton (6 rows) */}
        <div className="flex flex-col gap-2 rounded-card bg-surface p-3 shadow-card">
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton variant="pill" className="h-5 w-12" />
          </div>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-inner p-2"
              style={{ animationDelay: `${String(i * 50)}ms` }}
            >
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton variant="pill" className="h-3.5 w-10" />
              </div>
              <Skeleton className="h-3.5 w-4/5" />
              <div className="flex items-center gap-2 pt-0.5">
                <Skeleton variant="pill" className="h-3.5 w-12" />
                <Skeleton variant="circle" className="size-4" />
              </div>
            </div>
          ))}
        </div>

        {/* Middle Pane: Conversation thread bubbles skeleton */}
        <div className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <div className="flex items-center gap-3">
              <Skeleton variant="circle" className="size-7" />
              <div className="flex flex-col gap-1">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <Skeleton variant="pill" className="h-6 w-20" />
          </div>

          <div className="flex flex-col gap-3 py-2">
            {/* Customer bubble */}
            <div className="flex max-w-[80%] gap-2.5">
              <Skeleton variant="circle" className="size-7 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5 rounded-2xl bg-surface-muted p-3.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-3/4" />
              </div>
            </div>

            {/* Agent bubble */}
            <div className="ml-auto flex max-w-[80%] justify-end gap-2.5">
              <div className="flex flex-1 flex-col gap-1.5 rounded-2xl bg-primary/10 p-3.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
              <Skeleton variant="circle" className="size-7 shrink-0" />
            </div>

            {/* Follow-up bubble */}
            <div className="flex max-w-[75%] gap-2.5">
              <Skeleton variant="circle" className="size-7 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5 rounded-2xl bg-surface-muted p-3.5">
                <Skeleton className="h-3.5 w-5/6" />
              </div>
            </div>
          </div>
        </div>

        {/* Right Pane: AI Brief + Properties skeleton */}
        <div className="flex flex-col gap-stack">
          <SkeletonCard lines={4} className="bg-surface shadow-card ring-1 ring-ai-accent/20" />
          <div className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
            <Skeleton className="h-4 w-24" />
            <div className="grid grid-cols-2 gap-2 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-1">
                  <Skeleton className="h-2.5 w-14" />
                  <Skeleton className="h-3.5 w-20" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
