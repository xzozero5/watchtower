'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ROSTER_PLAN_LIMITS,
  type CreateRosterPlan,
  type RosterPlan,
  type RosterPlanDefaults,
  type ShiftDefinition,
} from '@watchtower/shared';
import { Alert, Button, Dialog, DialogContent, Input, Pill, Select, toast } from '@watchtower/ui';
import { CalendarClock, CircleCheck, CircleX, Lock, Plus, Sparkles, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { LoadError, TableSkeleton } from '@/components/admin/admin-page';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import type { Translate } from '@/i18n';
import { describeError } from '@/lib/admin/errors';
import { useApi } from '@/lib/api/api-context';
import { isApiError } from '@/lib/api/errors';
import { useUserId } from '@/lib/auth/session';
import { addDays, dateKeyInZone, weekStart as mondayOf } from '@/lib/shifts/model';
import {
  rosterPlanKeys,
  useRosterPlan,
  useRosterPlanDefaults,
  useRosterPlans,
} from '@/lib/shifts/roster-plan-queries';
import { shiftKeys } from '@/lib/shifts/queries';

type Failure = RosterPlan['report']['items'][number]['failures'][number];

const ITEM_KEYS = {
  unavailable: 'rosterPlan.report.unavailable',
  rest: 'rosterPlan.report.rest',
  max_shifts_week: 'rosterPlan.report.max_shifts_week',
  max_consecutive_days: 'rosterPlan.report.max_consecutive_days',
  max_consecutive_nights: 'rosterPlan.report.max_consecutive_nights',
  coverage: 'rosterPlan.report.coverage',
  fairness_nights: 'rosterPlan.report.fairness_nights',
  fairness_heavy_days: 'rosterPlan.report.fairness_heavy_days',
} as const;

const KIND_KEYS = {
  hard: 'rosterPlan.report.kindHard',
  coverage: 'rosterPlan.report.kindCoverage',
  fairness: 'rosterPlan.report.kindFairness',
} as const;

const REASON_KEYS = {
  unavailable: 'rosterPlan.report.reason.unavailable',
  rest: 'rosterPlan.report.reason.rest',
  max_shifts_week: 'rosterPlan.report.reason.max_shifts_week',
  max_consecutive_days: 'rosterPlan.report.reason.max_consecutive_days',
  max_consecutive_nights: 'rosterPlan.report.reason.max_consecutive_nights',
  not_in_queue: 'rosterPlan.report.reason.not_in_queue',
} as const;

const STATUS_KEYS = {
  draft: 'rosterPlan.recent.draft',
  applied: 'rosterPlan.recent.applied',
  discarded: 'rosterPlan.recent.discarded',
} as const;

/** `Mon 2 Nov` in the language of the page; the date is a calendar date, so no zone shifts it. */
function useDateLabel() {
  const { locale } = useI18n();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    return (dateKey: string) => format.format(new Date(`${dateKey}T00:00:00Z`));
  }, [locale]);
}

/**
 * The roster planner (T-305e, PRD R-7.2), the Planner tab of Shifts and roster, lead and head. The plan is made by a
 * fixed-rule solver on the server; the AI only explains it, and nothing reaches the roster until a person applies it.
 */
export function RosterPlannerTab({
  timezone,
}: {
  timezone: string;
  definitions: readonly ShiftDefinition[];
}) {
  const { t } = useI18n();
  const plans = useRosterPlans();
  const [planId, setPlanId] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('rosterPlan.intro')}</p>
      <section aria-label={t('rosterPlan.recent.title')} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('rosterPlan.recent.title')}</h3>
          <AskAiElement element="roster.planner" />
          <Button
            onClick={() => {
              setPlanId(null);
            }}
          >
            <Plus aria-hidden className="size-4" />
            {t('rosterPlan.recent.newPlan')}
          </Button>
        </div>
        {plans.isPending ? (
          <TableSkeleton rows={2} />
        ) : plans.isError ? (
          <LoadError onRetry={() => void plans.refetch()} />
        ) : plans.data.plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('rosterPlan.recent.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {plans.data.plans.slice(0, 8).map((plan) => (
              <li key={plan.id}>
                <button
                  type="button"
                  aria-label={t('rosterPlan.recent.open', { week: plan.weekStart })}
                  aria-current={planId === plan.id ? 'true' : undefined}
                  onClick={() => {
                    setPlanId(plan.id);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5 text-start text-sm hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span>
                    {t('rosterPlan.recent.line', {
                      week: plan.weekStart,
                      count: plan.entryCount,
                    })}
                  </span>
                  <Pill>{t(STATUS_KEYS[plan.status])}</Pill>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {planId === null ? (
        <NewPlan timezone={timezone} onCreated={setPlanId} />
      ) : (
        <PlanView key={planId} planId={planId} />
      )}
    </div>
  );
}

// --- the form ---

function NewPlan({
  timezone,
  onCreated,
}: {
  timezone: string;
  onCreated: (planId: string) => void;
}) {
  const { t } = useI18n();
  const base = useId();
  const initial = useMemo(
    () => mondayOf(addDays(dateKeyInZone(new Date(), timezone), 7)),
    [timezone],
  );
  const [weekStart, setWeekStart] = useState(initial);
  const validWeek = /^\d{4}-\d{2}-\d{2}$/.test(weekStart);
  const defaults = useRosterPlanDefaults(weekStart, validWeek);
  return (
    <section aria-label={t('rosterPlan.form.title')} className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{t('rosterPlan.form.title')}</h3>
      <FormField id={`${base}-week`} label={t('rosterPlan.form.weekStart')}>
        <Input
          id={`${base}-week`}
          type="date"
          value={weekStart}
          onChange={(event) => {
            setWeekStart(event.target.value);
          }}
        />
      </FormField>
      <p className="-mt-2 text-xs text-muted-foreground">{t('rosterPlan.form.mondayHint')}</p>
      {!validWeek ? null : defaults.isPending ? (
        <TableSkeleton rows={3} />
      ) : defaults.isError ? (
        <Alert tone="error" title={t('rosterPlan.form.loadFailed')} />
      ) : (
        <PlanForm
          // A new week starts the form again from what the server suggests.
          key={defaults.data.weekStart}
          defaults={defaults.data}
          weekStart={weekStart}
          onCreated={onCreated}
        />
      )}
    </section>
  );
}

/** A whole number that can be empty while it is typed; the last valid value is kept and restored on blur. */
function NumberInput({
  id,
  value,
  min,
  max,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number.parseInt(event.target.value, 10);
        if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)));
      }}
      onBlur={() => {
        setText(String(value));
      }}
    />
  );
}

function PlanForm({
  defaults,
  weekStart,
  onCreated,
}: {
  defaults: RosterPlanDefaults;
  weekStart: string;
  onCreated: (planId: string) => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(defaults.people.map((person) => person.id)),
  );
  const [rules, setRules] = useState({ ...defaults.rules });
  const suggested = useMemo(() => {
    const out = new Map<string, number>();
    for (const shift of defaults.shifts) {
      const required = defaults.coverage
        .filter((rule) => rule.shiftId === shift.id)
        .map((rule) => rule.required);
      out.set(shift.id, required.length === 0 ? 1 : Math.max(...required));
    }
    return out;
  }, [defaults]);
  const [coverage, setCoverage] = useState<ReadonlyMap<string, number>>(suggested);
  const [coverageEdited, setCoverageEdited] = useState(false);
  const [leave, setLeave] = useState<readonly { userId: string; date: string }[]>([]);
  const [leaveUser, setLeaveUser] = useState('');
  const [leaveDate, setLeaveDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const nameOf = (id: string) => defaults.people.find((person) => person.id === id)?.name ?? '';

  const create = useMutation({
    mutationFn: (body: CreateRosterPlan) => api.createRosterPlan(body),
    onSuccess: async (plan) => {
      queryClient.setQueryData(rosterPlanKeys(userId).plan(plan.id), plan);
      await queryClient.invalidateQueries({ queryKey: rosterPlanKeys(userId).list });
      onCreated(plan.id);
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  const submit = () => {
    setError(null);
    if (selected.size === 0) {
      setError(t('rosterPlan.form.noPeople'));
      return;
    }
    const byUser = new Map<string, string[]>();
    for (const row of leave) {
      if (selected.has(row.userId))
        byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.date]);
    }
    create.mutate({
      weekStart,
      userIds: [...selected],
      rules,
      ...(coverageEdited
        ? {
            coverage: defaults.shifts.map((shift) => ({
              shiftId: shift.id,
              weekdays: [],
              required: coverage.get(shift.id) ?? 1,
              queueId: null,
            })),
          }
        : {}),
      ...(byUser.size === 0
        ? {}
        : { unavailable: [...byUser].map(([id, dates]) => ({ userId: id, dates })) }),
    });
  };

  const ruleField = (key: keyof typeof rules, label: string, min: number, max: number) => (
    <FormField id={`${base}-${key}`} label={label}>
      <NumberInput
        id={`${base}-${key}`}
        min={min}
        max={max}
        value={rules[key]}
        onCommit={(value) => {
          setRules({ ...rules, [key]: value });
        }}
      />
    </FormField>
  );

  return (
    <form
      noValidate
      aria-label={t('rosterPlan.form.title')}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('rosterPlan.form.people')}</legend>
        {defaults.people.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('rosterPlan.form.peopleNone')}</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {defaults.people.map((person) => (
              <label key={person.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={selected.has(person.id)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(person.id);
                    else next.delete(person.id);
                    setSelected(next);
                  }}
                />
                {person.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('rosterPlan.form.rules')}</legend>
        <div className="flex flex-wrap gap-3">
          {ruleField('minRestHours', t('rosterPlan.form.minRestHours'), 0, 24)}
          {ruleField('maxShiftsPerWeek', t('rosterPlan.form.maxShiftsPerWeek'), 1, 14)}
          {ruleField('maxConsecutiveDays', t('rosterPlan.form.maxConsecutiveDays'), 1, 14)}
          {ruleField('maxConsecutiveNights', t('rosterPlan.form.maxConsecutiveNights'), 1, 14)}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('rosterPlan.form.coverage')}</legend>
        <p className="text-xs text-muted-foreground">
          {coverageEdited
            ? t('rosterPlan.form.coverageEdited')
            : t('rosterPlan.form.coverageGuess', {
                n: ROSTER_PLAN_LIMITS.defaultTicketsPerPersonPerShift,
              })}
        </p>
        <div className="flex flex-wrap gap-3">
          {defaults.shifts.map((shift) => (
            <FormField
              key={shift.id}
              id={`${base}-cov-${shift.id}`}
              label={t('rosterPlan.form.coverageShift', {
                shift: shift.name,
                range: `${shift.startsAt}–${shift.endsAt}`,
              })}
            >
              <NumberInput
                id={`${base}-cov-${shift.id}`}
                min={0}
                max={ROSTER_PLAN_LIMITS.maxHeadCount}
                value={coverage.get(shift.id) ?? 1}
                onCommit={(value) => {
                  const next = new Map(coverage);
                  next.set(shift.id, value);
                  setCoverage(next);
                  setCoverageEdited(true);
                }}
              />
            </FormField>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('rosterPlan.form.leave')}</legend>
        {leave.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('rosterPlan.form.leaveNone')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {leave.map((row, index) => (
              <li key={`${row.userId}-${row.date}`}>
                <Pill>
                  {nameOf(row.userId)} · {row.date}
                  <button
                    type="button"
                    aria-label={t('rosterPlan.form.leaveRemove', {
                      name: nameOf(row.userId),
                      date: row.date,
                    })}
                    onClick={() => {
                      setLeave(leave.filter((_row, at) => at !== index));
                    }}
                    className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </Pill>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <FormField id={`${base}-leave-person`} label={t('rosterPlan.form.leavePerson')}>
            <Select
              id={`${base}-leave-person`}
              value={leaveUser}
              onChange={(event) => {
                setLeaveUser(event.target.value);
              }}
            >
              <option value="">{t('rosterPlan.form.pick')}</option>
              {defaults.people
                .filter((person) => selected.has(person.id))
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
            </Select>
          </FormField>
          <FormField id={`${base}-leave-date`} label={t('rosterPlan.form.leaveDate')}>
            <Input
              id={`${base}-leave-date`}
              type="date"
              value={leaveDate}
              onChange={(event) => {
                setLeaveDate(event.target.value);
              }}
            />
          </FormField>
          <Button
            disabled={leaveUser === '' || leaveDate === ''}
            onClick={() => {
              if (leave.some((row) => row.userId === leaveUser && row.date === leaveDate)) return;
              setLeave([...leave, { userId: leaveUser, date: leaveDate }]);
              setLeaveDate('');
            }}
          >
            {t('rosterPlan.form.leaveAdd')}
          </Button>
        </div>
      </fieldset>

      <div>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          <CalendarClock aria-hidden className="size-4" />
          {create.isPending ? t('rosterPlan.form.making') : t('rosterPlan.form.submit')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// --- one plan ---

function failureText(
  failure: Failure,
  plan: RosterPlan,
  t: Translate,
  date: (key: string) => string,
): string {
  const name = plan.inputs.people.find((person) => person.id === failure.userId)?.name ?? '';
  const shift = plan.inputs.shifts.find((entry) => entry.id === failure.shiftId)?.name ?? '';
  const when = failure.workDate === null ? '' : date(failure.workDate);
  const pre = failure.params.preExisting === 1 ? t('rosterPlan.report.preExisting') : '';
  switch (failure.code) {
    case 'unavailable':
      return t('rosterPlan.report.failure.unavailable', { name, date: when }) + pre;
    case 'overlap':
      return t('rosterPlan.report.failure.overlap', { name, date: when }) + pre;
    case 'rest':
      return t('rosterPlan.report.failure.rest', { name, date: when, shift }) + pre;
    case 'max_shifts_week':
      return t('rosterPlan.report.failure.max_shifts_week', { name }) + pre;
    case 'max_consecutive_days':
      return t('rosterPlan.report.failure.max_consecutive_days', { name, date: when }) + pre;
    case 'max_consecutive_nights':
      return t('rosterPlan.report.failure.max_consecutive_nights', { name, date: when }) + pre;
    case 'coverage_short': {
      const reasons = (Object.keys(REASON_KEYS) as (keyof typeof REASON_KEYS)[])
        .filter((key) => typeof failure.params[key] === 'number')
        .map((key) => t(REASON_KEYS[key], { n: Number(failure.params[key]) }));
      return t('rosterPlan.report.failure.coverage_short', {
        date: when,
        shift,
        assigned: Number(failure.params.assigned ?? 0),
        required: Number(failure.params.required ?? 0),
        reasons:
          reasons.length === 0 ? '' : t('rosterPlan.report.reasonsPrefix') + reasons.join(', '),
      });
    }
    case 'spread':
      return t('rosterPlan.report.failure.spread', {
        max: Number(failure.params.max ?? 0),
        min: Number(failure.params.min ?? 0),
      });
    default:
      return t('rosterPlan.report.failure.other', { message: failure.message });
  }
}

function PlanView({ planId }: { planId: string }) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const plan = useRosterPlan(planId);
  const dateLabel = useDateLabel();
  const [failure, setFailure] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [accept, setAccept] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const keep = (next: RosterPlan) => {
    queryClient.setQueryData(rosterPlanKeys(userId).plan(planId), next);
    void queryClient.invalidateQueries({ queryKey: rosterPlanKeys(userId).list });
  };

  const edit = useMutation({
    mutationFn: (body: { add?: RosterPlan['entries']; remove?: RosterPlan['entries'] }) =>
      api.editRosterPlan(planId, {
        add: (body.add ?? []).map(({ userId: who, shiftId, workDate }) => ({
          userId: who,
          shiftId,
          workDate,
        })),
        remove: (body.remove ?? []).map(({ userId: who, shiftId, workDate }) => ({
          userId: who,
          shiftId,
          workDate,
        })),
      }),
    onSuccess: (next) => {
      setFailure(null);
      setAiMessage(null);
      keep(next);
    },
    onError: (error) => {
      setFailure(describeError(error, t).message);
    },
  });

  const explain = useMutation({
    mutationFn: () => api.explainRosterPlan(planId, { locale: locale === 'th' ? 'th' : 'en' }),
    onSuccess: (next) => {
      setAiMessage(null);
      keep(next);
    },
    onError: (error) => {
      setAiMessage(
        isApiError(error) && error.status === 502
          ? t('rosterPlan.ai.invalid')
          : isApiError(error) && error.status === 503
            ? t('rosterPlan.ai.unavailable')
            : describeError(error, t).message,
      );
    },
  });

  const apply = useMutation({
    mutationFn: () => api.applyRosterPlan(planId, { acceptShortfall: accept }),
    onSuccess: async (result) => {
      keep(result.plan);
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
      setApplyOpen(false);
      toast(t('rosterPlan.apply.done', { added: result.added, removed: result.removed }));
    },
    onError: (error) => {
      setDialogError(describeError(error, t).message);
    },
  });

  const discard = useMutation({
    mutationFn: () => api.discardRosterPlan(planId),
    onSuccess: (next) => {
      keep(next);
      setDiscardOpen(false);
      toast(t('rosterPlan.apply.discarded'));
    },
    onError: (error) => {
      setDialogError(describeError(error, t).message);
    },
  });

  if (plan.isPending) return <TableSkeleton rows={4} />;
  if (plan.isError) return <Alert tone="error" title={t('rosterPlan.plan.loadFailed')} />;
  const data = plan.data;
  const draft = data.status === 'draft';
  const days = Array.from({ length: 7 }, (_unused, index) => addDays(data.weekStart, index));

  const cell = (shiftId: string, date: string) =>
    data.entries.filter((entry) => entry.shiftId === shiftId && entry.workDate === date);
  const blockedHard = !data.report.hardOk;
  const blockedStarted = data.diff.started > 0;
  const canApply = draft && !blockedHard && !blockedStarted;
  const needsAccept = !data.report.coverageOk;

  const banner = (() => {
    if (data.report.coverageOk && data.report.hardOk) {
      return <Alert tone="success" title={t('rosterPlan.plan.okTitle')} />;
    }
    if (!data.report.hardOk) {
      return <Alert tone="error" title={t('rosterPlan.plan.ruleBroken')} />;
    }
    if (data.solver.status === 'no_solution') {
      return (
        <Alert tone="error" title={t('rosterPlan.plan.noSolutionTitle')}>
          {t('rosterPlan.plan.noSolutionBody')}
        </Alert>
      );
    }
    if (data.solver.status === 'unproven') {
      return (
        <Alert tone="error" title={t('rosterPlan.plan.unprovenTitle')}>
          {t('rosterPlan.plan.unprovenBody')}
        </Alert>
      );
    }
    return (
      <Alert tone="error" title={t('rosterPlan.plan.shortTitle')}>
        {t('rosterPlan.plan.shortBody')}
      </Alert>
    );
  })();

  return (
    <section
      aria-label={t('rosterPlan.plan.title', { week: data.weekStart })}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {t('rosterPlan.plan.title', { week: data.weekStart })}
        </h3>
        <Pill>{t(STATUS_KEYS[data.status])}</Pill>
      </div>
      {data.status === 'applied' ? (
        <Alert
          tone="info"
          title={t('rosterPlan.plan.appliedOn', {
            date: data.appliedAt ? dateLabel(data.appliedAt.slice(0, 10)) : '',
          })}
        />
      ) : data.status === 'discarded' ? (
        <Alert tone="info" title={t('rosterPlan.plan.discardedNote')} />
      ) : (
        banner
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <caption className="sr-only">
            {t('rosterPlan.plan.gridCaption', { week: data.weekStart })}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="border border-border bg-surface-muted p-2 text-start">
                {t('rosterPlan.plan.shiftColumn')}
              </th>
              {days.map((date) => (
                <th
                  key={date}
                  scope="col"
                  className="border border-border bg-surface-muted p-2 text-start"
                >
                  {dateLabel(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.inputs.shifts.map((shift) => (
              <tr key={shift.id}>
                <th
                  scope="row"
                  className="border border-border p-2 text-start align-top font-medium"
                >
                  {shift.name}
                  <span className="block text-xs font-normal text-muted-foreground tabular">
                    {shift.startsAt}–{shift.endsAt}
                  </span>
                </th>
                {days.map((date) => {
                  const entries = cell(shift.id, date);
                  const inCell = new Set(entries.map((entry) => entry.userId));
                  return (
                    <td key={date} className="border border-border p-1.5 align-top">
                      {entries.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {t('rosterPlan.plan.emptyCell')}
                        </span>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {entries.map((entry) => (
                            <li
                              key={entry.userId}
                              className="flex items-center justify-between gap-1"
                            >
                              <span className="flex items-center gap-1">
                                {entry.locked ? (
                                  <Lock
                                    aria-label={t('rosterPlan.plan.locked')}
                                    role="img"
                                    className="size-3 text-muted-foreground"
                                  />
                                ) : null}
                                {entry.userName}
                              </span>
                              {draft && !entry.locked ? (
                                <button
                                  type="button"
                                  disabled={edit.isPending}
                                  aria-label={t('rosterPlan.plan.removeEntry', {
                                    name: entry.userName,
                                    shift: shift.name,
                                    date,
                                  })}
                                  onClick={() => {
                                    edit.mutate({ remove: [entry] });
                                  }}
                                  className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                                >
                                  <X aria-hidden className="size-3.5" />
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      {draft ? (
                        <Select
                          aria-label={t('rosterPlan.plan.addEntry', { shift: shift.name, date })}
                          value=""
                          disabled={edit.isPending}
                          className="mt-1 h-7 text-xs"
                          onChange={(event) => {
                            const person = data.inputs.people.find(
                              (p) => p.id === event.target.value,
                            );
                            if (person === undefined) return;
                            edit.mutate({
                              add: [
                                {
                                  userId: person.id,
                                  userName: person.name,
                                  shiftId: shift.id,
                                  shiftName: shift.name,
                                  workDate: date,
                                  locked: false,
                                },
                              ],
                            });
                          }}
                        >
                          <option value="">{t('rosterPlan.plan.addPick')}</option>
                          {data.inputs.people
                            .filter((person) => !inCell.has(person.id))
                            .map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.name}
                              </option>
                            ))}
                        </Select>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {draft ? (
        <p className="text-xs text-muted-foreground">{t('rosterPlan.plan.editHint')}</p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t('rosterPlan.plan.editFailed')} {failure}
        </p>
      ) : null}

      <section aria-label={t('rosterPlan.report.title')} className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('rosterPlan.report.title')}</h4>
        <ul className="flex flex-col gap-1.5">
          {data.report.items.map((item) => (
            <li key={item.id} className="rounded-lg border border-border px-3 py-2 text-sm">
              <div className="flex items-start gap-2">
                {item.status === 'pass' ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">
                    {t(ITEM_KEYS[item.id])}
                    <span className="ms-2 text-xs font-normal text-muted-foreground">
                      {t(KIND_KEYS[item.kind])} ·{' '}
                      {item.status === 'pass'
                        ? t('rosterPlan.report.met')
                        : t('rosterPlan.report.notMet')}
                    </span>
                  </p>
                  {item.failures.length > 0 ? (
                    <ul className="mt-1 list-disc ps-4 text-muted-foreground">
                      {item.failures.slice(0, 20).map((entry, index) => (
                        <li key={`${entry.code}-${String(index)}`}>
                          {failureText(entry, data, t, dateLabel)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t('rosterPlan.report.loadsTitle')} className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold">{t('rosterPlan.report.loadsTitle')}</h4>
        <table className="w-full max-w-xl border-collapse text-sm">
          <caption className="sr-only">{t('rosterPlan.report.loadsTitle')}</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-border p-1.5 text-start">
                {t('rosterPlan.report.person')}
              </th>
              <th scope="col" className="border-b border-border p-1.5 text-end">
                {t('rosterPlan.report.shifts')}
              </th>
              <th scope="col" className="border-b border-border p-1.5 text-end">
                {t('rosterPlan.report.nights')}
              </th>
              <th scope="col" className="border-b border-border p-1.5 text-end">
                {t('rosterPlan.report.heavyDays')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.report.loads.map((load) => (
              <tr key={load.userId}>
                <th scope="row" className="border-b border-border p-1.5 text-start font-normal">
                  {data.inputs.people.find((person) => person.id === load.userId)?.name ?? ''}
                </th>
                <td className="border-b border-border p-1.5 text-end tabular">{load.shifts}</td>
                <td className="border-b border-border p-1.5 text-end tabular">{load.nights}</td>
                <td className="border-b border-border p-1.5 text-end tabular">{load.heavyDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">{t('rosterPlan.report.loadsNote')}</p>
      </section>

      <section
        aria-label={t('rosterPlan.ai.title')}
        className="flex flex-col gap-2 rounded-lg border border-border p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles aria-hidden className="size-4" />
            {t('rosterPlan.ai.title')}
          </h4>
          {draft ? (
            <Button
              disabled={explain.isPending}
              onClick={() => {
                explain.mutate();
              }}
            >
              {explain.isPending
                ? t('rosterPlan.ai.asking')
                : data.explanation
                  ? t('rosterPlan.ai.again')
                  : t('rosterPlan.ai.ask')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t('rosterPlan.ai.note')}</p>
        {data.explanation ? (
          <p className="text-sm whitespace-pre-wrap">{data.explanation.text}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('rosterPlan.ai.none')}</p>
        )}
        {aiMessage ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {aiMessage}
          </p>
        ) : null}
      </section>

      {draft ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-sm">
            {t('rosterPlan.plan.diff', {
              add: data.diff.add,
              remove: data.diff.remove,
              keep: data.diff.keep,
              locked: data.diff.locked,
            })}
          </p>
          {blockedStarted ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {t('rosterPlan.plan.started', { n: data.diff.started })}
            </p>
          ) : null}
          {blockedHard ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {t('rosterPlan.apply.blockedHard')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!canApply}
              onClick={() => {
                setAccept(false);
                setDialogError(null);
                setApplyOpen(true);
              }}
            >
              {t('rosterPlan.apply.button')}
            </Button>
            <Button
              onClick={() => {
                setDialogError(null);
                setDiscardOpen(true);
              }}
            >
              {t('rosterPlan.apply.discard')}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={applyOpen}
        onOpenChange={(next) => {
          if (!apply.isPending) setApplyOpen(next);
        }}
      >
        <DialogContent
          title={t('rosterPlan.apply.title')}
          description={t('rosterPlan.apply.description', {
            add: data.diff.add,
            remove: data.diff.remove,
            locked: data.diff.locked,
          })}
          closeLabel={t('admin.common.close')}
          footer={
            <>
              <Button
                disabled={apply.isPending}
                onClick={() => {
                  setApplyOpen(false);
                }}
              >
                {t('admin.common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={apply.isPending || (needsAccept && !accept)}
                onClick={() => {
                  setDialogError(null);
                  apply.mutate();
                }}
              >
                {apply.isPending ? t('rosterPlan.apply.applying') : t('rosterPlan.apply.confirm')}
              </Button>
            </>
          }
        >
          {needsAccept ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={accept}
                onChange={(event) => {
                  setAccept(event.target.checked);
                }}
              />
              {t('rosterPlan.apply.shortfall')}
            </label>
          ) : null}
          {dialogError ? (
            <p role="alert" className="mt-2 text-sm font-medium text-danger">
              {dialogError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={discardOpen}
        onOpenChange={(next) => {
          if (!discard.isPending) setDiscardOpen(next);
        }}
      >
        <DialogContent
          title={t('rosterPlan.apply.discardConfirmTitle')}
          description={t('rosterPlan.apply.discardConfirmDescription')}
          closeLabel={t('admin.common.close')}
          footer={
            <>
              <Button
                disabled={discard.isPending}
                onClick={() => {
                  setDiscardOpen(false);
                }}
              >
                {t('admin.common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={discard.isPending}
                onClick={() => {
                  setDialogError(null);
                  discard.mutate();
                }}
              >
                {t('rosterPlan.apply.discard')}
              </Button>
            </>
          }
        >
          {dialogError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {dialogError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
