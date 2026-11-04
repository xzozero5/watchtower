import type { BarChartSegment } from '@watchtower/ui';

/**
 * Channel hues for the stacked volume bars. The class names are written out in full so Tailwind
 * generates them; the three tokens exist in `packages/ui` (`chart-email/line/portal`).
 */
const CHANNEL_FILL: Readonly<Record<string, { key: string; fillClass: string }>> = {
  gmail: { key: 'gmail', fillClass: 'fill-chart-email' },
  line: { key: 'line', fillClass: 'fill-chart-line' },
  portal: { key: 'portal', fillClass: 'fill-chart-portal' },
};
const OTHER = { key: 'other', fillClass: 'fill-muted-foreground/50' } as const;
const ORDER = ['gmail', 'line', 'portal', 'other'] as const;

/** The channel name the legend shows: the three with a hue by name, every other channel as "Other". */
export const legendChannel = (channel: string): 'gmail' | 'line' | 'portal' | 'other' =>
  channel === 'gmail' || channel === 'line' || channel === 'portal' ? channel : 'other';

/** One day's tickets by channel as stacked parts: email, LINE, portal, then everything else as one. */
export function channelSegments(
  byChannel: Readonly<Record<string, number>>,
  nameOf: (channel: string) => string,
): BarChartSegment[] {
  const totals = new Map<string, number>();
  for (const [channel, value] of Object.entries(byChannel)) {
    const key = (CHANNEL_FILL[channel] ?? OTHER).key;
    totals.set(key, (totals.get(key) ?? 0) + value);
  }
  return ORDER.flatMap((key) => {
    const value = totals.get(key);
    if (value === undefined || value <= 0) return [];
    const fillClass = (CHANNEL_FILL[key] ?? OTHER).fillClass;
    return [{ key, label: nameOf(key), value, fillClass }];
  });
}

export interface VolumeTrend {
  direction: 'up' | 'down' | 'flat';
  /** Whole percent, absolute. */
  percent: number;
}

/**
 * Change against the window before. With nothing before there is no base to compare to, so no chip
 * (null) rather than "+infinity". A change that rounds to 0 % reads as flat.
 */
export function volumeTrend(current: number, previous: number): VolumeTrend | null {
  if (previous <= 0) return null;
  const percent = Math.round((Math.abs(current - previous) / previous) * 100);
  if (percent === 0) return { direction: 'flat', percent: 0 };
  return { direction: current > previous ? 'up' : 'down', percent };
}
