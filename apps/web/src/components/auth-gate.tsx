'use client';

import { Alert, Button, Skeleton } from '@watchtower/ui';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';

/**
 * Shows its children only to a signed-in user. While the session loads (or the browser is being
 * sent to the login page) it shows a skeleton; if the api cannot be reached it says so and offers
 * a retry instead of bouncing to the login page for an outage.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const { status, retry } = useSession();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status === 'authenticated') return <>{children}</>;

  if (status === 'error') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-pane">
        <Alert tone="error" title={t('auth.gate.errorTitle')}>
          <p>{t('auth.gate.errorBody')}</p>
          <Button className="mt-2" onClick={retry}>
            {t('errors.retry')}
          </Button>
        </Alert>
      </main>
    );
  }

  return (
    <main role="status" className="flex min-h-dvh flex-col gap-3 p-pane">
      <span className="sr-only">{t('auth.gate.loading')}</span>
      <Skeleton className="h-10" />
      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
        <Skeleton className="h-64 lg:h-full" />
        <Skeleton className="h-64 lg:h-full" />
        <Skeleton className="h-64 lg:h-full" />
      </div>
    </main>
  );
}
