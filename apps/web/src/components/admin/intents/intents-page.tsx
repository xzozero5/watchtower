'use client';

import type { Intent } from '@watchtower/shared';
import {
  type DataTableColumn,
  DataTable,
  EmptyState,
  SeverityBadge,
  StageBadge,
} from '@watchtower/ui';
import { Lock, Tags } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';

import {
  AdminBody,
  AdminHeader,
  FilterField,
  useAdminListKeys,
} from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { useT } from '@/i18n/provider';
import { useAutonomy, useSlaPolicies } from '@/lib/admin/queries';
import { asStage, STAGE_LABEL_KEYS } from '@/lib/admin/stages';
import { usePreferences } from '@/lib/preferences';
import { severityOf } from '@/lib/tickets/model';
import { useIntents } from '@/lib/tickets/queries';

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
        <span className="flex flex-col">
          <AppLink
            href={`/admin/intents/${row.id}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {row.name}
          </AppLink>
          <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
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
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <StageBadge stage={stage} label={t(STAGE_LABEL_KEYS[stage])} />
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
          <FilterField
            value={filter}
            onChange={setFilter}
            label={t('admin.common.filter')}
            inputRef={filterRef}
          />
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
    </>
  );
}
