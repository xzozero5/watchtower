'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type SlaCalendarMode,
  type SlaPolicy,
  type SlaTargets,
  TICKET_PRIORITIES,
  type TicketPriority,
} from '@watchtower/shared';
import { Input, Select, toast } from '@watchtower/ui';
import { useId, useState } from 'react';

import { EntitySheet } from '@/components/admin/entity-sheet';
import { FormField } from '@/components/portal/form-field';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useCalendars } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

interface Row {
  first: string;
  resolution: string;
  mode: SlaCalendarMode;
}

const emptyRow = (): Row => ({ first: '', resolution: '', mode: 'business' });

function rowsOf(targets: SlaTargets | undefined): Record<TicketPriority, Row> {
  const result = {} as Record<TicketPriority, Row>;
  for (const priority of TICKET_PRIORITIES) {
    const target = targets?.[priority];
    result[priority] = target
      ? {
          first: String(target.first_response_min),
          resolution: String(target.resolution_min),
          mode: target.calendar,
        }
      : emptyRow();
  }
  return result;
}

/** Create or edit an SLA policy: name, tier, calendar and a four-row grid of targets in minutes. */
export function PolicySheet({
  open,
  policy,
  onClose,
}: {
  open: boolean;
  policy: SlaPolicy | null;
  onClose: () => void;
}) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const calendars = useCalendars(open);
  const base = useId();
  const [name, setName] = useState(policy?.name ?? '');
  const [tier, setTier] = useState(policy?.tier ?? '');
  const [calendarId, setCalendarId] = useState(policy?.businessCalendarId ?? '');
  const [rows, setRows] = useState(() => rowsOf(policy?.targets));
  const [errors, setErrors] = useState<Partial<Record<TicketPriority | 'name', string>>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const touch = () => {
    setDirty(true);
  };
  const setRow = (priority: TicketPriority, patch: Partial<Row>) => {
    setRows((current) => ({ ...current, [priority]: { ...current[priority], ...patch } }));
    touch();
  };

  const buildTargets = (): SlaTargets => {
    const targets: SlaTargets = {};
    for (const priority of TICKET_PRIORITIES) {
      const row = rows[priority];
      if (row.first.trim() === '' && row.resolution.trim() === '') continue;
      targets[priority] = {
        first_response_min: Number(row.first),
        resolution_min: Number(row.resolution),
        calendar: row.mode,
      };
    }
    return targets;
  };

  const save = useMutation({
    mutationFn: () => {
      const targets = buildTargets();
      return policy === null
        ? api.createSlaPolicy({
            name: name.trim(),
            targets,
            ...(tier ? { tier } : {}),
            ...(calendarId ? { businessCalendarId: calendarId } : {}),
          })
        : api.updateSlaPolicy(policy.id, {
            name: name.trim(),
            targets,
            tier: tier === '' ? null : tier,
            businessCalendarId: calendarId === '' ? null : calendarId,
          });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).slaPolicies });
      toast(t('admin.common.saved'));
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  const submit = () => {
    const next: Partial<Record<TicketPriority | 'name', string>> = {};
    if (name.trim() === '') next.name = t('admin.common.required');
    for (const priority of TICKET_PRIORITIES) {
      const row = rows[priority];
      if (row.first.trim() === '' && row.resolution.trim() === '') continue;
      const first = Number(row.first);
      const resolution = Number(row.resolution);
      if (
        row.first.trim() === '' ||
        row.resolution.trim() === '' ||
        !Number.isInteger(first) ||
        !Number.isInteger(resolution) ||
        first < 0 ||
        resolution < 0
      ) {
        next[priority] = t('admin.sla.minutesInvalid');
      } else if (first > resolution) {
        next[priority] = t('admin.sla.firstAfterResolution');
      }
    }
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <EntitySheet
      open={open}
      onClose={onClose}
      title={policy ? policy.name : t('admin.sla.newPolicy')}
      description={policy ? t('admin.sla.appliesToNew') : t('admin.sla.newPolicy')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-name`}
          label={t('admin.common.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              touch();
            }}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            id={`${base}-tier`}
            label={t('admin.orgs.tier')}
            optionalLabel={t('admin.common.optional')}
          >
            <Select
              id={`${base}-tier`}
              value={tier}
              onChange={(event) => {
                setTier(event.target.value);
                touch();
              }}
            >
              <option value="">—</option>
              {[
                'gold',
                'silver',
                'standard',
                ...(tier && !['gold', 'silver', 'standard'].includes(tier) ? [tier] : []),
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id={`${base}-calendar`} label={t('admin.sla.calendar')}>
            <Select
              id={`${base}-calendar`}
              value={calendarId}
              onChange={(event) => {
                setCalendarId(event.target.value);
                touch();
              }}
            >
              <option value="">—</option>
              {(calendars.data?.calendars ?? []).map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('admin.sla.targets')}</legend>
          {TICKET_PRIORITIES.map((priority) => {
            const id = `${base}-${priority}`;
            const error = errors[priority];
            return (
              <div key={priority} className="flex flex-col gap-1">
                <div className="grid grid-cols-[2.5rem_1fr_1fr_6.5rem] items-center gap-2">
                  <span className="text-sm font-semibold">{priority}</span>
                  <Input
                    aria-label={t('admin.sla.firstResponse', { priority })}
                    placeholder={t('admin.sla.firstShort')}
                    inputMode="numeric"
                    value={rows[priority].first}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    onChange={(event) => {
                      setRow(priority, { first: event.target.value });
                    }}
                  />
                  <Input
                    aria-label={t('admin.sla.resolution', { priority })}
                    placeholder={t('admin.sla.resolutionShort')}
                    inputMode="numeric"
                    value={rows[priority].resolution}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    onChange={(event) => {
                      setRow(priority, { resolution: event.target.value });
                    }}
                  />
                  <Select
                    aria-label={t('admin.sla.mode', { priority })}
                    value={rows[priority].mode}
                    onChange={(event) => {
                      setRow(priority, { mode: event.target.value as SlaCalendarMode });
                    }}
                  >
                    <option value="business">{t('admin.sla.business')}</option>
                    <option value="24x7">24×7</option>
                  </Select>
                </div>
                {error ? (
                  <p id={`${id}-error`} className="text-sm font-medium text-danger">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      </form>
    </EntitySheet>
  );
}
