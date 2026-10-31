'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  holidaySchema,
  type Holiday,
  type Weekday,
  WEEKDAYS,
  type WeeklyHours,
} from '@watchtower/shared';
import {
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  Pill,
  toast,
} from '@watchtower/ui';
import {
  CalendarDays,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { z } from 'zod';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { useI18n } from '@/i18n/provider';
import type { CalendarView, HolidayView } from '@/lib/admin/contracts';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useCalendar } from '@/lib/admin/queries';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

export function CalendarPage({ calendarId }: { calendarId: string }) {
  return (
    <RequirePermission permission="sla.manage" role="head">
      <CalendarBody calendarId={calendarId} />
    </RequirePermission>
  );
}

const holidaysOf = (calendar: CalendarView): Holiday[] =>
  calendar.holidays.map(({ date, name }) => ({ date, name }));

function CalendarBody({ calendarId }: { calendarId: string }) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const calendar = useCalendar(calendarId);
  const base = useId();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<{
    fresh: Holiday[];
    duplicates: Holiday[];
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const data = calendar.data;
  const stored = (next: CalendarView) => {
    queryClient.setQueryData(adminKeys(userId).calendar(calendarId), next);
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).calendars });
  };

  const patch = useMutation({
    mutationFn: (body: { holidays?: Holiday[]; hours?: WeeklyHours }) =>
      api.updateCalendar(calendarId, body),
    onSuccess: (next) => {
      stored(next);
      setSummary(null);
      toast(t('admin.common.saved'));
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });
  const check = useMutation({
    mutationFn: ({ day, checked }: { day: string; checked: boolean }) =>
      api.checkHoliday(calendarId, day, checked),
    onSuccess: (next) => {
      stored(next);
      setSummary(null);
    },
    onError: (error) => {
      setSummary(
        isApiError(error) && error.status === 404
          ? t('admin.cal.checkUnavailable')
          : describeError(error, t).message,
      );
    },
  });

  const addHoliday = () => {
    if (!data) return;
    const parsed = holidaySchema.safeParse({ date, name });
    if (!parsed.success) {
      setAddError(t('admin.cal.holidayInvalid'));
      return;
    }
    if (data.holidays.some((holiday) => holiday.date === parsed.data.date)) {
      setAddError(t('admin.cal.duplicate'));
      return;
    }
    setAddError(null);
    patch.mutate({ holidays: [...holidaysOf(data), parsed.data] });
    setDate('');
    setName('');
  };

  const onFile = async (file: File | undefined) => {
    if (!file || !data) return;
    setImportError(null);
    try {
      const raw: unknown = JSON.parse(await file.text());
      const list = z
        .array(holidaySchema)
        .parse(Array.isArray(raw) ? raw : (raw as { holidays?: unknown }).holidays);
      const known = new Set(data.holidays.map((holiday) => holiday.date));
      const seen = new Set<string>();
      const fresh: Holiday[] = [];
      const duplicates: Holiday[] = [];
      for (const holiday of list) {
        if (known.has(holiday.date) || seen.has(holiday.date)) duplicates.push(holiday);
        else {
          seen.add(holiday.date);
          fresh.push(holiday);
        }
      }
      setImportPreview({ fresh, duplicates });
    } catch {
      setImportError(t('admin.cal.importInvalid'));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const weekday = (day: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(`${day}T00:00:00Z`),
    );

  const columns: DataTableColumn<HolidayView>[] = [
    {
      id: 'date',
      header: t('admin.cal.date'),
      sortValue: (row) => row.date,
      className: 'tabular whitespace-nowrap',
      cell: (row) => `${row.date} · ${weekday(row.date)}`,
    },
    { id: 'name', header: t('admin.common.name'), cell: (row) => row.name },
    {
      id: 'state',
      header: t('admin.cal.state'),
      sortValue: (row) => (row.checked ? 1 : 0),
      cell: (row) =>
        row.checked ? (
          <Pill data-checked="true">
            <ShieldCheck aria-hidden className="size-3" />
            {t('admin.cal.checked')}
          </Pill>
        ) : (
          <Pill data-checked="false">
            <ShieldQuestion aria-hidden className="size-3" />
            {t('admin.cal.notChecked')}
          </Pill>
        ),
    },
    {
      id: 'actions',
      header: t('admin.common.actions'),
      hideHeader: true,
      className: 'text-right whitespace-nowrap',
      cell: (row) => (
        <span className="inline-flex gap-1">
          <Button
            size="sm"
            aria-label={`${row.checked ? t('admin.cal.unmarkChecked') : t('admin.cal.markChecked')}: ${row.name}`}
            disabled={check.isPending}
            onClick={() => {
              check.mutate({ day: row.date, checked: !row.checked });
            }}
          >
            {row.checked ? t('admin.cal.unmark') : t('admin.cal.mark')}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('admin.cal.remove', { name: row.name })}
            onClick={() => {
              if (data) {
                patch.mutate({
                  holidays: holidaysOf(data).filter((holiday) => holiday.date !== row.date),
                });
              }
            }}
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </span>
      ),
    },
  ];

  const unchecked = data?.holidays.filter((holiday) => !holiday.checked).length ?? 0;

  return (
    <>
      <AdminHeader
        title={data?.name ?? t('admin.sla.calendars')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.sla'), href: '/admin/sla' },
          { label: data?.name ?? '…' },
        ]}
      />
      <AdminBody>
        {calendar.isPending ? (
          <TableSkeleton />
        ) : calendar.isError || !data ? (
          <LoadError onRetry={() => void calendar.refetch()} />
        ) : (
          <>
            <WeeklyHoursForm
              key={data.updatedAt}
              hours={data.hours}
              timezone={data.timezone}
              pending={patch.isPending}
              onSave={(hours) => {
                patch.mutate({ hours });
              }}
            />
            <section aria-labelledby={`${base}-holidays`} className="border-t border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
                <h2 id={`${base}-holidays`} className="text-sm font-semibold">
                  {t('admin.sla.holidays')}
                </h2>
                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    aria-label={t('admin.cal.import')}
                    onChange={(event) => void onFile(event.target.files?.[0])}
                  />
                  <Button
                    onClick={() => {
                      fileRef.current?.click();
                    }}
                  >
                    <Upload aria-hidden className="size-4" />
                    {t('admin.cal.import')}
                  </Button>
                </div>
              </div>
              {unchecked > 0 ? (
                <p
                  className="flex items-start gap-1.5 px-4 pt-2 text-sm"
                  data-testid="verify-warning"
                >
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {t('admin.cal.verifyWarn')}
                </p>
              ) : null}
              {summary ? (
                <p role="alert" className="px-4 pt-2 text-sm font-medium text-danger">
                  {summary}
                </p>
              ) : null}
              {importError ? (
                <p role="alert" className="px-4 pt-2 text-sm font-medium text-danger">
                  {importError}
                </p>
              ) : null}
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  addHoliday();
                }}
                className="flex flex-wrap items-end gap-2 px-4 py-3"
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${base}-date`} className="text-xs text-muted-foreground">
                    {t('admin.cal.date')}
                  </label>
                  <Input
                    id={`${base}-date`}
                    type="date"
                    value={date}
                    onChange={(event) => {
                      setDate(event.target.value);
                    }}
                  />
                </div>
                <div className="flex min-w-48 flex-1 flex-col gap-1">
                  <label htmlFor={`${base}-name`} className="text-xs text-muted-foreground">
                    {t('admin.common.name')}
                  </label>
                  <Input
                    id={`${base}-name`}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </div>
                <Button type="submit" disabled={patch.isPending}>
                  {t('admin.common.add')}
                </Button>
                {addError ? (
                  <p role="alert" className="w-full text-sm font-medium text-danger">
                    {addError}
                  </p>
                ) : null}
              </form>
              {data.holidays.length === 0 ? (
                <EmptyState icon={<CalendarDays />} title={t('admin.cal.empty')} />
              ) : (
                <DataTable
                  caption={t('admin.sla.holidays')}
                  captionHidden
                  columns={columns}
                  rows={data.holidays}
                  getRowId={(row) => row.date}
                  getRowLabel={(row) => `${row.date} ${row.name}`}
                  defaultSort={{ columnId: 'date', direction: 'asc' }}
                />
              )}
            </section>
          </>
        )}
      </AdminBody>
      <Dialog
        open={importPreview !== null}
        onOpenChange={(open) => {
          if (!open) setImportPreview(null);
        }}
      >
        {importPreview ? (
          <DialogContent
            title={t('admin.cal.importTitle')}
            description={t('admin.cal.importSummary', {
              fresh: importPreview.fresh.length,
              duplicates: importPreview.duplicates.length,
            })}
            closeLabel={t('admin.common.close')}
            footer={
              <>
                <Button
                  onClick={() => {
                    setImportPreview(null);
                  }}
                >
                  {t('admin.common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={importPreview.fresh.length === 0 || patch.isPending}
                  onClick={() => {
                    if (data) {
                      patch.mutate({ holidays: [...holidaysOf(data), ...importPreview.fresh] });
                    }
                    setImportPreview(null);
                  }}
                >
                  {t('admin.cal.importConfirm', { count: importPreview.fresh.length })}
                </Button>
              </>
            }
          >
            <ul className="max-h-60 divide-y divide-border overflow-y-auto text-sm">
              {importPreview.fresh.map((holiday) => (
                <li key={holiday.date} className="flex gap-3 py-1">
                  <span className="tabular">{holiday.date}</span>
                  <span>{holiday.name}</span>
                </li>
              ))}
              {importPreview.duplicates.map((holiday) => (
                <li key={`dup-${holiday.date}`} className="flex gap-3 py-1 text-muted-foreground">
                  <span className="tabular">{holiday.date}</span>
                  <span>{holiday.name}</span>
                  <span className="ml-auto">{t('admin.cal.duplicateFlag')}</span>
                </li>
              ))}
            </ul>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

interface DayState {
  open: boolean;
  start: string;
  end: string;
}

function WeeklyHoursForm({
  hours,
  timezone,
  pending,
  onSave,
}: {
  hours: WeeklyHours;
  timezone: string;
  pending: boolean;
  onSave: (hours: WeeklyHours) => void;
}) {
  const { t } = useI18n();
  const base = useId();
  const [days, setDays] = useState<Record<Weekday, DayState>>(() => {
    const entries = WEEKDAYS.map((day): [Weekday, DayState] => {
      const first = hours[day][0];
      return [
        day,
        { open: first !== undefined, start: first?.start ?? '09:00', end: first?.end ?? '18:00' },
      ];
    });
    return Object.fromEntries(entries) as Record<Weekday, DayState>;
  });
  const [dirty, setDirty] = useState(false);

  const build = (): WeeklyHours => {
    const result = {} as WeeklyHours;
    for (const day of WEEKDAYS) {
      const state = days[day];
      const rest = hours[day].slice(1);
      result[day] = state.open ? [{ start: state.start, end: state.end }, ...rest] : [];
    }
    return result;
  };
  const patchDay = (day: Weekday, change: Partial<DayState>) => {
    setDays((current) => ({ ...current, [day]: { ...current[day], ...change } }));
    setDirty(true);
  };

  return (
    <section aria-labelledby={`${base}-hours`} className="px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={`${base}-hours`} className="text-sm font-semibold">
          {t('admin.cal.hours')}
        </h2>
        <span className="text-xs text-muted-foreground">{timezone}</span>
      </div>
      <ul className="flex max-w-xl flex-col gap-1">
        {WEEKDAYS.map((day) => (
          <li
            key={day}
            className="grid grid-cols-[6rem_1fr] items-center gap-2 sm:grid-cols-[6rem_6rem_1fr]"
          >
            <span className="text-sm">{t(`admin.cal.days.${day}`)}</span>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={days[day].open}
                onChange={(event) => {
                  patchDay(day, { open: event.target.checked });
                }}
                className="size-4"
              />
              {t('admin.cal.open')}
            </label>
            <span className="col-span-2 flex items-center gap-2 sm:col-span-1">
              <Input
                type="time"
                aria-label={t('admin.cal.from', { day: t(`admin.cal.days.${day}`) })}
                value={days[day].start}
                disabled={!days[day].open}
                onChange={(event) => {
                  patchDay(day, { start: event.target.value });
                }}
              />
              <span aria-hidden>–</span>
              <Input
                type="time"
                aria-label={t('admin.cal.to', { day: t(`admin.cal.days.${day}`) })}
                value={days[day].end}
                disabled={!days[day].open}
                onChange={(event) => {
                  patchDay(day, { end: event.target.value });
                }}
              />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <Button
          variant="primary"
          disabled={pending || !dirty}
          onClick={() => {
            onSave(build());
          }}
        >
          {pending ? t('admin.form.saving') : t('admin.common.save')}
        </Button>
      </div>
    </section>
  );
}
