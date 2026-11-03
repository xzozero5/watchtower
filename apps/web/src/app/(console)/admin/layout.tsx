import type { ReactNode } from 'react';

import { AdminLayout } from '@/components/admin/admin-layout';

export default function Layout({ children }: { children: ReactNode }) {
  return <AdminLayout>{children}</AdminLayout>;
}
