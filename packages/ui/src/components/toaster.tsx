import { Toaster as Sonner, toast } from 'sonner';

export { toast };

export interface ToasterProps {
  /** Accessible name of the notifications region, translated by the app. */
  regionLabel: string;
}

/**
 * Toasts (Sonner, restyled with the design tokens). Mount once. Use `toast(message, { action })` for
 * an "Undo" action. Toasts last six seconds, so there is time to reach the action by keyboard
 * (Alt+T moves focus into them), and hovering pauses the timer.
 */
export function Toaster({ regionLabel }: ToasterProps) {
  return (
    <Sonner
      position="bottom-left"
      duration={6000}
      visibleToasts={3}
      gap={8}
      containerAriaLabel={regionLabel}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-foreground shadow-overlay',
          title: 'font-medium',
          description: 'text-muted-foreground',
          actionButton:
            'ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90',
          cancelButton:
            'inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-surface-muted',
        },
      }}
    />
  );
}
