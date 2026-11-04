'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROSTER_MAX_RANGE_DAYS, type RosterEntry, type ShiftDefinition } from '@watchtower/shared';
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@watchtower/ui';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { FormField } from '@/components/portal/form-field';
import { useShiftFormat } from '@/components/shift/shift-bits';
import { RosterPlannerTab } from './roster-planner';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { usePreferences } from '@/lib/preferences';
import { addDays, dateKeyInZone, weekStart } from '@/lib/shifts/model';
import { shiftKeys, useAssignees, useRoster, useShiftDefinitions } from '@/lib/shifts/queries';

export function ShiftsAdminPage() {
  return (
    <RequirePermission permission="roster.manage" role="lead">
      <ShiftsAdminBody />
    </RequirePermission>
  );
}

function ShiftsAdminBody() {
  const { t } = useI18n();
  const definitions = useShiftDefinitions();
  return (
    <>
      <AdminHeader
        title={t('admin.sections.shifts')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.shifts') },
        ]}
      />
      <AdminBody>
        {definitions.isPending ? (
          <TableSkeleton />
        ) : definitions.isError ? (
          <LoadError onRetry={() => void definitions.refetch()} />
        ) : (
          <Tabs defaultValue="roster" className="flex flex-col gap-3 p-4">
            <TabsList aria-label={t('shift.admin.tabsLabel')}>
              <TabsTrigger value="roster">{t('shift.admin.roster')}</TabsTrigger>
              <TabsTrigger value="definitions">{t('shift.admin.definitions')}</TabsTrigger>
              <TabsTrigger value="planner">{t('rosterPlan.tab')}</TabsTrigger>
            </TabsList>
            <p className="text-xs text-muted-foreground">
              {t('shift.admin.zone', { zone: definitions.data.timezone })}
            </p>
            <TabsContent value="roster">
              <RosterTab
                timezone={definitions.data.timezone}
                definitions={definitions.data.definitions}
              />
            </TabsContent>
            <TabsContent value="definitions">
              <DefinitionsTab definitions={definitions.data.definitions} />
            </TabsContent>
            <TabsContent value="planner">
              <RosterPlannerTab
                timezone={definitions.data.timezone}
                definitions={definitions.data.definitions}
              />
            </TabsContent>
          </Tabs>
        )}
      </AdminBody>
    </>
  );
}

// --- definitions ---

function DefinitionsTab({ definitions }: { definitions: readonly ShiftDefinition[] }) {
  const { t } = useI18n();
  const { singleKeyShortcuts } = usePreferences();
  const [sheet, setSheet] = useState<{ definition: ShiftDefinition | null } | null>(null);

  const columns: DataTableColumn<ShiftDefinition>[] = [
    {
      id: 'name',
      header: t('shift.admin.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <button
          type="button"
          onClick={() => {
            setSheet({ definition: row });
          }}
          className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row.name}
        </button>
      ),
    },
    {
      id: 'time',
      header: `${t('shift.admin.starts')} – ${t('shift.admin.ends')}`,
      sortValue: (row) => row.startsAt,
      cell: (row) => (
        <span className="tabular">
          {row.startsAt}–{row.endsAt}
          {row.overnight ? (
            <span className="text-muted-foreground"> ({t('shift.admin.overnight')})</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'onCall',
      header: t('shift.admin.onCall'),
      cell: (row) => (row.onCall ? t('admin.common.yes') : '—'),
    },
    {
      id: 'active',
      header: t('admin.common.status'),
      cell: (row) => (row.active ? t('shift.admin.active') : t('shift.admin.inactive')),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="primary"
          onClick={() => {
            setSheet({ definition: null });
          }}
        >
          <Plus aria-hidden className="size-4" />
          {t('shift.admin.newShift')}
        </Button>
      </div>
      {definitions.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title={t('shift.admin.definitionsEmpty')} />
      ) : (
        <DataTable
          caption={t('shift.admin.definitions')}
          captionHidden
          columns={columns}
          rows={definitions}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.name}
          vimKeys={singleKeyShortcuts}
          onRowActivate={(row) => {
            setSheet({ definition: row });
          }}
        />
      )}
      {sheet ? (
        <DefinitionSheet
          definition={sheet.definition}
          onClose={() => {
            setSheet(null);
          }}
        />
      ) : null}
    </div>
  );
}

function DefinitionSheet({
  definition,
  onClose,
}: {
  definition: ShiftDefinition | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [name, setName] = useState(definition?.name ?? '');
  const [startsAt, setStartsAt] = useState(definition?.startsAt ?? '08:00');
  const [endsAt, setEndsAt] = useState(definition?.endsAt ?? '17:00');
  const [onCall, setOnCall] = useState(definition?.onCall ?? false);
  const [active, setActive] = useState(definition?.active ?? true);
  const [errors, setErrors] = useState<{ name?: string; endsAt?: string }>({});
  const [summary, setSummary] = useState<string | null>(null);

  const dirty =
    definition === null
      ? name !== ''
      : name !== definition.name ||
        startsAt !== definition.startsAt ||
        endsAt !== definition.endsAt ||
        onCall !== definition.onCall ||
        active !== definition.active;

  const save = useMutation({
    mutationFn: () =>
      definition === null
        ? api.createShiftDefinition({ name: name.trim(), startsAt, endsAt, onCall })
        : api.updateShiftDefinition(definition.id, {
            name: name.trim(),
            startsAt,
            endsAt,
            onCall,
            active,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
      toast(t('shift.admin.saved'));
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={
        definition
          ? t('shift.admin.editShift', { name: definition.name })
          : t('shift.admin.newShift')
      }
      description={t('admin.sections.shifts')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSummary(null);
          const next: { name?: string; endsAt?: string } = {};
          if (name.trim() === '') next.name = t('shift.common.required');
          if (startsAt === endsAt) next.endsAt = t('shift.admin.sameTime');
          setErrors(next);
          if (next.name || next.endsAt) return;
          save.mutate();
        }}
      >
        <FormField
          id={`${base}-name`}
          label={t('shift.admin.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            maxLength={60}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </FormField>
        <div className="flex gap-3">
          <FormField id={`${base}-start`} label={t('shift.admin.starts')}>
            <Input
              id={`${base}-start`}
              type="time"
              value={startsAt}
              onChange={(event) => {
                setStartsAt(event.target.value);
              }}
            />
          </FormField>
          <FormField
            id={`${base}-end`}
            label={t('shift.admin.ends')}
            {...(errors.endsAt ? { error: errors.endsAt } : {})}
          >
            <Input
              id={`${base}-end`}
              type="time"
              value={endsAt}
              aria-invalid={errors.endsAt ? true : undefined}
              aria-describedby={errors.endsAt ? `${base}-end-error` : undefined}
              onChange={(event) => {
                setEndsAt(event.target.value);
              }}
            />
          </FormField>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onCall}
            onChange={(event) => {
              setOnCall(event.target.checked);
            }}
            className="size-4"
          />
          {t('shift.admin.onCallLabel')}
        </label>
        {definition ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(event) => {
                setActive(event.target.checked);
              }}
              className="size-4"
            />
            {t('shift.admin.activeLabel')}
          </label>
        ) : null}
      </form>
    </EntitySheet>
  );
}

// --- roster ---

function RosterTab({
  timezone,
  definitions,
}: {
  timezone: string;
  definitions: readonly ShiftDefinition[];
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const format = useShiftFormat(timezone);
  const base = useId();
  const initialStart = useMemo(() => weekStart(dateKeyInZone(new Date(), timezone)), [timezone]);
  const [from, setFrom] = useState(initialStart);
  const [to, setTo] = useState(addDays(initialStart, 6));
  const rangeError =
    to < from
      ? t('shift.admin.rangeBackwards')
      : addDays(from, ROSTER_MAX_RANGE_DAYS) < to
        ? t('shift.admin.rangeTooLong')
        : null;
  const roster = useRoster({ from, to }, rangeError === null);
  const assignees = useAssignees();
  const people = assignees.data?.assignees ?? [];
  const activeShifts = definitions.filter((definition) => definition.active);
  const [personId, setPersonId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [date, setDate] = useState(from);
  const [errors, setErrors] = useState<{ person?: boolean; shift?: boolean; date?: boolean }>({});
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
  const add = useMutation({
    mutationFn: () => api.addRosterEntry({ shiftId, userId: personId, workDate: date }),
    onSuccess: async () => {
      setFailure(null);
      await refresh();
      toast(t('shift.admin.added'));
    },
    onError: (error) => {
      setFailure(describeError(error, t).message);
    },
  });
  const remove = useMutation({
    mutationFn: (entry: RosterEntry) => api.removeRosterEntry(entry.id),
    onSuccess: async () => {
      await refresh();
      toast(t('shift.admin.removed'));
    },
    onError: (error) => {
      setFailure(describeError(error, t).message);
    },
  });

  const byDay = useMemo(() => {
    const groups = new Map<string, RosterEntry[]>();
    for (const entry of roster.data?.entries ?? []) {
      groups.set(entry.workDate, [...(groups.get(entry.workDate) ?? []), entry]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [roster.data]);

  const moveWeek = (days: number) => {
    setFrom(addDays(from, days));
    setTo(addDays(to, days));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <FormField id={`${base}-from`} label={t('shift.admin.rosterFrom')}>
          <Input
            id={`${base}-from`}
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-to`}
          label={t('shift.admin.rosterTo')}
          {...(rangeError ? { error: rangeError } : {})}
        >
          <Input
            id={`${base}-to`}
            type="date"
            value={to}
            aria-invalid={rangeError ? true : undefined}
            aria-describedby={rangeError ? `${base}-to-error` : undefined}
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
        </FormField>
        <Button
          onClick={() => {
            moveWeek(-7);
          }}
        >
          {t('shift.admin.prevWeek')}
        </Button>
        <Button
          onClick={() => {
            setFrom(initialStart);
            setTo(addDays(initialStart, 6));
          }}
        >
          {t('shift.admin.thisWeek')}
        </Button>
        <Button
          onClick={() => {
            moveWeek(7);
          }}
        >
          {t('shift.admin.nextWeek')}
        </Button>
      </div>

      {roster.isPending && rangeError === null ? (
        <TableSkeleton rows={3} />
      ) : roster.isError ? (
        <LoadError onRetry={() => void roster.refetch()} />
      ) : byDay.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title={t('shift.admin.rosterEmpty')} />
      ) : (
        <div className="flex flex-col gap-3">
          {byDay.map(([day, entries]) => (
            <section key={day} aria-label={t('shift.admin.rosterDay', { date: day })}>
              <h3 className="text-sm font-semibold">{day}</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5 text-sm"
                  >
                    <span>
                      {t('shift.admin.entryLine', {
                        name: entry.userName,
                        shift: entry.shiftName,
                        range: `${format.time(entry.startsAt)}–${format.time(entry.endsAt)}`,
                      })}
                      {entry.onCall ? ` · ${t('shift.admin.onCall')}` : ''}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={remove.isPending}
                      aria-label={t('shift.admin.remove', {
                        name: entry.userName,
                        shift: entry.shiftName,
                        date: entry.workDate,
                      })}
                      onClick={() => {
                        remove.mutate(entry);
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <form
        noValidate
        aria-label={t('shift.admin.addEntry')}
        className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          const next = { person: personId === '', shift: shiftId === '', date: date === '' };
          setErrors(next);
          if (next.person || next.shift || next.date) return;
          add.mutate();
        }}
      >
        <FormField
          id={`${base}-person`}
          label={t('shift.admin.person')}
          {...(errors.person ? { error: t('shift.common.required') } : {})}
        >
          <Select
            id={`${base}-person`}
            value={personId}
            aria-invalid={errors.person ? true : undefined}
            aria-describedby={errors.person ? `${base}-person-error` : undefined}
            onChange={(event) => {
              setPersonId(event.target.value);
            }}
          >
            <option value="">
              {people.length === 0 ? t('shift.admin.noStaff') : t('shift.admin.pick')}
            </option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          id={`${base}-shift`}
          label={t('shift.admin.shift')}
          {...(errors.shift ? { error: t('shift.common.required') } : {})}
        >
          <Select
            id={`${base}-shift`}
            value={shiftId}
            aria-invalid={errors.shift ? true : undefined}
            aria-describedby={errors.shift ? `${base}-shift-error` : undefined}
            onChange={(event) => {
              setShiftId(event.target.value);
            }}
          >
            <option value="">{t('shift.admin.pick')}</option>
            {activeShifts.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name} ({definition.startsAt}–{definition.endsAt})
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          id={`${base}-date`}
          label={t('shift.admin.date')}
          {...(errors.date ? { error: t('shift.common.required') } : {})}
        >
          <Input
            id={`${base}-date`}
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </FormField>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          <Plus aria-hidden className="size-4" />
          {add.isPending ? t('shift.common.saving') : t('shift.admin.add')}
        </Button>
      </form>
      {failure ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
