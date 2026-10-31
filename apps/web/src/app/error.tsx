'use client';

import { Button, EmptyState } from '@watchtower/ui';
import { TriangleAlert } from 'lucide-react';

import { useT } from '@/i18n/provider';

/** Shown when rendering a route throws. The error itself is not displayed: it may hold details. */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  return (
    <main className="flex min-h-dvh items-center justify-center p-pane">
      <EmptyState
        role="alert"
        icon={<TriangleAlert className="size-8" />}
        title={t('errors.title')}
        description={t('errors.body')}
        action={
          <Button variant="primary" onClick={reset}>
            {t('errors.retry')}
          </Button>
        }
      />
    </main>
  );
}
