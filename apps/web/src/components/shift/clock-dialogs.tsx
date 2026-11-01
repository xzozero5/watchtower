'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ShiftStatus } from '@watchtower/shared';
import { Button, Dialog, DialogContent, Textarea, toast } from '@watchtower/ui';
import { CircleX, Volume2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { FormField } from '@/components/portal/form-field';
import { useShiftFormat } from '@/components/shift/shift-bits';
import { useT } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { deviceName, describeShiftError } from '@/lib/shifts/model';
import { shiftKeys } from '@/lib/shifts/queries';

/** A short two-tone beep, to check the speakers before the shift. Returns false when the browser cannot. */
export function playTestSound(): boolean {
  try {
    // Older Safari only has the prefixed name, and jsdom has neither.
    const scope = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Context = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Context) return false;
    const context = new Context();
    const gain = context.createGain();
    gain.gain.value = 0.08;
    gain.connect(context.destination);
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(context.currentTime + index * 0.18);
      oscillator.stop(context.currentTime + index * 0.18 + 0.15);
    });
    window.setTimeout(() => {
      void context.close();
    }, 800);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clock in (docs/06-UI-SPEC.md section 9.1): today's roster entry, or "not on the roster today —
 * clock in anyway?", the device (filled in), the location consent (off by default) and a sound test.
 * Confirming goes to the daily brief.
 */
export function ClockInDialog({
  open,
  onOpenChange,
  status,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ShiftStatus;
}) {
  const t = useT();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const userId = useUserId();
  const base = useId();
  const format = useShiftFormat(status.timezone);
  const [consent, setConsent] = useState(false);
  const [device, setDevice] = useState(() =>
    typeof navigator === 'undefined' ? '' : deviceName(navigator.userAgent),
  );
  const [error, setError] = useState<string | null>(null);
  const now = Date.parse(status.now);
  // The entries "around now" include yesterday's; the one that has not ended is the one to clock in to.
  const entries = status.roster.filter((entry) => Date.parse(entry.endsAt) > now);

  const clockIn = useMutation({
    mutationFn: () =>
      api.clockIn({
        ...(device.trim() === '' ? {} : { device: device.trim() }),
        locationConsent: consent,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
      toast(t('shift.clockIn.done'));
      onOpenChange(false);
      router.push('/shift/brief');
    },
    onError: (failure) => {
      setError(describeShiftError(failure, t).message);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!clockIn.isPending) onOpenChange(next);
      }}
    >
      <DialogContent
        title={t('shift.clockIn.title')}
        description={t('shift.clockIn.description')}
        closeLabel={t('shift.common.close')}
        footer={
          <>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={clockIn.isPending}
            >
              {t('shift.common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={clockIn.isPending}
              onClick={() => {
                setError(null);
                clockIn.mutate();
              }}
            >
              {clockIn.isPending
                ? t('shift.common.saving')
                : entries.length > 0
                  ? t('shift.clockIn.confirm')
                  : t('shift.clockIn.confirmAnyway')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? (
            <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t('shift.clockIn.today')}</p>
            {entries.length === 0 ? (
              <p className="text-sm">{t('shift.clockIn.notRostered')}</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    {t('shift.status.onRoster', {
                      name: entry.shiftName,
                      range: `${format.time(entry.startsAt)}–${format.time(entry.endsAt)}`,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <FormField id={`${base}-device`} label={t('shift.clockIn.device')}>
            <input
              id={`${base}-device`}
              value={device}
              maxLength={200}
              onChange={(event) => {
                setDevice(event.target.value);
              }}
              className="h-control rounded-md border border-border-strong bg-surface px-2.5 text-sm"
            />
          </FormField>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={consent}
                aria-describedby={`${base}-consent-hint`}
                onChange={(event) => {
                  setConsent(event.target.checked);
                }}
                className="size-4"
              />
              {t('shift.clockIn.location')}
            </label>
            <p id={`${base}-consent-hint`} className="text-xs text-muted-foreground">
              {t('shift.clockIn.locationHint')}
            </p>
          </div>
          <div>
            <Button
              onClick={() => {
                toast(
                  playTestSound() ? t('shift.clockIn.soundPlayed') : t('shift.clockIn.soundFailed'),
                );
              }}
            >
              <Volume2 aria-hidden className="size-4" />
              {t('shift.clockIn.testSound')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const OVERRIDE_REASON_MIN = 10;

/** A lead or head clocks out (themself or someone else) although the handoff is incomplete: the reason is required and audited. */
export function OverrideDialog({
  open,
  onOpenChange,
  title,
  description,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  pending: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
}) {
  const t = useT();
  const base = useId();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        title={title}
        description={description}
        closeLabel={t('shift.common.close')}
        footer={
          <>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={pending}
            >
              {t('shift.common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                if (reason.trim().length < OVERRIDE_REASON_MIN) {
                  setInvalid(true);
                  return;
                }
                setInvalid(false);
                onSubmit(reason.trim());
              }}
            >
              {pending ? t('shift.clockOut.pending') : t('shift.clockOut.overrideConfirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? (
            <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
          <FormField
            id={`${base}-reason`}
            label={t('shift.clockOut.reason')}
            hint={t('shift.clockOut.reasonHint')}
            {...(invalid ? { error: t('shift.clockOut.reasonShort') } : {})}
          >
            <Textarea
              id={`${base}-reason`}
              value={reason}
              maxLength={500}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={`${base}-reason-hint${invalid ? ` ${base}-reason-error` : ''}`}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="w-full"
            />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
