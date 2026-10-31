import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Kbd } from './kbd.js';

/** Mount once near the root. Tooltips open after 400ms and the next ones open at once. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** The words. Keep it short; it repeats or extends the control's accessible name. */
  content: ReactNode;
  /** Key caps shown after the words, for example `['Ctrl', 'K']`. */
  shortcut?: readonly string[];
  side?: ComponentProps<typeof RadixTooltip.Content>['side'];
  align?: ComponentProps<typeof RadixTooltip.Content>['align'];
  disabled?: boolean;
  /** A single element that can take a ref: the tooltip is attached to it. */
  children: ReactElement;
}

/**
 * Tooltip with an optional shortcut hint. It is a hint, never the only way to learn what a control
 * does: icon buttons also carry an `aria-label`. Opens on keyboard focus as well as hover.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  align = 'center',
  disabled = false,
  children,
}: TooltipProps) {
  if (disabled) return children;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 flex max-w-64 animate-pop-in items-center gap-2 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-overlay',
          )}
        >
          <span>{content}</span>
          {shortcut && shortcut.length > 0 ? (
            <span className="flex items-center gap-0.5">
              {shortcut.map((key) => (
                <Kbd
                  key={key}
                  className="border-transparent bg-primary-foreground/20 text-primary-foreground"
                >
                  {key}
                </Kbd>
              ))}
            </span>
          ) : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
