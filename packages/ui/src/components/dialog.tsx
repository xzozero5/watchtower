import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps extends Omit<
  ComponentProps<typeof RadixDialog.Content>,
  'title' | 'children'
> {
  /** The question or the name of the task. Normal case, one line. */
  title: string;
  /** One or two sentences of what happens. Always required: a screen reader reads it after the title. */
  description: string;
  /** Translated name of the close button. */
  closeLabel: string;
  /** The body: a form, a list. */
  children?: ReactNode;
  /** The buttons, right-aligned: `Cancel` then the primary verb. */
  footer?: ReactNode;
}

/**
 * A centred modal on the overlay surface: 12px radius, the one soft shadow, a scrim behind it.
 * Radix traps focus, returns it to the trigger and closes on Esc. The title and the description are
 * required so every dialog has an accessible name and description.
 */
export function DialogContent({
  title,
  description,
  closeLabel,
  children,
  footer,
  className,
  ...props
}: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-scrim" />
      <RadixDialog.Content
        className={cn(
          'fixed top-[12vh] left-1/2 z-50 flex max-h-[80vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 animate-pop-in flex-col rounded-xl border border-border bg-surface text-foreground shadow-overlay outline-hidden',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0">
            <RadixDialog.Title className="text-lg font-semibold">{title}</RadixDialog.Title>
            <RadixDialog.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </RadixDialog.Description>
          </div>
          <RadixDialog.Close asChild>
            <Button variant="ghost" size="icon" aria-label={closeLabel} className="-mt-1 -mr-2">
              <X aria-hidden className="size-4" />
            </Button>
          </RadixDialog.Close>
        </div>
        {children ? <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div> : null}
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
