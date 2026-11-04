'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CSAT_COOLDOWN_MAX_DAYS,
  CSAT_DELAY_MAX_MINUTES,
  CSAT_REMINDER_MAX_HOURS,
  type CsatSettings,
  type CsatSettingsUpdate,
} from '@watchtower/shared';
import { Alert, Button, HelpHint, Input, toast } from '@watchtower/ui';
import { useId, useState } from 'react';

import { LoadError, TableSkeleton } from '@/components/admin/admin-page';
import { describedBy, FormField } from '@/components/portal/form-field';
import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useCsatSettings } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';

type NumberField = 'delayMinutes' | 'reminderHours' | 'cooldownDays';

const NUMBER_FIELDS: readonly {
  key: NumberField;
  max: number;
  label: MessageKey;
  hint: MessageKey;
}[] = [
  {
    key: 'delayMinutes',
    max: CSAT_DELAY_MAX_MINUTES,
    label: 'admin.integrations.csat.delay',
    hint: 'admin.integrations.csat.delayHint',
  },
  {
    key: 'reminderHours',
    max: CSAT_REMINDER_MAX_HOURS,
    label: 'admin.integrations.csat.reminder',
    hint: 'admin.integrations.csat.reminderHint',
  },
  {
    key: 'cooldownDays',
    max: CSAT_COOLDOWN_MAX_DAYS,
    label: 'admin.integrations.csat.cooldown',
    hint: 'admin.integrations.csat.cooldownHint',
  },
];

/** A whole number from 0 to `max`, or null when the text is anything else. */
export function parseWhole(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value <= max ? value : null;
}

/**
 * The satisfaction survey settings (T-174): on or off, the delay after "resolved", the one reminder
 * and the quiet period per contact. Reading needs `csat.read`; changing needs `integration.manage`
 * (the api enforces both). Save sends only what changed.
 */
export function CsatSettingsSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const allowed = can('csat.read');
  const settings = useCsatSettings(allowed);
  if (!allowed) return null;

  return (
    <section aria-labelledby="csat-heading" className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h2 id="csat-heading" className="text-base font-semibold">
          {t('admin.integrations.csat.heading')}
        </h2>
        <HelpHint label={t('admin.moreInfo', { topic: t('admin.integrations.csat.heading') })}>
          {t('admin.integrations.csat.hint')}
        </HelpHint>
      </div>
      {settings.isPending ? (
        <TableSkeleton rows={3} />
      ) : settings.isError ? (
        <LoadError
          message={t('admin.integrations.csat.loadError')}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <CsatForm
          key={JSON.stringify(settings.data)}
          settings={settings.data}
          canEdit={can('integration.manage')}
        />
      )}
    </section>
  );
}

function CsatForm({ settings, canEdit }: { settings: CsatSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const baseId = useId();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [values, setValues] = useState<Record<NumberField, string>>({
    delayMinutes: String(settings.delayMinutes),
    reminderHours: String(settings.reminderHours),
    cooldownDays: String(settings.cooldownDays),
  });
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: CsatSettingsUpdate) => api.setCsatSettings(body),
    onSuccess: (saved) => {
      setFailure(null);
      queryClient.setQueryData(adminKeys(userId).csatSettings, saved);
      toast(t('admin.integrations.csat.saved'));
    },
    onError: (error) => {
      setFailure(describeError(error, t).message);
    },
  });

  const parsed = NUMBER_FIELDS.map((field) => ({
    field,
    value: parseWhole(values[field.key], field.max),
  }));
  const changes: CsatSettingsUpdate = {};
  if (enabled !== settings.enabled) changes.enabled = enabled;
  for (const { field, value } of parsed) {
    if (value !== null && value !== settings[field.key]) changes[field.key] = value;
  }
  const invalid = parsed.some(({ value }) => value === null);
  const dirty = Object.keys(changes).length > 0;

  const submit = () => {
    setSubmitted(true);
    setFailure(null);
    if (invalid || !dirty) return;
    save.mutate(changes);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4 rounded-xl border border-border/60 bg-surface p-4"
    >
      {!canEdit ? <Alert tone="info" title={t('admin.integrations.csat.viewOnly')} /> : null}

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
          className="size-4"
        />
        {t('admin.integrations.csat.enabled')}
        <span className="font-normal text-muted-foreground">
          {enabled
            ? t('admin.integrations.csat.enabledOn')
            : t('admin.integrations.csat.enabledOff')}
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        {parsed.map(({ field, value }) => {
          const id = `${baseId}-${field.key}`;
          const error =
            submitted && value === null
              ? t('admin.integrations.csat.rangeError', { max: field.max })
              : undefined;
          return (
            <FormField
              key={field.key}
              id={id}
              label={t(field.label)}
              hint={t(field.hint, { max: field.max })}
              {...(error ? { error } : {})}
            >
              <Input
                id={id}
                inputMode="numeric"
                value={values[field.key]}
                disabled={!canEdit || !enabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(id, true, error !== undefined)}
                onChange={(event) => {
                  setValues({ ...values, [field.key]: event.target.value });
                }}
                className="tabular"
              />
            </FormField>
          );
        })}
      </div>

      {failure ? <Alert tone="error" title={failure} /> : null}

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending
              ? t('admin.integrations.csat.saving')
              : t('admin.integrations.csat.save')}
          </Button>
          {!dirty && !invalid ? (
            <span className="text-sm text-muted-foreground">
              {t('admin.integrations.csat.noChange')}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
