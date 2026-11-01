import type { ReactNode } from 'react';

import { ConsolePage } from '@/components/console-page';
import { ShiftFrame } from '@/components/shift/shift-frame';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <ConsolePage destination="shift">
      <ShiftFrame>{children}</ShiftFrame>
    </ConsolePage>
  );
}
