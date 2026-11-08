'use client';

import { Skeleton, SkeletonCard } from '@watchtower/ui';

import { useT } from '@/i18n/provider';

/** Shown inside the content area only while a page streams in; the rail stays where it is. */
export default function Loading() {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col gap-stack p-stack motion-safe:animate-rise-in"
    >
      <span className="sr-only">{t('loading.label')}</span>

      {/* Simulated page header */}
      <div aria-hidden className="flex items-center justify-between gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton variant="pill" className="h-8 w-24" />
      </div>

      {/* 4 KPI stat tiles */}
      <div aria-hidden className="grid grid-cols-2 gap-stack lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card"
            style={{ animationDelay: `${String(i * 60)}ms` }}
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton variant="circle" className="size-6" />
            </div>
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>

      {/* 2-column content area */}
      <div
        aria-hidden
        className="grid grid-cols-1 gap-stack lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
      >
        <SkeletonCard lines={4} className="bg-surface shadow-card" />
        <div className="flex flex-col gap-3 rounded-card bg-surface p-5 shadow-card">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-col gap-2 pt-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 border-b border-border/50 py-2.5 last:border-b-0"
              >
                <div className="flex items-center gap-2.5">
                  <Skeleton variant="circle" className="size-5 shrink-0" />
                  <Skeleton className="h-3.5 w-32" />
                </div>
                <Skeleton variant="pill" className="h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
