import type { ReactNode } from 'react';

import { OpsFrame } from '@/components/ops/ops-frame';

export default function Layout({ children }: { children: ReactNode }) {
  return <OpsFrame titleKey="ops.nav.incidents">{children}</OpsFrame>;
}
