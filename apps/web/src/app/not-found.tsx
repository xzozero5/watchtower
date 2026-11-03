'use client';

import { buttonVariants, Card, EmptyState } from '@watchtower/ui';
import Image from 'next/image';
import Link from 'next/link';

import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';

export default function NotFoundPage() {
  const t = useT();
  const { status, isClient } = useSession();
  // Only a signed-in staff member has a queue to go back to; everyone else gets the help portal.
  const staff = status === 'authenticated' && !isClient;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background p-pane">
      {/* Soft Beacon: one white card on the Canvas. */}
      <Card className="flex w-full max-w-md flex-col items-center px-6 py-8">
        {/* Outside EmptyState: its icon slot is a 56 px chip, and the 160 px logo overflowed onto the title. */}
        <Image
          src="/brand/watchtower-logo.png"
          alt=""
          width={160}
          height={160}
          className="size-40 rounded-lg"
        />
        <EmptyState
          title={t('errors.notFoundTitle')}
          description={t('errors.notFoundBody')}
          action={
            status === 'loading' ? null : (
              <Link
                href={staff ? '/' : '/portal'}
                className={buttonVariants({ variant: 'primary' })}
              >
                {staff ? t('errors.backHome') : t('errors.backToPortal')}
              </Link>
            )
          }
        />
      </Card>
    </main>
  );
}
