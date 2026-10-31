import type { InputHTMLAttributes, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

const FIELD =
  'rounded-md border border-border-strong bg-surface px-2 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-60';

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

/** Native select: keyboard and screen reader support come from the browser. */
export function Select({ className, ref, ...props }: SelectProps) {
  return <select ref={ref} className={cn(FIELD, 'h-control', className)} {...props} />;
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
