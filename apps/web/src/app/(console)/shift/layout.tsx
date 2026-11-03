import type { ReactNode } from 'react';

import { ShiftFrame } from '@/components/shift/shift-frame';

export default function Layout({ children }: { children: ReactNode }) {
  return <ShiftFrame>{children}</ShiftFrame>;
}
