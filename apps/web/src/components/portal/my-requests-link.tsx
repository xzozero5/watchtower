'use client';

import Link from 'next/link';

import { useI18n } from '@/i18n/provider';

/** The way in to "my requests" (T-152) from the submit form and the expired-link page. */
export function MyRequestsLink() {
  const { t } = useI18n();
  return (
    <Link href="/portal/my-requests" className="text-sm text-link underline underline-offset-2">
      {t('portal.myRequests.entry')}
    </Link>
  );
}
