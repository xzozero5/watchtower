import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/**
 * The floating app sheet on a soft gradient backdrop (Soft Beacon). Owner, 2026-11-02: Overview
 * and Login only; every other page is full screen. Below `md` and in compact density the sheet
 * fills the window, so a phone or a dense desk loses no width.
 */
export function AppFrame({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-app-frame=""
      className="flex h-dvh min-h-0 flex-col md:bg-backdrop md:p-4 lg:p-6 in-data-[density=compact]:p-0"
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden bg-frame md:rounded-app md:shadow-app in-data-[density=compact]:rounded-none in-data-[density=compact]:shadow-none',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}
