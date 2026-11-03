'use client';

import { useT } from '@/i18n/provider';

/** Shown inside the content area only while a page streams in; the rail stays where it is. */
export default function Loading() {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col gap-stack p-stack"
    >
      <span className="sr-only">{t('loading.label')}</span>
      <div aria-hidden className="min-h-64 flex-1 animate-pulse rounded-lg bg-surface-muted" />
    </div>
  );
}
