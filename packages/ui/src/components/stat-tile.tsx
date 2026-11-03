import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import type { TintId } from '../tokens/colors.js';
import { HelpHint } from './help-hint.js';
import type { ChipIcon } from './tint-chip.js';
import { TINT_CLASSES } from './tint.js';

export type StatTileState = 'ok' | 'unavailable' | 'restricted';

export interface StatTileProps {
  /** What the number counts, sentence case, no trailing colon. */
  label: string;
  /** A lucide icon before the label. */
  icon?: ChipIcon;
  /** The hue of the icon. It never carries meaning alone: the label says it. */
  tone?: TintId;
  /**
   * `ok` shows `value`. `unavailable` (cannot be computed) and `restricted` (this role does not see
   * it) show `note` instead and never a number: a missing figure is not a zero (N5).
   */
  state?: StatTileState;
  /** The figure. Not tabular: a large standalone number keeps proportional digits. */
  value?: ReactNode;
  /** Why there is no figure, for `unavailable` and `restricted`. */
  note?: string;
  noteIcon?: ChipIcon;
  /** A second line under the figure ("p90 4h 10m", "3 of 40"). */
  detail?: ReactNode;
  /** The figure needs attention: it is drawn in the danger text colour and the caller adds an icon. */
  alert?: boolean;
  /** How the figure is defined (basis, `[ASSUMED]` rule). Behind a `?` button, also reachable by keyboard. */
  info?: ReactNode;
  /** The accessible name of the `?` button. Required with `info`. */
  infoLabel?: string;
  className?: string;
}

/**
 * One headline number (dataviz: a single number is a stat tile, not a chart). Label, figure and an
 * optional second line. The figure area keeps one height whatever it holds, so a refetch that
 * changes a number, or one that turns a number into a reason, never moves the tiles around it.
 */
export function StatTile({
  label,
  icon: Icon,
  tone = 'slate',
  state = 'ok',
  value,
  note,
  noteIcon: NoteIcon,
  detail,
  alert = false,
  info,
  infoLabel,
  className,
}: StatTileProps) {
  return (
    <div
      data-state={state}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-card bg-surface px-4 py-3 shadow-card',
        className,
      )}
    >
      <div className="flex min-h-6 items-center gap-1.5">
        {Icon ? (
          <Icon aria-hidden className={cn('size-3.5 shrink-0', TINT_CLASSES[tone].icon)} />
        ) : null}
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</p>
        {info && infoLabel ? <HelpHint label={infoLabel}>{info}</HelpHint> : null}
      </div>
      <div className="flex min-h-10 items-center">
        {state === 'ok' ? (
          <p
            className={cn(
              'text-[1.8667rem] leading-tight font-light',
              alert ? 'text-danger' : 'text-foreground-strong',
            )}
          >
            {value}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-sm leading-snug text-muted-foreground">
            {NoteIcon ? <NoteIcon aria-hidden className="size-4 shrink-0" /> : null}
            <span>{note}</span>
          </p>
        )}
      </div>
      {detail ? <div className="min-h-5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}
