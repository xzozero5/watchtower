'use client';

import { buttonVariants, EmptyState } from '@watchtower/ui';
import Image from 'next/image';
import Link from 'next/link';

import { useT } from '@/i18n/provider';

export default function NotFoundPage() {
  const t = useT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-pane">
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
          <Link href="/" className={buttonVariants({ variant: 'primary' })}>
            {t('errors.backHome')}
          </Link>
        }
      />
    </main>
  );
}
