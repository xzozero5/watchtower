'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { INCIDENT_SEVERITIES, type Alert, type IncidentSeverity } from '@watchtower/shared';
import { Button, Dialog, DialogContent, Input, Select, toast } from '@watchtower/ui';
import { CircleX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { INCIDENT_SEVERITY_LABELS, describeOpsError } from '@/lib/ops/model';
import { opsKeys, useServices } from '@/lib/ops/queries';

/**
 * Opens an incident (R-3.12): a person chooses the title and the severity; nothing is guessed from
 * the alert. From an alert, that alert and its service come along. The severity has no default: it
 * is the person's call.
 */
export function CreateIncidentDialog({
  open,
  onOpenChange,
  alert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alert?: Alert | undefined;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title={t('ops.incidents.create.title')}
          description={t('ops.incidents.create.description')}
          closeLabel={t('ops.common.close')}
        >
          <CreateForm
            alert={alert}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function CreateForm({ alert, onDone }: { alert: Alert | undefined; onDone: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const router = useRouter();
  const queryClient = useQueryClient();
  const base = useId();
  const services = useServices();
  const [title, setTitle] = useState(alert?.title ?? '');
  const [severity, setSeverity] = useState<IncidentSeverity | ''>('');
  const [serviceIds, setServiceIds] = useState<string[]>(alert?.serviceId ? [alert.serviceId] : []);
  const [errors, setErrors] = useState<{ title?: string; severity?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createIncident({
        title: title.trim(),
        severity: severity as IncidentSeverity,
        serviceIds,
        alertIds: alert ? [alert.id] : [],
        ticketIds: [],
        orgIds: [],
      }),
    onSuccess: async (incident) => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).all });
      toast(t('ops.incidents.create.done', { key: incident.key }));
      onDone();
      router.push(`/incidents?incident=${encodeURIComponent(incident.id)}`);
    },
    onError: (error) => {
      setFailure(describeOpsError(error, t).message);
    },
  });

  const submit = () => {
    const next: { title?: string; severity?: string } = {};
    if (title.trim() === '') next.title = t('ops.common.required');
    if (severity === '') next.severity = t('ops.common.required');
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length === 0) create.mutate();
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 px-5 py-4"
    >
      <FormField
        id={`${base}-title`}
        label={t('ops.incidents.create.titleLabel')}
        {...(errors.title ? { error: errors.title } : {})}
      >
        <Input
          id={`${base}-title`}
          value={title}
          maxLength={200}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? `${base}-title-error` : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </FormField>
      <FormField
        id={`${base}-severity`}
        label={t('ops.incidents.create.severityLabel')}
        hint={t('ops.incidents.create.severityHint')}
        {...(errors.severity ? { error: errors.severity } : {})}
      >
        <Select
          id={`${base}-severity`}
          value={severity}
          aria-invalid={errors.severity ? true : undefined}
          aria-describedby={`${base}-severity-hint${errors.severity ? ` ${base}-severity-error` : ''}`}
          onChange={(event) => {
            setSeverity(event.target.value as IncidentSeverity | '');
          }}
        >
          <option value="">{t('ops.incidents.create.choose')}</option>
          {INCIDENT_SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {value} · {t(INCIDENT_SEVERITY_LABELS[value])}
            </option>
          ))}
        </Select>
      </FormField>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('ops.incidents.create.services')}</legend>
        {services.isPending ? (
          <p className="text-sm text-muted-foreground">{t('ops.common.loading')}</p>
        ) : (services.data?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.incidents.create.noServices')}</p>
        ) : (
          <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto">
            {(services.data?.items ?? []).map((service) => (
              <li key={service.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={serviceIds.includes(service.id)}
                    onChange={(event) => {
                      setServiceIds((current) =>
                        event.target.checked
                          ? [...current, service.id]
                          : current.filter((value) => value !== service.id),
                      );
                    }}
                  />
                  {service.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {alert ? (
        <p className="text-sm text-muted-foreground">
          {t('ops.incidents.create.fromAlert', { title: alert.title })}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="flex items-start gap-1 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{failure}</span>
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onDone} disabled={create.isPending}>
          {t('ops.common.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? t('ops.common.saving') : t('ops.incidents.create.submit')}
        </Button>
      </div>
    </form>
  );
}
