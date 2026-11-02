'use client';

import type { DashboardNotAvailableReason } from '@watchtower/shared';
import { type ChipIcon, SectionHeading, StatTile, type TintId } from '@watchtower/ui';
import { CircleOff, Hourglass, Lock, SearchX, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import { useT } from '@/i18n/provider';

/** What the api answers for one figure: the data, why there is none, or that this role does not see it. */
export type DashboardFigure<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_available'; reason: DashboardNotAvailableReason }
  | { status: 'restricted'; requires: string };

/** One icon per reason, so the four are told apart without reading: they mean different things. */
export const NOT_AVAILABLE_ICONS: Record<DashboardNotAvailableReason, ChipIcon> = {
  no_data: SearchX,
  needs_grader: Hourglass,
  not_collected: CircleOff,
  not_implemented: Wrench,
};

/**
 * The reason a figure is missing, or that the role does not see it, as one short line with an icon.
 * Never a number: a missing figure is not a zero, a hidden one is not a blank (N5).
 */
export function useFigureNote() {
  const t = useT();
  return (figure: Exclude<DashboardFigure<unknown>, { status: 'ok' }>) =>
    figure.status === 'restricted'
      ? { note: t('dashboard.restricted'), noteIcon: Lock as ChipIcon }
      : {
          note: t(`dashboard.na.${figure.reason}`),
          noteIcon: NOT_AVAILABLE_ICONS[figure.reason],
        };
}

export interface FigureProps<T> {
  label: string;
  icon?: ChipIcon;
  tone?: TintId;
  value: DashboardFigure<T>;
  /** The figure as text, from the data. */
  show: (data: T) => ReactNode;
  detail?: (data: T) => ReactNode;
  /** The figure needs attention. The label and `icon` already say what it is, colour only adds. */
  alert?: (data: T) => boolean;
  info?: ReactNode;
  infoLabel?: string;
}

/**
 * A stat tile fed by one `{ status }` figure of the dashboard read model. `ok` shows the number
 * (a real zero included), `not_available` shows its reason in words, `restricted` says the role
 * does not see it. The tile keeps one height in all three states.
 */
export function Figure<T>({
  label,
  icon,
  tone,
  value,
  show,
  detail,
  alert,
  info,
  infoLabel,
}: FigureProps<T>) {
  const describe = useFigureNote();
  const shared = {
    label,
    ...(icon ? { icon } : {}),
    ...(tone ? { tone } : {}),
    ...(info && infoLabel ? { info, infoLabel } : {}),
  };
  if (value.status !== 'ok') {
    return (
      <StatTile
        {...shared}
        state={value.status === 'restricted' ? 'restricted' : 'unavailable'}
        {...describe(value)}
      />
    );
  }
  return (
    <StatTile
      {...shared}
      value={show(value.data)}
      {...(detail ? { detail: detail(value.data) } : {})}
      {...(alert?.(value.data) ? { alert: true } : {})}
    />
  );
}

/** One line for a whole section the role does not see, or that has nothing to compute from. */
export function SectionNote({
  figure,
}: {
  figure: Exclude<DashboardFigure<unknown>, { status: 'ok' }>;
}) {
  const describe = useFigureNote();
  const { note, noteIcon: Icon } = describe(figure);
  return (
    <p
      data-state={figure.status === 'restricted' ? 'restricted' : 'unavailable'}
      className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground"
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>{note}</span>
    </p>
  );
}

/** A section of the dashboard: a heading with its icon, then the figures. */
export function DashboardSection({
  id,
  icon,
  tone,
  title,
  children,
}: {
  id: string;
  icon: ChipIcon;
  tone: TintId;
  title: string;
  children: ReactNode;
}) {
  const headingId = `dashboard-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-section={id}
      className="flex flex-col gap-3 py-3 first:pt-0"
    >
      <h2 id={headingId} className="text-title font-medium text-foreground-strong">
        <SectionHeading tone={tone} icon={icon} plain>
          {title}
        </SectionHeading>
      </h2>
      {children}
    </section>
  );
}

/** The grid the tiles of a section sit in: two across on a phone, as many as fit on a desktop. */
export function TileGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">{children}</div>
  );
}
