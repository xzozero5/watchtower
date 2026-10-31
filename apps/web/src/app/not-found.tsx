'use client';

import { buttonVariants, EmptyState } from '@watchtower/ui';
import Image from 'next/image';
import Link from 'next/link';

import { useT } from '@/i18n/provider';

export default function NotFoundPage() {
  const t = useT();
  return (
    <main className="flex min-h-dvh items-center justify-center p-pane">
      <EmptyState
        icon={
          <Image
            src="/brand/watchtower-logo.png"
            alt=""
            width={160}
            height={160}
            className="size-40 rounded-lg"
          />
        }
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
