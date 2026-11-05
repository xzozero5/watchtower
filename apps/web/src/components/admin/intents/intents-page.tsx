'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { INTENT_KEY_PATTERN, type Intent } from '@watchtower/shared';
import {
  type DataTableColumn,
  DataTable,
  Button,
  EmptyState,
  Input,
  SeverityBadge,
  StageBadge,
  Textarea,
  toast,
} from '@watchtower/ui';
import { Lock, Plus, Tags } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useRef, useState } from 'react';

import {
  AdminBody,
  AdminHeader,
  FilterField,
  useAdminListKeys,
} from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { AppLink } from '@/components/app-link';
import { AskAiButton } from '@/components/assistant/ask-ai-button';
import { FormField } from '@/components/portal/form-field';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useAutonomy, useSlaPolicies } from '@/lib/admin/queries';
import { asStage, STAGE_LABEL_KEYS, STAGE3_MODE_KEYS, stage3Mode } from '@/lib/admin/stages';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { usePreferences } from '@/lib/preferences';
import { severityOf } from '@/lib/tickets/model';
import { referenceKeys, useIntents } from '@/lib/tickets/queries';

export function isFullIntent(item: unknown): item is Intent {
  return typeof item === 'object' && item !== null && 'autonomyStage' in item;
}

export function IntentsPage() {
  return (
    <RequirePermission permission="intent.manage" role="lead">
      <IntentsBody />
    </RequirePermission>
  );
}

function IntentsBody() {
  const t = useT();
  const router = useRouter();
  const { singleKeyShortcuts } = usePreferences();
  const intents = useIntents(true);
  const autonomy = useAutonomy(true);
  const policies = useSlaPolicies(true);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  useAdminListKeys({ focusFilter: () => filterRef.current?.focus() });

  const stageById = useMemo(
    () => new Map((autonomy.data?.intents ?? []).map((item) => [item.id, item])),
    [autonomy.data],
  );
  const policyName = useMemo(
    () => new Map((policies.data?.policies ?? []).map((policy) => [policy.id, policy.name])),
    [policies.data],
  );
  const rows = useMemo(
    () =>
      (intents.data?.intents ?? [])
        .filter(isFullIntent)
        .filter((intent) =>
          `${intent.name} ${intent.key}`.toLowerCase().includes(filter.trim().toLowerCase()),
        ),
    [intents.data, filter],
  );

  const columns: DataTableColumn<Intent>[] = [
    {
      id: 'name',
      header: t('admin.intents.col.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <span className="flex items-center gap-1">
          <span className="flex flex-col">
            <AppLink
              href={`/admin/intents/${row.id}`}
              className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {row.name}
            </AppLink>
            <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
          </span>
          <AskAiButton entity={{ kind: 'intent', ref: row.id }} label={row.name} />
        </span>
      ),
    },
    {
      id: 'priority',
      header: t('admin.intents.col.priority'),
      sortValue: (row) => row.defaultPriority,
      cell: (row) => (
        <SeverityBadge
          severity={severityOf(row.defaultPriority)}
          label={t(`severity.${severityOf(row.defaultPriority)}`)}
        />
      ),
    },
    {
      id: 'sla',
      header: t('admin.intents.col.sla'),
      cell: (row) =>
        row.slaPolicyId ? (
          (policyName.get(row.slaPolicyId) ?? '—')
        ) : (
          <span className="text-muted-foreground">{t('admin.orgs.tierDefault')}</span>
        ),
    },
    {
      id: 'stage',
      header: t('admin.intents.col.stage'),
      sortValue: (row) => stageById.get(row.id)?.stage ?? row.autonomyStage,
      cell: (row) => {
        const state = stageById.get(row.id);
        const stage = asStage(state?.stage ?? row.autonomyStage);
        const mode = state ? stage3Mode(state) : null;
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <StageBadge stage={stage} label={t(STAGE_LABEL_KEYS[stage])} />
            {mode ? <span className="text-xs">{t(STAGE3_MODE_KEYS[mode])}</span> : null}
            {state?.pinned ? (
              <span className="inline-flex items-center gap-1 text-xs">
                <Lock aria-hidden className="size-3" />
                {t('admin.intents.pinned')}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: 'active',
      header: t('admin.common.status'),
      sortValue: (row) => (row.isActive ? 0 : 1),
      cell: (row) => (row.isActive ? t('admin.common.active') : t('admin.common.inactive')),
    },
  ];

  return (
    <>
      <AdminHeader
        title={t('admin.sections.intents')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.intents') },
        ]}
        actions={
          <>
            <FilterField
              value={filter}
              onChange={setFilter}
              label={t('admin.common.filter')}
              inputRef={filterRef}
            />
            <Button
              variant="primary"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Plus aria-hidden className="size-4" />
              {t('admin.intents.new')}
            </Button>
          </>
        }
      />
      <AdminBody>
        {intents.isPending ? (
          <TableSkeleton />
        ) : intents.isError ? (
          <LoadError onRetry={() => void intents.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Tags />}
            title={filter ? t('admin.common.nothingMatches') : t('admin.intents.empty')}
            {...(filter ? {} : { description: t('admin.intents.emptyHint') })}
          />
        ) : (
          <DataTable
            caption={t('admin.sections.intents')}
            captionHidden
            columns={columns}
            rows={rows}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.name}
            vimKeys={singleKeyShortcuts}
            onRowActivate={(row) => {
              router.push(`/admin/intents/${row.id}`);
            }}
          />
        )}
      </AdminBody>
      {creating ? (
        <NewIntentSheet
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(id) => {
            router.push(`/admin/intents/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Create an intent (`POST /v1/intents`, `intent.manage`). The api sets the stage to 2 and offers no
 * way to choose another (N3), so the form only states it. Errors from the api (a taken key, a
 * rejected field) are shown above the form.
 */
export function NewIntentSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.createIntent({ key: key.trim(), name: name.trim(), description: description.trim() }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: referenceKeys(userId).intents });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
      toast(t('admin.common.saved'));
      onClose();
      onCreated?.(created.id);
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={t('admin.intents.new')}
      description={t('admin.intents.newDescription')}
      dirty={name !== '' || key !== '' || description !== ''}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSummary(null);
          const nameMissing = name.trim() === '';
          const keyBad = !INTENT_KEY_PATTERN.test(key.trim());
          setNameError(nameMissing ? t('admin.common.required') : null);
          setKeyError(keyBad ? t('admin.intents.keyInvalid') : null);
          if (nameMissing || keyBad) return;
          save.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-name`}
          label={t('admin.common.name')}
          {...(nameError ? { error: nameError } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-key`}
          label={t('admin.intents.keyLabel')}
          hint={t('admin.intents.keyHint')}
          {...(keyError ? { error: keyError } : {})}
        >
          <Input
            id={`${base}-key`}
            value={key}
            className="font-mono"
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? `${base}-key-error` : `${base}-key-hint`}
            onChange={(event) => {
              setKey(event.target.value);
            }}
          />
        </FormField>
        <FormField id={`${base}-description`} label={t('admin.intents.description')}>
          <Textarea
            id={`${base}-description`}
            rows={3}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </FormField>
        <p className="text-sm text-muted-foreground">{t('admin.intents.startsAt')}</p>
      </form>
    </EntitySheet>
  );
}
