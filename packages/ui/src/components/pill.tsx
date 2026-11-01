import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export const DOT_TONES = ['info', 'success', 'muted', 'outline'] as const;
export type DotTone = (typeof DOT_TONES)[number];

// A filled dot, a green dot, a grey dot, or a hollow ring: the shape differs as well as the colour.
const DOT: Record<DotTone, string> = {
  info: 'bg-link',
  success: 'bg-success',
  muted: 'bg-muted-foreground',
  outline: 'border-[1.5px] border-muted-foreground bg-transparent',
};

/** A 6px status dot. Always sits next to the status in words. */
export function StatusDot({
  tone,
  className,
  ...props
}: { tone: DotTone } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[tone], className)}
      {...props}
    />
  );
}

/** A 20px pill: 12px text, medium weight, a soft neutral ground (no outline). */
export function Pill({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-surface-muted px-2 text-xs font-medium whitespace-nowrap text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/** Ticket status: a soft pill with a coloured dot and the status in words. */
export function StatusPill({
  tone,
  label,
  className,
  ...props
}: { tone: DotTone; label: string } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <Pill className={className} {...props}>
      <StatusDot tone={tone} />
      <span>{label}</span>
    </Pill>
  );
}
