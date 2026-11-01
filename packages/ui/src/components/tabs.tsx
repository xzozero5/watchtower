import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

export const Tabs = RadixTabs.Root;

/** A row of round tabs; the selected one is a soft navy-tinted pill. */
export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cn('flex items-stretch gap-1', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'relative inline-flex h-control items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors duration-(--wt-motion-duration-fast) ease-out outline-hidden hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring data-[state=active]:bg-primary-subtle data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content className={cn('min-h-0 flex-1 outline-hidden', className)} {...props} />
  );
}
