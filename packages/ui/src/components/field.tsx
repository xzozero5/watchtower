import { ChevronDown } from 'lucide-react';
import type { InputHTMLAttributes, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

const FIELD =
  'rounded-md border border-border-strong bg-surface px-2.5 text-sm text-foreground transition-colors duration-(--wt-motion-duration-fast) ease-out placeholder:text-muted-foreground hover:bg-surface-muted/60 disabled:opacity-50';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

/** Single-line text field. Always pair it with a visible label or an `aria-label`. */
export function Input({ className, type = 'text', ref, ...props }: InputProps) {
  return <input ref={ref} type={type} className={cn(FIELD, 'h-control', className)} {...props} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

/**
 * Native select with a drawn chevron: keyboard and screen reader support come from the browser.
 * `className` lands on the wrapper, so width classes (`w-full`, `flex-1`) work as expected.
 */
export function Select({ className, ref, ...props }: SelectProps) {
  return (
    <span className={cn('relative inline-flex', className)}>
      <select
        ref={ref}
        className={cn(FIELD, 'h-control w-full min-w-0 appearance-none pr-7')}
        {...props}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, rows = 4, ref, ...props }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(FIELD, 'py-2 leading-normal', className)}
      {...props}
    />
  );
}
