import type { ReactNode } from 'react';

import { ConsolePage } from '@/components/console-page';
import { OpsFrame } from '@/components/ops/ops-frame';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <ConsolePage destination="alerts">
      <OpsFrame titleKey="ops.nav.alerts">{children}</OpsFrame>
    </ConsolePage>
  );
}
