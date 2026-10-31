import { CircleCheck, CircleX, Info } from 'lucide-react';
import type { ComponentType, HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export const ALERT_TONES = ['error', 'info', 'success'] as const;
export type AlertTone = (typeof ALERT_TONES)[number];

const ICON: Record<AlertTone, ComponentType<{ className?: string; 'aria-hidden'?: true }>> = {
  error: CircleX,
  info: Info,
  success: CircleCheck,
};

const ICON_TONE: Record<AlertTone, string> = {
  error: 'text-danger',
  info: 'text-link',
  success: 'text-success',
};

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  title: string;
  children?: ReactNode;
}

/**
 * Inline message. The tone is carried by an icon and by the live-region role, never by colour
 * alone: an error is announced at once (`alert`), the others politely (`status`).
 */
export function Alert({ tone = 'info', title, children, className, ...props }: AlertProps) {
  const Icon = ICON[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-tone={tone}
      className={cn(
        'flex gap-2.5 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm',
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', ICON_TONE[tone])} />
      <div className="min-w-0">
        <p className="font-medium text-foreground">{title}</p>
        {children ? <div className="mt-0.5 text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}
