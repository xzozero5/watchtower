'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  incidentStatusAllows,
  type IncidentDetail,
  type IncidentSeverity,
  type IncidentStatus,
} from '@watchtower/shared';
import {
  Button,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@watchtower/ui';
import { useId, useState } from 'react';

import { AskAiButton } from '@/components/assistant/ask-ai-button';

import { LoadError } from '@/components/admin/admin-page';
import {
  AttachmentDropZone,
  AttachmentGallery,
  AttachmentPicker,
  parseStaffAttachments,
  useAttachmentUpload,
} from '@/components/attachments';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { AppLink } from '@/components/app-link';
import { ChangesPanel } from '@/components/ops/incidents/changes-panel';
import { CommsPanel, canSeeComms } from '@/components/ops/incidents/comms-panel';
import {
  Fact,
  IncidentSeverityBadge,
  IncidentStatusChip,
  Moment,
  OpsSkeleton,
} from '@/components/ops/ops-bits';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeOpsError, INCIDENT_SEVERITY_LABELS } from '@/lib/ops/model';
import { opsKeys, useAlertList, useIncident } from '@/lib/ops/queries';
import { actorKey, timelineLine } from '@/lib/ops/timeline';
import { useTicketKeyExample } from '@/lib/runtime-config-context';
import { useAssignees } from '@/lib/shifts/queries';

/**
 * One incident (R-3.12 to R-3.15): who and what, the timeline, linked tickets and alerts, what
 * changed before it started, and the customer updates. Changing status, severity or commander is
 * one explicit Save; resolving is a separate act with its own permission and cannot be undone.
 */
export function IncidentDetailView({ incidentId }: { incidentId: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const query = useIncident(incidentId);
  if (query.isPending) return <OpsSkeleton rows={6} />;
  if (query.isError) {
    return (
      <LoadError
        message={t('ops.incidents.detail.loadError')}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const incident = query.data;
  return (
    <article aria-labelledby="incident-title" className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <AskAiElement element="incident.detail" scope={`incident:${incident.id}`} />
        <ElementInsight element="incident.detail" scope={`incident:${incident.id}`} period="now" />
        <div className="flex flex-wrap items-center gap-2">
          <IncidentSeverityBadge severity={incident.severity} />
          <IncidentStatusChip status={incident.status} />
          <span className="text-sm text-muted-foreground">{incident.key}</span>
          <AskAiButton entity={{ kind: 'incident', ref: incident.id }} label={incident.key} />
        </div>
        <h2 id="incident-title" className="text-lg font-semibold break-words">
          {incident.title}
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
          <Fact label={t('ops.incidents.detail.started')}>
            <Moment iso={incident.startedAt} />
          </Fact>
          {incident.resolvedAt ? (
            <Fact label={t('ops.incidents.detail.resolved')}>
              <Moment iso={incident.resolvedAt} />
            </Fact>
          ) : null}
          <CommanderFact commanderId={incident.commanderId} />
          <Fact label={t('ops.incidents.detail.counts')}>
            {t('ops.incidents.detail.countsValue', {
              tickets: incident.tickets,
              alerts: incident.alerts,
            })}
          </Fact>
        </dl>
        {incident.discordThreadState === 'mock' ? (
          <p className="text-sm text-muted-foreground">{t('ops.incidents.detail.threadMock')}</p>
        ) : null}
      </header>

      {can('incident.create') && incident.status !== 'resolved' ? (
        <EditForm incident={incident} />
      ) : null}
      {incident.status === 'resolved' ? (
        <p className="text-sm text-muted-foreground">{t('ops.incidents.detail.resolvedFinal')}</p>
      ) : null}
      {incident.rootCause ? (
        <section aria-labelledby="incident-rca" className="flex flex-col gap-1">
          <h3 id="incident-rca" className="text-sm font-semibold">
            {t('ops.incidents.detail.rootCause')}
          </h3>
          <p className="text-sm whitespace-pre-wrap break-words">{incident.rootCause}</p>
        </section>
      ) : null}

      <Tabs defaultValue="timeline" className="flex flex-col gap-3">
        <TabsList aria-label={t('ops.incidents.tabs.label')} className="flex-wrap">
          <TabsTrigger value="timeline">{t('ops.incidents.tabs.timeline')}</TabsTrigger>
          <TabsTrigger value="linked">{t('ops.incidents.tabs.linked')}</TabsTrigger>
          <TabsTrigger value="changes">{t('ops.incidents.tabs.changes')}</TabsTrigger>
          {canSeeComms(can) ? (
            <TabsTrigger value="updates">{t('ops.incidents.tabs.updates')}</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="timeline">
          <Timeline incident={incident} />
        </TabsContent>
        <TabsContent value="linked">
          <Linked incident={incident} />
        </TabsContent>
        <TabsContent value="changes">
          <ChangesPanel incidentId={incident.id} />
        </TabsContent>
        {canSeeComms(can) ? (
          <TabsContent value="updates">
            <CommsPanel incidentId={incident.id} />
          </TabsContent>
        ) : null}
      </Tabs>
    </article>
  );
}

function CommanderFact({ commanderId }: { commanderId: string | null }) {
  const { t } = useI18n();
  const { can } = useSession();
  const people = useAssignees(can('ticket.handle'));
  const name = people.data?.assignees.find((person) => person.id === commanderId)?.name;
  return (
    <Fact label={t('ops.incidents.detail.commander')}>
      {commanderId === null
        ? t('ops.incidents.detail.noCommander')
        : (name ?? t('ops.incidents.detail.someone'))}
    </Fact>
  );
}

function EditForm({ incident }: { incident: IncidentDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const base = useId();
  const people = useAssignees(can('ticket.handle'));
  const [status, setStatus] = useState<IncidentStatus>(incident.status);
  const [severity, setSeverity] = useState<IncidentSeverity>(incident.severity);
  const [commander, setCommander] = useState(incident.commanderId ?? '');
  const [rootCause, setRootCause] = useState(incident.rootCause ?? '');
  const [resolving, setResolving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: opsKeys(userId).incidents });
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateIncident>[1]) =>
      api.updateIncident(incident.id, body),
    onSuccess: async () => {
      setFailure(null);
      setResolving(false);
      await refresh();
      toast(t('ops.common.saved'));
    },
    onError: (error) => {
      setFailure(describeOpsError(error, t).message);
    },
  });

  const changes = {
    ...(status !== incident.status ? { status } : {}),
    ...(severity !== incident.severity ? { severity } : {}),
    ...(commander !== (incident.commanderId ?? '')
      ? { commanderId: commander === '' ? null : commander }
      : {}),
    ...(rootCause.trim() !== (incident.rootCause ?? '')
      ? { rootCause: rootCause.trim() === '' ? null : rootCause.trim() }
      : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      noValidate
      aria-label={t('ops.incidents.detail.editLabel')}
      className="flex flex-col gap-3 rounded-inner bg-surface shadow-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) save.mutate(changes);
      }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField id={`${base}-status`} label={t('ops.incidents.detail.status')}>
          <Select
            id={`${base}-status`}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as IncidentStatus);
            }}
          >
            {INCIDENT_STATUSES.filter(
              (value) =>
                value !== 'resolved' &&
                (value === incident.status || incidentStatusAllows(incident.status, value)),
            ).map((value) => (
              <option key={value} value={value}>
                {t(`ops.incidents.status.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id={`${base}-severity`} label={t('ops.incidents.detail.severity')}>
          <Select
            id={`${base}-severity`}
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value as IncidentSeverity);
            }}
          >
            {INCIDENT_SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {value} · {t(INCIDENT_SEVERITY_LABELS[value])}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id={`${base}-commander`} label={t('ops.incidents.detail.commander')}>
          <Select
            id={`${base}-commander`}
            value={commander}
            onChange={(e) => {
              setCommander(e.target.value);
            }}
          >
            <option value="">{t('ops.incidents.detail.noCommander')}</option>
            {(people.data?.assignees ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <FormField
        id={`${base}-rca`}
        label={t('ops.incidents.detail.rootCause')}
        optionalLabel={t('ops.common.optional')}
      >
        <Textarea
          id={`${base}-rca`}
          rows={3}
          maxLength={4000}
          value={rootCause}
          onChange={(e) => {
            setRootCause(e.target.value);
          }}
        />
      </FormField>
      {failure ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {failure}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
          {save.isPending ? t('ops.common.saving') : t('ops.common.save')}
        </Button>
        {can('incident.manage') ? (
          <Button
            onClick={() => {
              setResolving(true);
            }}
            disabled={save.isPending}
          >
            {t('ops.incidents.detail.resolve')}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={resolving}
        onOpenChange={setResolving}
        title={t('ops.incidents.detail.resolveTitle', { key: incident.key })}
        description={t('ops.incidents.detail.resolveBody')}
        confirmLabel={t('ops.incidents.detail.resolve')}
        onConfirm={() => {
          save.mutate({ status: 'resolved' });
        }}
        pending={save.isPending}
        error={failure}
      />
    </form>
  );
}

function Timeline({ incident }: { incident: IncidentDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const base = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const upload = useAttachmentUpload();
  const add = useMutation({
    mutationFn: () => api.addIncidentNote(incident.id, text.trim(), upload.attachmentIds),
    onSuccess: async () => {
      setText('');
      upload.clear();
      setError(null);
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).incident(incident.id) });
      toast(t('ops.incidents.timeline.noteAdded'));
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  const entries = [...incident.timeline].reverse();
  return (
    <section aria-label={t('ops.incidents.tabs.timeline')} className="flex flex-col gap-3">
      {can('incident.create') && incident.status !== 'resolved' ? (
        <form
          noValidate
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === '') {
              setError(t('ops.common.required'));
              return;
            }
            if (upload.busy) {
              setError(t('attachments.waitForUploads'));
              return;
            }
            add.mutate();
          }}
        >
          <FormField
            id={`${base}-note`}
            label={t('ops.incidents.timeline.noteLabel')}
            hint={t('ops.incidents.timeline.noteHint')}
            {...(error ? { error } : {})}
          >
            <AttachmentDropZone upload={upload} disabled={add.isPending}>
              <Input
                id={`${base}-note`}
                value={text}
                maxLength={2000}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${base}-note-hint${error ? ` ${base}-note-error` : ''}`}
                onChange={(e) => {
                  setText(e.target.value);
                }}
              />
            </AttachmentDropZone>
          </FormField>
          <AttachmentPicker upload={upload} disabled={add.isPending} />
          <div>
            <Button type="submit" disabled={add.isPending || upload.busy}>
              {t('ops.incidents.timeline.addNote')}
            </Button>
          </div>
        </form>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('ops.incidents.timeline.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
            >
              <p className="text-xs text-muted-foreground">
                {t(`ops.incidents.timeline.type.${entry.type}`)} · {t(actorKey(entry.actorType))} ·{' '}
                <Moment iso={entry.createdAt} />
              </p>
              <p className="whitespace-pre-wrap break-words">{timelineLine(entry, t)}</p>
              {entry.type === 'note' ? (
                <AttachmentGallery
                  attachments={parseStaffAttachments(entry.payload.attachments)}
                  className="mt-2"
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Linked({ incident }: { incident: IncidentDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const base = useId();
  const canLink = can('incident.create') && incident.status !== 'resolved';
  const [ticketRef, setTicketRef] = useState('');
  const example = useTicketKeyExample();
  const [alertId, setAlertId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const openAlerts = useAlertList(canLink && can('alert.read') ? { state: 'open' } : null);

  const tickets = useQueries({
    queries: incident.ticketIds.slice(0, 50).map((id) => ({
      queryKey: [...opsKeys(userId).all, 'ticket', id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => api.getTicket(id, signal),
      staleTime: 30_000,
    })),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: opsKeys(userId).incidents });
  const fail = (error: unknown) => {
    setFailure(describeOpsError(error, t).message);
  };

  const linkTicket = useMutation({
    mutationFn: async () => {
      const ticket = await api.getTicket(ticketRef.trim());
      return api.linkIncidentTicket(incident.id, ticket.id);
    },
    onSuccess: async () => {
      setTicketRef('');
      setFailure(null);
      await refresh();
    },
    onError: fail,
  });
  const unlinkTicket = useMutation({
    mutationFn: (ticketId: string) => api.unlinkIncidentTicket(incident.id, ticketId),
    onSuccess: async () => {
      setFailure(null);
      await refresh();
    },
    onError: fail,
  });
  const linkAlert = useMutation({
    mutationFn: () => api.linkIncidentAlert(incident.id, alertId),
    onSuccess: async () => {
      setAlertId('');
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).all });
    },
    onError: fail,
  });

  const linkable = (openAlerts.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (alert) => alert.incidentId === null,
  );

  return (
    <div className="flex flex-col gap-4">
      {failure ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {failure}
        </p>
      ) : null}
      <section aria-labelledby={`${base}-tickets`} className="flex flex-col gap-2">
        <h3 id={`${base}-tickets`} className="text-sm font-semibold">
          {t('ops.incidents.linked.tickets', { count: incident.ticketIds.length })}
        </h3>
        {incident.ticketIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.incidents.linked.noTickets')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {incident.ticketIds.slice(0, 50).map((id, index) => {
              const ticket = tickets[index]?.data;
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
                >
                  {ticket ? (
                    <AppLink
                      href={`/?ticket=${encodeURIComponent(ticket.key)}`}
                      className="min-w-0 break-words underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className="font-medium">{ticket.key}</span> {ticket.subject}
                    </AppLink>
                  ) : (
                    <span className="text-muted-foreground">{t('ops.common.loading')}</span>
                  )}
                  {canLink ? (
                    <Button
                      size="sm"
                      disabled={unlinkTicket.isPending}
                      onClick={() => {
                        unlinkTicket.mutate(id);
                      }}
                    >
                      {t('ops.incidents.linked.unlink')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {canLink ? (
          <form
            noValidate
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (ticketRef.trim() !== '') linkTicket.mutate();
            }}
          >
            <FormField
              id={`${base}-ref`}
              label={t('ops.incidents.linked.ticketKey')}
              hint={t('ops.incidents.linked.ticketKeyHint', { example })}
            >
              <Input
                id={`${base}-ref`}
                value={ticketRef}
                aria-describedby={`${base}-ref-hint`}
                onChange={(e) => {
                  setTicketRef(e.target.value);
                }}
              />
            </FormField>
            <Button type="submit" disabled={linkTicket.isPending || ticketRef.trim() === ''}>
              {t('ops.incidents.linked.linkTicket')}
            </Button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby={`${base}-alerts`} className="flex flex-col gap-2">
        <h3 id={`${base}-alerts`} className="text-sm font-semibold">
          {t('ops.incidents.linked.alerts', { count: incident.alertIds.length })}
        </h3>
        {incident.alertIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.incidents.linked.noAlerts')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {incident.alertIds.map((id) => (
              <li key={id} className="rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm">
                <AppLink
                  href={`/alerts?view=open&alert=${encodeURIComponent(id)}`}
                  className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {t('ops.incidents.linked.openAlert')}
                </AppLink>
              </li>
            ))}
          </ul>
        )}
        {canLink && can('alert.read') ? (
          <form
            noValidate
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (alertId !== '') linkAlert.mutate();
            }}
          >
            <FormField id={`${base}-alert`} label={t('ops.incidents.linked.pickAlert')}>
              <Select
                id={`${base}-alert`}
                value={alertId}
                onChange={(e) => {
                  setAlertId(e.target.value);
                }}
              >
                <option value="">
                  {linkable.length === 0
                    ? t('ops.incidents.linked.noOpenAlerts')
                    : t('ops.incidents.create.choose')}
                </option>
                {linkable.map((alert) => (
                  <option key={alert.id} value={alert.id}>
                    {alert.title}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button type="submit" disabled={linkAlert.isPending || alertId === ''}>
              {t('ops.incidents.linked.linkAlert')}
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
