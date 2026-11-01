import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, Ref } from 'react';

import { cn } from '../lib/cn.js';

/**
 * Buttons: 10px radius, `control` height (32px comfortable, 28px compact), 120ms colour transition and
 * a 0.97 press squeeze (not under reduced motion).
 * Navy is the one primary colour; every other button is quiet until hovered.
 */
export const buttonVariants = cva(
  'inline-flex h-control shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-[color,background-color,opacity,transform] duration-(--wt-motion-duration-fast) ease-out motion-safe:active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90 active:opacity-80',
        secondary:
          'border border-border-strong bg-surface text-foreground hover:bg-surface-muted active:bg-primary-subtle',
        ghost: 'text-foreground hover:bg-surface-muted active:bg-primary-subtle',
      },
      size: {
        default: '',
        sm: 'px-2 text-xs',
        icon: 'w-control rounded-full px-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
  /** Render the child element (a link, a trigger) with the button's look instead of a `<button>`. */
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  type = 'button',
  asChild = false,
  ref,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot ref={ref} className={classes} {...props} />;
  return <button ref={ref} type={type} className={classes} {...props} />;
}
