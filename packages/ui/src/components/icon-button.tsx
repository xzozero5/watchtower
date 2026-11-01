import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button, type ButtonProps } from './button.js';
import { Tooltip } from './tooltip.js';

export interface IconButtonProps extends Omit<ButtonProps, 'size' | 'children' | 'aria-label'> {
  /** The action in words. It is the accessible name and the tooltip, so keep it the old button text. */
  label: string;
  /** One lucide icon, `aria-hidden`. */
  icon: ReactNode;
  /** Key caps for the tooltip, for example `['E']`. Also written to `aria-keyshortcuts`. */
  shortcut?: readonly string[];
  /** Longer words for the tooltip than the label ("Attach a file — coming soon"). */
  tooltip?: ReactNode;
  /** Hide the tooltip (for a control that already sits beside its own words). */
  noTooltip?: boolean;
}

/**
 * The round icon-only button for frequent, obvious actions (copy, refresh, collapse, close, edit)
 * (docs/design/friendly-polish.md section 1): 32 px, 36 px on a phone, fully round. The label is the
 * `aria-label` and the tooltip, with the shortcut as key caps, so the words are never lost, only
 * moved out of the way. Presses with a small squeeze unless the user prefers reduced motion.
 */
export function IconButton({
  label,
  icon,
  shortcut,
  tooltip,
  noTooltip = false,
  variant = 'ghost',
  className,
  ...props
}: IconButtonProps) {
  const button = (
    <Button
      variant={variant}
      size="icon"
      aria-label={label}
      aria-keyshortcuts={shortcut && shortcut.length > 0 ? shortcut.join('+') : undefined}
      className={cn('rounded-full max-md:size-9', className)}
      {...props}
    >
      {icon}
    </Button>
  );
  if (noTooltip) return button;
  return (
    <Tooltip content={tooltip ?? label} {...(shortcut ? { shortcut } : {})}>
      {button}
    </Tooltip>
  );
}
