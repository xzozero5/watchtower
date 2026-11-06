import * as ToggleGroup from '@radix-ui/react-toggle-group';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Full accessible name when the visible label is a short form ("Note" for "Internal note"). */
  ariaLabel?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Names the group for assistive technology. */
  'aria-label': string;
  className?: string;
}

/**
 * Two to four mutually exclusive choices on one rounded track (Reply / Internal note). Exactly one
 * is always selected: pressing the selected one does nothing. Arrow keys move between them.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  className,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next);
        if (match) onValueChange(match.value);
      }}
      aria-label={props['aria-label']}
      className={cn('inline-flex rounded-full bg-surface-muted p-0.5', className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors duration-(--wt-motion-duration-fast) ease-out outline-hidden hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-50',
            'data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-border)_60%,transparent)]',
          )}
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
