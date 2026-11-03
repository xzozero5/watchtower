'use client';

import { Skeleton } from '@watchtower/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { AuthGate } from '@/components/auth-gate';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { landingPath } from '@/lib/role-home';

function Landing() {
  const t = useT();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const { session } = useSession();
  const role = session?.user.role;
  useEffect(() => {
    if (role) router.replace(landingPath(role, next));
  }, [role, next, router]);
  return (
    <main role="status" className="flex min-h-dvh flex-col gap-3 p-pane">
      <span className="sr-only">{t('auth.gate.loading')}</span>
      <Skeleton className="h-10" />
    </main>
  );
}

/**
 * After sign-in (dev login, SSO, break-glass, magic link) everyone passes here: a valid `next`
 * (a deep link, the page they tried before signing in) wins, otherwise their role's start page.
 */
export function StartPage() {
  return (
    <AuthGate>
      <Landing />
    </AuthGate>
  );
}
