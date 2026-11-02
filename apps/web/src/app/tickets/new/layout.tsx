import type { ReactNode } from 'react';

import { ConsolePage } from '@/components/console-page';

export default function Layout({ children }: { children: ReactNode }) {
  return <ConsolePage destination="newTicket">{children}</ConsolePage>;
}
