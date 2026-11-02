import type { ReactNode } from 'react';

import { ConsolePage } from '@/components/console-page';
import { OpsFrame } from '@/components/ops/ops-frame';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <ConsolePage destination="status-page">
      <OpsFrame titleKey="ops.nav.statusPage">{children}</OpsFrame>
    </ConsolePage>
  );
}
