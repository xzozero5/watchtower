'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StatusMaintenanceStaff } from '@watchtower/shared';
import { Button, EmptyState, Input, Textarea, TintChip, toast } from '@watchtower/ui';
import { Ban, CalendarClock, CircleCheck, FilePen, Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { Moment, OpsSkeleton } from '@/components/ops/ops-bits';
import { PublishDialog } from '@/components/ops/status/publish-dialog';
import { ComponentPicker } from '@/components/ops/status/status-posts';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeOpsError, isoToLocalInput, localInputToIso } from '@/lib/ops/model';
import {
  opsKeys,
  useStatusComponents,
  useStatusMaintenance,
  useStatusSubscribers,
} from '@/lib/ops/queries';

/** Planned maintenance windows (R-6.1). Drafting is for `incident.create`; publishing and cancelling for `incident.manage`. */
export function StatusMaintenanceSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const list = useStatusMaintenance();
  const components = useStatusComponents();
  const [editing, setEditing] = useState<StatusMaintenanceStaff | 'new' | null>(null);
  const [publishing, setPublishing] = useState<StatusMaintenanceStaff | null>(null);
  const [cancelling, setCancelling] = useState<StatusMaintenanceStaff | null>(null);
  const draftRight = can('incident.create');
  const manageRight = can('incident.manage');
  const nameOf = (id: string) => components.data?.items.find((c) => c.id === id)?.name ?? id;
  return (
    <section aria-label={t('ops.statusAdmin.maintenance.title')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('ops.statusAdmin.maintenance.title')}</h2>
        {draftRight ? (
          <Button
            onClick={() => {
              setEditing('new');
            }}
          >
            <Plus aria-hidden className="size-4" />
            {t('ops.statusAdmin.maintenance.add')}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('ops.statusAdmin.maintenance.intro')}</p>
      {list.isPending ? (
        <OpsSkeleton rows={3} />
      ) : list.isError ? (
        <LoadError onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title={t('ops.statusAdmin.maintenance.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.data.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <TintChip
                  tone={
                    item.state === 'published'
                      ? 'green'
                      : item.state === 'cancelled'
                        ? 'slate'
                        : 'amber'
                  }
                  icon={
                    item.state === 'published'
                      ? CircleCheck
                      : item.state === 'cancelled'
                        ? Ban
                        : FilePen
                  }
                >
                  {t(`ops.statusAdmin.maintenance.state.${item.state}`)}
                </TintChip>
                <span className="text-xs text-muted-foreground">
                  <Moment iso={item.startsAt} /> – <Moment iso={item.endsAt} />
                </span>
              </div>
              <p className="font-medium break-words">{item.title}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{item.body}</p>
              {item.componentIds.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {item.componentIds.map(nameOf).join(', ')}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {item.state === 'draft' && draftRight ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(item);
                    }}
                  >
                    {t('ops.common.edit')}
                  </Button>
                ) : null}
                {item.state === 'draft' && manageRight ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setPublishing(item);
                    }}
                  >
                    {t('ops.statusAdmin.publish')}
                  </Button>
                ) : null}
                {item.state === 'published' && manageRight ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setCancelling(item);
                    }}
                  >
                    {t('ops.statusAdmin.maintenance.cancel')}
                  </Button>
                ) : null}
                {item.state === 'draft' && !manageRight ? (
                  <span className="text-xs text-muted-foreground">
                    {t('ops.statusAdmin.leadPublishes')}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <MaintenanceSheet
          key={editing === 'new' ? 'new' : editing.id}
          item={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {publishing ? (
        <PublishMaintenance
          item={publishing}
          onClose={() => {
            setPublishing(null);
          }}
        />
      ) : null}
      {cancelling ? (
        <CancelMaintenance
          item={cancelling}
          onClose={() => {
            setCancelling(null);
          }}
        />
      ) : null}
    </section>
  );
}

function MaintenanceSheet({
  item,
  onClose,
}: {
  item: StatusMaintenanceStaff | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const components = useStatusComponents();
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [starts, setStarts] = useState(item ? isoToLocalInput(item.startsAt) : '');
  const [ends, setEnds] = useState(item ? isoToLocalInput(item.endsAt) : '');
  const [componentIds, setComponentIds] = useState<string[]>(item?.componentIds ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => {
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (fields: {
      title: string;
      body: string;
      startsAt: string;
      endsAt: string;
      componentIds: string[];
    }) =>
      item === null
        ? api.createStatusMaintenance(fields)
        : api.updateStatusMaintenance(item.id, fields),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusMaintenance });
      toast(t('ops.common.saved'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const submit = () => {
    const next: Record<string, string> = {};
    const startsAt = localInputToIso(starts);
    const endsAt = localInputToIso(ends);
    if (title.trim() === '') next.title = t('ops.common.required');
    if (body.trim() === '') next.body = t('ops.common.required');
    if (startsAt === null) next.starts = t('ops.common.required');
    if (endsAt === null) next.ends = t('ops.common.required');
    else if (startsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt))
      next.ends = t('ops.statusAdmin.maintenance.endAfterStart');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0 && startsAt !== null && endsAt !== null) {
      save.mutate({ title: title.trim(), body: body.trim(), startsAt, endsAt, componentIds });
    }
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={item ? item.title : t('ops.statusAdmin.maintenance.add')}
      description={t('ops.statusAdmin.maintenance.sheetDescription')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-title`}
          label={t('ops.statusAdmin.posts.titleLabel')}
          {...(errors.title ? { error: errors.title } : {})}
        >
          <Input
            id={`${base}-title`}
            value={title}
            maxLength={200}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? `${base}-title-error` : undefined}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField
          id={`${base}-body`}
          label={t('ops.statusAdmin.posts.bodyLabel')}
          hint={t('ops.statusAdmin.posts.bodyHint')}
          {...(errors.body ? { error: errors.body } : {})}
        >
          <Textarea
            id={`${base}-body`}
            rows={4}
            maxLength={5000}
            value={body}
            aria-invalid={errors.body ? true : undefined}
            aria-describedby={`${base}-body-hint${errors.body ? ` ${base}-body-error` : ''}`}
            onChange={(e) => {
              setBody(e.target.value);
              touch();
            }}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            id={`${base}-starts`}
            label={t('ops.statusAdmin.maintenance.starts')}
            {...(errors.starts ? { error: errors.starts } : {})}
          >
            <Input
              id={`${base}-starts`}
              type="datetime-local"
              value={starts}
              aria-invalid={errors.starts ? true : undefined}
              aria-describedby={errors.starts ? `${base}-starts-error` : undefined}
              onChange={(e) => {
                setStarts(e.target.value);
                touch();
              }}
            />
          </FormField>
          <FormField
            id={`${base}-ends`}
            label={t('ops.statusAdmin.maintenance.ends')}
            {...(errors.ends ? { error: errors.ends } : {})}
          >
            <Input
              id={`${base}-ends`}
              type="datetime-local"
              value={ends}
              aria-invalid={errors.ends ? true : undefined}
              aria-describedby={errors.ends ? `${base}-ends-error` : undefined}
              onChange={(e) => {
                setEnds(e.target.value);
                touch();
              }}
            />
          </FormField>
        </div>
        <ComponentPicker
          id={`${base}-components`}
          legend={t('ops.statusAdmin.affected')}
          components={components.data?.items ?? []}
          value={componentIds}
          onChange={(next) => {
            setComponentIds(next);
            touch();
          }}
        />
      </form>
    </EntitySheet>
  );
}

function PublishMaintenance({
  item,
  onClose,
}: {
  item: StatusMaintenanceStaff;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const subscribers = useStatusSubscribers(true);
  const [error, setError] = useState<string | null>(null);
  const publish = useMutation({
    mutationFn: () => api.publishStatusMaintenance(item.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusMaintenance });
      toast(t('ops.statusAdmin.posts.published', { count: result.subscribers }));
      onClose();
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  return (
    <PublishDialog
      title={t('ops.statusAdmin.maintenance.publishTitle')}
      description={
        subscribers.data
          ? t('ops.statusAdmin.publishBody', { count: subscribers.data.confirmed })
          : t('ops.statusAdmin.publishBodyUnknown')
      }
      heading={item.title}
      body={item.body}
      confirmLabel={t('ops.statusAdmin.publish')}
      onConfirm={() => {
        publish.mutate();
      }}
      onClose={onClose}
      pending={publish.isPending}
      error={error}
    />
  );
}

function CancelMaintenance({
  item,
  onClose,
}: {
  item: StatusMaintenanceStaff;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => api.cancelStatusMaintenance(item.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusMaintenance });
      toast(t('ops.statusAdmin.maintenance.cancelled'));
      onClose();
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('ops.statusAdmin.maintenance.cancelTitle', { title: item.title })}
      description={t('ops.statusAdmin.maintenance.cancelBody')}
      confirmLabel={t('ops.statusAdmin.maintenance.cancel')}
      onConfirm={() => {
        cancel.mutate();
      }}
      pending={cancel.isPending}
      error={error}
    />
  );
}
