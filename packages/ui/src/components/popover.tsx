import * as RadixPopover from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/** The floating panel: overlay surface, 8px radius, the one soft shadow, 180ms fade-and-rise. */
export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-50 animate-pop-in rounded-lg border border-border bg-surface text-foreground shadow-overlay outline-hidden',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
