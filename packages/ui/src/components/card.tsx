import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** `section` when the card is a landmark region with a heading (pass `aria-labelledby`). */
  as?: 'div' | 'section' | 'article';
}

/**
 * A Soft Beacon card (docs/design/redesign-2026-11): white on the Canvas, no border, a very soft
 * shadow, 20 px corners. Layout and padding inside are the caller's.
 */
export function Card({ as: Tag = 'div', className, ...props }: CardProps) {
  return <Tag className={cn('rounded-card bg-surface shadow-card', className)} {...props} />;
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The card title, 18 px weight 500. Put the heading element in it (`<h2 id=...>`). */
  title: ReactNode;
  /** A one-line explanation under the title. */
  subtitle?: ReactNode;
  /** Small pill buttons on the right (filters, "View all"). */
  actions?: ReactNode;
}

/** The title row of a card: title and subtitle on the left, small actions on the right. */
export function CardHeader({ title, subtitle, actions, className, ...props }: CardHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-2', className)} {...props}>
      <div className="min-w-0">
        <div className="text-title font-medium text-foreground-strong">{title}</div>
        {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * The highlight card: one fact worth a glance on a navy ground with a seafoam glow (not gold, so it
 * never reads as a warning). States facts and a breakdown; it never blinks or celebrates.
 */
export function HighlightCard({ as: Tag = 'div', className, ...props }: CardProps) {
  return (
    <Tag
      className={cn(
        'rounded-card bg-highlight p-5 shadow-card [&_.text-muted-foreground]:text-highlight-muted',
        className,
      )}
      {...props}
    />
  );
}
