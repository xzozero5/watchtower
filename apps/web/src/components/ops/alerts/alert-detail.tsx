'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Alert } from '@watchtower/shared';
import { Button, Dialog, DialogContent, Input, Kbd, Select, TintChip, toast } from '@watchtower/ui';
import { Link2Off, Siren } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { CreateIncidentDialog } from '@/components/ops/incidents/create-incident-dialog';
import {
  AlertSeverityBadge,
  AlertSourceText,
  AlertStateChips,
  Fact,
  Moment,
  OpsSkeleton,
} from '@/components/ops/ops-bits';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeOpsError, isSnoozed } from '@/lib/ops/model';
import { opsKeys, useAlert, useAlertEscalations, useServices } from '@/lib/ops/queries';
import { useShortcut } from '@/lib/keyboard';
import { useNow } from '@/lib/use-now';

const SNOOZE_CHOICES = [15, 60, 240, 1440, 10_080] as const;
const SNOOZE_LABELS = {
  15: 'ops.alerts.snooze.m15',
  60: 'ops.alerts.snooze.h1',
  240: 'ops.alerts.snooze.h4',
  1440: 'ops.alerts.snooze.d1',
  10_080: 'ops.alerts.snooze.d7',
} as const;

function payloadText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function safeUrl(value: string | null): string | null {
  return value !== null && /^https?:\/\//i.test(value) ? value : null;
}

function payloadLabels(payload: Record<string, unknown>): [string, string][] {
  const raw = payload.labels;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .slice(0, 30);
}

/**
 * One alert: what fired, which service owns it (or that none does), who acknowledged it and how, the
 * escalation steps that ran, and the buttons. `A` acknowledges and `S` snoozes while the alert is
 * open here (UI spec section 8.1); the buttons do the same for someone who has shortcuts off.
 */
export function AlertDetail({
  alertId,
  fallback,
}: {
  alertId: string;
  fallback: Alert | undefined;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const now = useNow();
  const query = useAlert(alertId);
  const escalations = useAlertEscalations(alertId);
  const services = useServices();
  const [snoozing, setSnoozing] = useState(false);
  const [creating, setCreating] = useState(false);

  const alert: Alert | undefined = query.data ?? fallback;
  const refresh = () => queryClient.invalidateQueries({ queryKey: opsKeys(userId).alerts });

  const ack = useMutation({
    mutationFn: () => api.ackAlert(alertId),
    onSuccess: async (result) => {
      await refresh();
      toast(result.changed ? t('ops.alerts.actions.acked') : t('ops.alerts.actions.alreadyAcked'));
    },
    onError: (error) => {
      toast(describeOpsError(error, t).message);
    },
  });
  const unsnooze = useMutation({
    mutationFn: () => api.unsnoozeAlert(alertId),
    onSuccess: async () => {
      await refresh();
      toast(t('ops.alerts.actions.unsnoozed'));
    },
    onError: (error) => {
      toast(describeOpsError(error, t).message);
    },
  });

  const canAck = can('alert.ack') && alert?.state === 'open';
  const canSnooze = can('alert.manage') && alert !== undefined && alert.state !== 'resolved';
  useShortcut(
    'a',
    () => {
      if (!ack.isPending) ack.mutate();
    },
    canAck,
  );
  useShortcut(
    's',
    () => {
      setSnoozing(true);
    },
    canSnooze && !isSnoozed(alert, now),
  );

  if (alert === undefined) {
    if (query.isError)
      return (
        <LoadError
          message={t('ops.alerts.detail.loadError')}
          onRetry={() => void query.refetch()}
        />
      );
    return <OpsSkeleton rows={5} />;
  }

  const service = services.data?.items.find((item) => item.id === alert.serviceId);
  const url = safeUrl(payloadText(alert.payload, 'url'));
  const labels = payloadLabels(alert.payload);
  const snoozed = isSnoozed(alert, now);

  return (
    <article aria-labelledby="alert-title" className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AlertSeverityBadge severity={alert.severity} />
          <AlertStateChips alert={alert} />
          {alert.serviceId === null ? (
            <TintChip tone="amber" icon={Link2Off}>
              {t('ops.alerts.unmapped')}
            </TintChip>
          ) : null}
        </div>
        <h2 id="alert-title" className="text-lg font-semibold break-words">
          {alert.title}
        </h2>
        {alert.summary ? <p className="text-sm break-words">{alert.summary}</p> : null}
        {alert.severity === 'unknown' ? (
          <p className="text-sm text-muted-foreground">
            {t('ops.alerts.detail.severityUnmappedNote')}
          </p>
        ) : null}
        {alert.serviceId === null ? (
          <p className="text-sm text-muted-foreground">{t('ops.alerts.detail.unmappedNote')}</p>
        ) : null}
      </header>

      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('ops.alerts.detail.actions')}
      >
        {can('alert.ack') ? (
          <Button
            variant="primary"
            disabled={alert.state !== 'open' || ack.isPending}
            aria-keyshortcuts="A"
            onClick={() => {
              ack.mutate();
            }}
          >
            {t('ops.alerts.actions.ack')} <Kbd>A</Kbd>
          </Button>
        ) : null}
        {canSnooze ? (
          snoozed ? (
            <Button
              disabled={unsnooze.isPending}
              onClick={() => {
                unsnooze.mutate();
              }}
            >
              {t('ops.alerts.actions.unsnooze')}
            </Button>
          ) : (
            <Button
              aria-keyshortcuts="S"
              onClick={() => {
                setSnoozing(true);
              }}
            >
              {t('ops.alerts.actions.snooze')} <Kbd>S</Kbd>
            </Button>
          )
        ) : null}
        {can('incident.create') && alert.incidentId === null ? (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            <Siren aria-hidden className="size-4" />
            {t('ops.alerts.actions.createIncident')}
          </Button>
        ) : null}
        {alert.incidentId !== null ? (
          <AppLink
            href={`/incidents?incident=${encodeURIComponent(alert.incidentId)}`}
            className="text-sm text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('ops.alerts.actions.openIncident')}
          </AppLink>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3">
        <Fact label={t('ops.alerts.detail.service')}>
          {service
            ? service.name
            : alert.serviceId === null
              ? t('ops.alerts.unmapped')
              : alert.serviceId}
        </Fact>
        <Fact label={t('ops.alerts.detail.source')}>
          <AlertSourceText source={alert.source} />
        </Fact>
        <Fact label={t('ops.alerts.detail.count')}>{alert.count}</Fact>
        <Fact label={t('ops.alerts.detail.firstSeen')}>
          <Moment iso={alert.firstSeenAt} />
        </Fact>
        <Fact label={t('ops.alerts.detail.lastSeen')}>
          <Moment iso={alert.lastSeenAt} />
        </Fact>
        {alert.resolvedAt ? (
          <Fact label={t('ops.alerts.detail.resolvedAt')}>
            <Moment iso={alert.resolvedAt} />
          </Fact>
        ) : null}
      </dl>

      {alert.ackedAt ? (
        <p className="text-sm">
          {t('ops.alerts.detail.ackedVia', {
            via: alert.ackedVia
              ? t(`ops.alerts.via.${alert.ackedVia}`)
              : t('ops.alerts.via.unknown'),
          })}{' '}
          <Moment iso={alert.ackedAt} />
        </p>
      ) : null}
      {snoozed && alert.snoozedUntil ? (
        <p className="text-sm">
          {t('ops.alerts.detail.snoozedUntil')} <Moment iso={alert.snoozedUntil} />
          {alert.snoozeReason ? `: ${alert.snoozeReason}` : ''}
        </p>
      ) : null}
      {alert.correlationId !== null ? (
        <p className="text-sm text-muted-foreground">{t('ops.alerts.detail.correlated')}</p>
      ) : null}
      {url ? (
        <p className="text-sm">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('ops.alerts.detail.openProvider')}
          </a>
        </p>
      ) : null}

      <section aria-labelledby="alert-escalation" className="flex flex-col gap-1.5">
        <h3 id="alert-escalation" className="text-sm font-semibold">
          {t('ops.alerts.detail.escalation')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {alert.nextEscalationAt ? (
            <>
              {t('ops.alerts.detail.nextAt')} <Moment iso={alert.nextEscalationAt} />
            </>
          ) : (
            t('ops.alerts.detail.noNext')
          )}
        </p>
        {escalations.isPending ? (
          <OpsSkeleton rows={2} />
        ) : escalations.isError ? (
          <LoadError onRetry={() => void escalations.refetch()} />
        ) : escalations.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.alerts.detail.escalationNone')}</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {escalations.data.items.map((step) => (
              <li
                key={`${String(step.level)}-${step.createdAt}`}
                className="rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
              >
                <p className="font-medium">
                  {t('ops.alerts.detail.step', {
                    level: step.level + 1,
                    target: t(`ops.policies.target.${step.target}`),
                  })}{' '}
                  <span className="font-normal text-muted-foreground">
                    <Moment iso={step.createdAt} />
                  </span>
                </p>
                <p className="text-muted-foreground">
                  {t('ops.alerts.detail.recipients', { count: step.recipientCount })} ·{' '}
                  {t(`ops.alerts.chat.${step.chatState}`)}
                </p>
                {step.fallback === 'lead' ? (
                  <p className="text-muted-foreground">{t('ops.alerts.detail.fallbackLead')}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {labels.length > 0 ? (
        <section aria-labelledby="alert-labels" className="flex flex-col gap-1.5">
          <h3 id="alert-labels" className="text-sm font-semibold">
            {t('ops.alerts.detail.labels')}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {labels.map(([key, value]) => (
              <li key={key} className="rounded-full bg-surface-muted px-2 py-0.5 text-xs">
                {key}={value}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {query.data && query.data.events.length > 0 ? (
        <section aria-labelledby="alert-events" className="flex flex-col gap-1.5">
          <h3 id="alert-events" className="text-sm font-semibold">
            {t('ops.alerts.detail.events')}
          </h3>
          <ol className="flex flex-col gap-1 text-sm">
            {query.data.events.map((event) => (
              <li key={event.id}>
                {t(`ops.alerts.event.${event.type}`)}{' '}
                <Moment iso={event.occurredAt ?? event.createdAt} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <SnoozeDialog open={snoozing} onOpenChange={setSnoozing} alertId={alertId} onDone={refresh} />
      <CreateIncidentDialog open={creating} onOpenChange={setCreating} alert={alert} />
    </article>
  );
}

function SnoozeDialog({
  open,
  onOpenChange,
  alertId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alertId: string;
  onDone: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title={t('ops.alerts.snooze.title')}
          description={t('ops.alerts.snooze.description')}
          closeLabel={t('ops.common.close')}
        >
          <SnoozeForm
            alertId={alertId}
            onDone={async () => {
              await onDone();
              onOpenChange(false);
            }}
            onCancel={() => {
              onOpenChange(false);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function SnoozeForm({
  alertId,
  onDone,
  onCancel,
}: {
  alertId: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const base = useId();
  const [minutes, setMinutes] = useState<number>(60);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const snooze = useMutation({
    mutationFn: () => api.snoozeAlert(alertId, { minutes, reason: reason.trim() }),
    onSuccess: async () => {
      toast(t('ops.alerts.snooze.done'));
      await onDone();
    },
    onError: (e) => {
      setFailure(describeOpsError(e, t).message);
    },
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure(null);
        if (reason.trim().length < 3) {
          setError(t('ops.alerts.snooze.reasonShort'));
          return;
        }
        setError(null);
        snooze.mutate();
      }}
    >
      <FormField id={`${base}-minutes`} label={t('ops.alerts.snooze.duration')}>
        <Select
          id={`${base}-minutes`}
          value={String(minutes)}
          onChange={(event) => {
            setMinutes(Number(event.target.value));
          }}
        >
          {SNOOZE_CHOICES.map((value) => (
            <option key={value} value={value}>
              {t(SNOOZE_LABELS[value])}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        id={`${base}-reason`}
        label={t('ops.alerts.snooze.reason')}
        hint={t('ops.alerts.snooze.reasonHint')}
        {...(error ? { error } : {})}
      >
        <Input
          id={`${base}-reason`}
          value={reason}
          maxLength={500}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${base}-reason-hint${error ? ` ${base}-reason-error` : ''}`}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </FormField>
      {failure ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {failure}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel} disabled={snooze.isPending}>
          {t('ops.common.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={snooze.isPending}>
          {snooze.isPending ? t('ops.common.saving') : t('ops.alerts.snooze.submit')}
        </Button>
      </div>
    </form>
  );
}
