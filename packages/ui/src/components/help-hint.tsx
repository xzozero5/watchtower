import { CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

export interface HelpHintProps {
  /** The accessible name of the button, for example "More about assignment". */
  label: string;
  /** The explanation. A sentence or two: whatever a person needs to read before acting. */
  children: ReactNode;
  className?: string;
}

/**
 * An explanation moved out of the page and behind a small `?` button
 * (docs/design/less-text-ai-assistant.md 1.1): it opens a popover on click, tap, Enter or Space,
 * Escape closes it and returns focus, and the words are still in the page for a screen reader once
 * it is open. It is for help, never for a warning: a warning on a destructive action stays on the
 * page. 24 px on a desktop, 44 px on a phone.
 */
export function HelpHint({ label, children, className }: HelpHintProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-surface-muted hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring max-md:size-11',
            className,
          )}
        >
          <CircleHelp aria-hidden className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-80 px-3 py-2 text-sm leading-normal">
        {children}
      </PopoverContent>
    </Popover>
  );
}
