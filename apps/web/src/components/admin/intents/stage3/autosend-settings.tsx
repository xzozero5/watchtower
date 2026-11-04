'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AUTOSEND_CHANNELS,
  type AutosendChannel,
  type AutonomyIntent,
  type IntentAutosend,
  setIntentAutosendSchema,
} from '@watchtower/shared';
import { Button, Input, Textarea, toast } from '@watchtower/ui';
import { CircleX } from 'lucide-react';
import { useId, useState } from 'react';

import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, stage3Keys } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

/** What a new intent has: shadow on, a high score, a small cap, no channel allowed (ADR-025). */
const DEFAULTS: IntentAutosend = {
  shadow: true,
  minScore: 0.9,
  dailyCap: 20,
  policy: { channels: [], action: 'reply', maxChars: 1200 },
};

/**
 * The auto-send settings of one intent: shadow mode, the lowest grade that may go out, the daily cap and the
 * allow-list (channels, longest reply). Every change needs a reason and goes to the history. Only a head
 * changes them (`ai.autonomy.set.any`); others read them.
 */
export function AutosendSettings({
  intent,
  canChange,
}: {
  intent: AutonomyIntent;
  canChange: boolean;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const baseId = useId();
  const current = intent.autosend ?? DEFAULTS;
  const [shadow, setShadow] = useState(current.shadow);
  const [minScore, setMinScore] = useState(String(current.minScore));
  const [dailyCap, setDailyCap] = useState(String(current.dailyCap));
  const [channels, setChannels] = useState<AutosendChannel[]>(current.policy.channels);
  const [maxChars, setMaxChars] = useState(String(current.policy.maxChars));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const body = {
    shadow,
    minScore: Number(minScore),
    dailyCap: Number(dailyCap),
    policy: { channels, action: 'reply' as const, maxChars: Number(maxChars) },
    reason: reason.trim(),
  };
  const parsed = setIntentAutosendSchema.safeParse(body);
  const numbersOk =
    minScore.trim() !== '' && dailyCap.trim() !== '' && maxChars.trim() !== '' && parsed.success;
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const dirty =
    shadow !== current.shadow ||
    Number(minScore) !== current.minScore ||
    Number(dailyCap) !== current.dailyCap ||
    Number(maxChars) !== current.policy.maxChars ||
    channels.length !== current.policy.channels.length ||
    channels.some((channel) => !current.policy.channels.includes(channel));

  const save = useMutation({
    mutationFn: () => api.setIntentAutosend(intent.id, body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).intentHistory(intent.id) });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
      void queryClient.invalidateQueries({ queryKey: stage3Keys(userId, intent.id) });
      setReason('');
      setError(null);
      toast(t(result.changed ? 'stage3.settings.saved' : 'stage3.settings.noChange'));
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  const id = (name: string) => `${baseId}-${name}`;
  const disabled = !canChange || save.isPending;

  return (
    <section aria-labelledby="stage3-settings" className="flex max-w-xl flex-col gap-3">
      <div>
        <h2 id="stage3-settings" className="text-base font-semibold">
          {t('stage3.settings.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('stage3.settings.lead')}</p>
        {!canChange ? (
          <p className="mt-1 text-sm text-muted-foreground">{t('stage3.settings.readOnly')}</p>
        ) : null}
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canChange && dirty && numbersOk && reasonOk) {
            setError(null);
            save.mutate();
          }
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-0.5">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={shadow}
              disabled={disabled}
              onChange={(event) => {
                setShadow(event.target.checked);
              }}
              className="mt-0.5 size-4"
            />
            <span>{t('stage3.settings.shadow')}</span>
          </label>
          <p className="ml-6 text-xs text-muted-foreground">{t('stage3.settings.shadowHint')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField id={id('score')} label={t('stage3.settings.minScore')}>
            <Input
              id={id('score')}
              type="number"
              inputMode="decimal"
              min={0.7}
              max={1}
              step={0.01}
              value={minScore}
              disabled={disabled}
              onChange={(event) => {
                setMinScore(event.target.value);
              }}
            />
          </FormField>
          <FormField id={id('cap')} label={t('stage3.settings.dailyCap')}>
            <Input
              id={id('cap')}
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              step={1}
              value={dailyCap}
              disabled={disabled}
              onChange={(event) => {
                setDailyCap(event.target.value);
              }}
            />
          </FormField>
          <FormField id={id('max')} label={t('stage3.settings.maxChars')}>
            <Input
              id={id('max')}
              type="number"
              inputMode="numeric"
              min={100}
              max={4000}
              step={1}
              value={maxChars}
              disabled={disabled}
              onChange={(event) => {
                setMaxChars(event.target.value);
              }}
            />
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('stage3.settings.channels')}</legend>
          <div className="flex flex-wrap gap-4">
            {AUTOSEND_CHANNELS.map((channel) => (
              <label key={channel} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={channels.includes(channel)}
                  disabled={disabled}
                  onChange={(event) => {
                    setChannels((list) =>
                      event.target.checked
                        ? [...list.filter((c) => c !== channel), channel]
                        : list.filter((c) => c !== channel),
                    );
                  }}
                  className="size-4"
                />
                {t(`stage3.settings.channel.${channel}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('stage3.settings.channelsHint')}</p>
        </fieldset>
        {canChange ? (
          <>
            {!numbersOk && dirty ? (
              <p className="text-sm font-medium text-danger">{t('stage3.settings.invalid')}</p>
            ) : null}
            <FormField id={id('reason')} label={t('stage3.settings.reason')}>
              <Textarea
                id={id('reason')}
                rows={2}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </FormField>
            {error ? (
              <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
                <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
            <div>
              <Button
                variant="primary"
                type="submit"
                disabled={save.isPending || !dirty || !numbersOk || !reasonOk}
              >
                {save.isPending ? t('stage3.settings.saving') : t('stage3.settings.save')}
              </Button>
            </div>
          </>
        ) : null}
      </form>
    </section>
  );
}
