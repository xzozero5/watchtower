'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  STATUS_COMPONENT_STATUSES,
  type StatusComponent,
  type StatusComponentStatus,
} from '@watchtower/shared';
import { Button, EmptyState, Input, Select, TintChip, toast } from '@watchtower/ui';
import { Eye, EyeOff, Plus, Radio } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { OpsSkeleton } from '@/components/ops/ops-bits';
import { StatusComponentChip } from '@/components/ops/status/status-bits';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeOpsError } from '@/lib/ops/model';
import { opsKeys, useServices, useStatusComponents } from '@/lib/ops/queries';

/**
 * Components of the public status page (R-6.1). Whether one is shown to the public is its own
 * switch, off by default; a component that is hidden here is never in the public answer.
 */
export function StatusComponentsSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const list = useStatusComponents();
  const [editing, setEditing] = useState<StatusComponent | 'new' | null>(null);
  const [deleting, setDeleting] = useState<StatusComponent | null>(null);
  const manage = can('service.manage');
  return (
    <section aria-label={t('ops.statusAdmin.components.title')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('ops.statusAdmin.components.title')}</h2>
        {manage ? (
          <Button
            onClick={() => {
              setEditing('new');
            }}
          >
            <Plus aria-hidden className="size-4" />
            {t('ops.statusAdmin.components.add')}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('ops.statusAdmin.components.intro')}</p>
      {list.isPending ? (
        <OpsSkeleton rows={3} />
      ) : list.isError ? (
        <LoadError onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Radio />} title={t('ops.statusAdmin.components.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.data.items.map((component) => (
            <li
              key={component.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{component.name}</span>
                  <code className="text-xs text-muted-foreground">{component.slug}</code>
                  <StatusComponentChip status={component.status} />
                  {component.public ? (
                    <TintChip tone="sky" icon={Eye}>
                      {t('ops.statusAdmin.components.public')}
                    </TintChip>
                  ) : (
                    <TintChip tone="slate" icon={EyeOff}>
                      {t('ops.statusAdmin.components.hidden')}
                    </TintChip>
                  )}
                </p>
                {component.description ? (
                  <p className="text-muted-foreground">{component.description}</p>
                ) : null}
              </div>
              {manage ? (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(component);
                    }}
                  >
                    {t('ops.common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setDeleting(component);
                    }}
                  >
                    {t('ops.common.delete')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <ComponentSheet
          key={editing === 'new' ? 'new' : editing.id}
          component={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteComponent
          component={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DeleteComponent({
  component,
  onClose,
}: {
  component: StatusComponent;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.deleteStatusComponent(component.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).all });
      toast(t('ops.common.deleted'));
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
      title={t('ops.statusAdmin.components.deleteTitle', { name: component.name })}
      description={t('ops.statusAdmin.components.deleteBody')}
      confirmLabel={t('ops.common.delete')}
      onConfirm={() => {
        remove.mutate();
      }}
      pending={remove.isPending}
      error={error}
    />
  );
}

function ComponentSheet({
  component,
  onClose,
}: {
  component: StatusComponent | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const services = useServices();
  const [slug, setSlug] = useState(component?.slug ?? '');
  const [name, setName] = useState(component?.name ?? '');
  const [description, setDescription] = useState(component?.description ?? '');
  const [serviceId, setServiceId] = useState(component?.serviceId ?? '');
  const [isPublic, setIsPublic] = useState(component?.public ?? false);
  const [status, setStatus] = useState<StatusComponentStatus>(component?.status ?? 'operational');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => {
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () =>
      component === null
        ? api.createStatusComponent({
            slug: slug.trim(),
            name: name.trim(),
            description: description.trim() === '' ? null : description.trim(),
            serviceId: serviceId === '' ? null : serviceId,
            public: isPublic,
          })
        : api.updateStatusComponent(component.id, {
            name: name.trim(),
            description: description.trim() === '' ? null : description.trim(),
            serviceId: serviceId === '' ? null : serviceId,
            public: isPublic,
            status,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).statusComponents });
      toast(t('ops.common.saved'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (
      component === null &&
      (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim()) || slug.trim().length < 2)
    ) {
      next.slug = t('ops.services.slugInvalid');
    }
    if (name.trim() === '') next.name = t('ops.common.required');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={component ? component.name : t('ops.statusAdmin.components.add')}
      description={t('ops.statusAdmin.components.sheetDescription')}
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
          label={t('ops.common.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              touch();
            }}
          />
        </FormField>
        {component === null ? (
          <FormField
            id={`${base}-slug`}
            label={t('ops.services.slug')}
            hint={t('ops.services.slugHint')}
            {...(errors.slug ? { error: errors.slug } : {})}
          >
            <Input
              id={`${base}-slug`}
              value={slug}
              aria-invalid={errors.slug ? true : undefined}
              aria-describedby={`${base}-slug-hint${errors.slug ? ` ${base}-slug-error` : ''}`}
              onChange={(e) => {
                setSlug(e.target.value);
                touch();
              }}
            />
          </FormField>
        ) : null}
        <FormField
          id={`${base}-description`}
          label={t('ops.statusAdmin.components.description')}
          optionalLabel={t('ops.common.optional')}
        >
          <Input
            id={`${base}-description`}
            value={description}
            maxLength={500}
            onChange={(e) => {
              setDescription(e.target.value);
              touch();
            }}
          />
        </FormField>
        {component !== null ? (
          <FormField id={`${base}-status`} label={t('ops.statusAdmin.components.status')}>
            <Select
              id={`${base}-status`}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as StatusComponentStatus);
                touch();
              }}
            >
              {STATUS_COMPONENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`ops.status.component.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        <FormField
          id={`${base}-service`}
          label={t('ops.statusAdmin.components.service')}
          optionalLabel={t('ops.common.optional')}
        >
          <Select
            id={`${base}-service`}
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              touch();
            }}
          >
            <option value="">{t('ops.common.none')}</option>
            {(services.data?.items ?? []).map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>
        </FormField>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={isPublic}
            onChange={(e) => {
              setIsPublic(e.target.checked);
              touch();
            }}
          />
          <span>
            {t('ops.statusAdmin.components.showPublic')}
            <span className="block text-muted-foreground">
              {t('ops.statusAdmin.components.showPublicHint')}
            </span>
          </span>
        </label>
      </form>
    </EntitySheet>
  );
}
