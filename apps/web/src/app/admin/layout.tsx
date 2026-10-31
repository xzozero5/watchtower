import type { ReactNode } from 'react';

import { AdminLayout } from '@/components/admin/admin-layout';
import { ConsolePage } from '@/components/console-page';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <ConsolePage destination="admin">
      <AdminLayout>{children}</AdminLayout>
    </ConsolePage>
  );
}
