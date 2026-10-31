'use client';

import { useT } from '@/i18n/provider';

/** Skeleton shown while a route streams in. Same grid as the real page, so nothing jumps. */
export default function Loading() {
  const t = useT();
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh flex-col">
      <span className="sr-only">{t('loading.label')}</span>
      <div aria-hidden className="h-14 border-b border-border bg-surface" />
      <div
        aria-hidden
        className="grid flex-1 grid-cols-1 gap-stack p-stack lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)_minmax(15rem,24rem)]"
      >
        {[0, 1, 2].map((key) => (
          <div key={key} className="min-h-64 animate-pulse rounded-lg bg-surface-muted" />
        ))}
      </div>
    </div>
  );
}
