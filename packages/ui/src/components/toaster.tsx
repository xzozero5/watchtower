import { CircleCheck } from 'lucide-react';
import { type ExternalToast, Toaster as Sonner, toast as sonnerToast } from 'sonner';

type ToastMessage = Parameters<typeof sonnerToast>[0];

function friendlyToast(message: ToastMessage, data?: ExternalToast) {
  // A check mark in a soft teal circle on the left, unless the caller picks another icon.
  return sonnerToast(message, { icon: <CircleCheck aria-hidden />, ...data });
}

/**
 * `toast(message, { action })`: the same as Sonner's, with a rounded card and a check mark on the
 * left (docs/design/friendly-polish.md section 4). `toast.dismiss` and the rest are Sonner's own.
 */
export const toast: typeof friendlyToast & typeof sonnerToast = Object.assign(
  friendlyToast,
  sonnerToast,
);

export interface ToasterProps {
  /** Accessible name of the notifications region, translated by the app. */
  regionLabel: string;
}

/**
 * Toasts (Sonner, restyled with the design tokens), top right (UI-SPEC section 8.1, T-151). Mount once. Use `toast(message, { action })` for
 * an "Undo" action. Toasts last six seconds, so there is time to reach the action by keyboard
 * (Alt+T moves focus into them), and hovering pauses the timer.
 */
export function Toaster({ regionLabel }: ToasterProps) {
  return (
    <Sonner
      position="top-right"
      duration={6000}
      visibleToasts={3}
      gap={8}
      containerAriaLabel={regionLabel}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-card border border-border/60 bg-surface px-3 py-2.5 text-sm text-foreground shadow-overlay',
          icon: 'flex size-6 shrink-0 items-center justify-center rounded-full bg-tint-teal-bg text-tint-teal-icon motion-safe:animate-check-pop [&_svg]:size-4',
          title: 'font-medium',
          description: 'text-muted-foreground',
          actionButton:
            'ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90',
          cancelButton:
            'inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-surface-muted',
        },
      }}
    />
  );
}
