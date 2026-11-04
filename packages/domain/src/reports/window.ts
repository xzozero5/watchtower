const DAY_MS = 86_400_000;

export interface ReportWindow {
  readonly from: Date;
  readonly to: Date;
  readonly days: number;
  /** The same number of whole days right before `from`. */
  readonly previousFrom: Date;
}

/**
 * `days` whole UTC days ending now, today included (the same window as the ops dashboard), and the
 * period of equal length right before it for the trend.
 */
export function reportWindow(now: Date, days: number): ReportWindow {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * DAY_MS);
  return { from, to: now, days, previousFrom: new Date(from.getTime() - days * DAY_MS) };
}

/** The UTC days of a window, oldest first, as `YYYY-MM-DD`. */
export function windowDays(window: ReportWindow): string[] {
  return Array.from({ length: window.days }, (_, offset) =>
    new Date(window.from.getTime() + offset * DAY_MS).toISOString().slice(0, 10),
  );
}
