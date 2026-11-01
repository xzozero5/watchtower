import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';

export const Sheet = RadixDialog.Root;
export const SheetTrigger = RadixDialog.Trigger;
export const SheetClose = RadixDialog.Close;

export interface SheetContentProps extends Omit<
  ComponentProps<typeof RadixDialog.Content>,
  'title' | 'children'
> {
  title: string;
  description: string;
  /** Translated name of the close button. */
  closeLabel: string;
  children?: ReactNode;
  /** Sticky bar at the foot: Save, Cancel. */
  footer?: ReactNode;
  /** Sits under the title, for example a tab list. */
  header?: ReactNode;
}

/**
 * A right-hand drawer, 400px wide (full width on a phone), modal on the same primitive as `Dialog`:
 * focus is trapped, Esc closes it and focus returns to the row that opened it. The caller decides
 * whether closing needs a confirmation when there are unsaved changes (`onEscapeKeyDown`,
 * `onInteractOutside` and `onOpenChange`).
 */
export function SheetContent({
  title,
  description,
  closeLabel,
  children,
  footer,
  header,
  className,
  ...props
}: SheetContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-scrim" />
      <RadixDialog.Content
        className={cn(
          'fixed top-0 right-0 z-50 flex h-dvh w-[min(25rem,100vw)] animate-slide-in-right flex-col border-l border-border bg-surface text-foreground shadow-overlay outline-hidden',
          className,
        )}
        {...props}
      >
        <div className="flex min-h-[48px] items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
            <RadixDialog.Description className="text-sm text-muted-foreground">
              {description}
            </RadixDialog.Description>
          </div>
          <RadixDialog.Close asChild>
            <Button variant="ghost" size="icon" aria-label={closeLabel} className="-mt-1 -mr-2">
              <X aria-hidden className="size-4" />
            </Button>
          </RadixDialog.Close>
        </div>
        {header ? <div className="border-b border-border px-4 py-2">{header}</div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
