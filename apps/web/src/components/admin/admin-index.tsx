'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { adminSectionsFor } from '@/lib/admin/sections';
import { useSession } from '@/lib/auth/session';

import { AdminBody } from './admin-layout';

/** `/admin` has no page of its own: it opens the first section this person may use. */
export function AdminIndex() {
  const router = useRouter();
  const { can } = useSession();
  const first = adminSectionsFor(can)[0];
  useEffect(() => {
    if (first) router.replace(first.href);
  }, [first, router]);
  return <AdminBody>{null}</AdminBody>;
}
