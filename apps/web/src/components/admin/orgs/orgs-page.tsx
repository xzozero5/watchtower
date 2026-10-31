'use client';

import type { Organization } from '@watchtower/shared';
import { Button, DataTable, type DataTableColumn, EmptyState, StatusDot } from '@watchtower/ui';
import { Building2, Plus } from 'lucide-react';
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
import { useOrgs, useSlaPolicies } from '@/lib/admin/queries';
import { usePreferences } from '@/lib/preferences';

import { OrgSheet } from './org-sheet';

export function OrgsPage() {
  return (
    <RequirePermission permission="org.manage" role="lead">
      <OrgsBody />
    </RequirePermission>
  );
}

function OrgsBody() {
  const t = useT();
  const router = useRouter();
  const { singleKeyShortcuts } = usePreferences();
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const q = filter.trim();
  const orgs = useOrgs(q.length >= 1 ? { q } : {});
  const policies = useSlaPolicies(true);
  useAdminListKeys({
    focusFilter: () => filterRef.current?.focus(),
    startNew: () => {
      setCreating(true);
    },
  });

  const rows = useMemo(() => (orgs.data?.pages ?? []).flatMap((page) => page.items), [orgs.data]);
  const policyName = useMemo(
    () => new Map((policies.data?.policies ?? []).map((policy) => [policy.id, policy.name])),
    [policies.data],
  );

  const columns: DataTableColumn<Organization>[] = [
    {
      id: 'name',
      header: t('admin.common.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <AppLink
          href={`/admin/orgs/${row.id}`}
          className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row.name}
        </AppLink>
      ),
    },
    {
      id: 'tier',
      header: t('admin.orgs.tier'),
      sortValue: (row) => row.tier,
      cell: (row) => row.tier,
    },
    {
      id: 'status',
      header: t('admin.common.status'),
      sortValue: (row) => row.status,
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={row.status === 'active' ? 'success' : 'outline'} />
          {row.status === 'active' ? t('admin.common.active') : t('admin.common.inactive')}
        </span>
      ),
    },
    {
      id: 'domains',
      header: t('admin.orgs.domains'),
      cell: (row) =>
        row.domains.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>
            {row.domains[0]}
            {row.domains.length > 1 ? (
              <span className="text-muted-foreground"> +{row.domains.length - 1}</span>
            ) : null}
          </span>
        ),
    },
    {
      id: 'sla',
      header: t('admin.orgs.slaPolicy'),
      cell: (row) =>
        row.slaPolicyId ? (
          (policyName.get(row.slaPolicyId) ?? '—')
        ) : (
          <span className="text-muted-foreground">{t('admin.orgs.tierDefault')}</span>
        ),
    },
  ];

  return (
    <>
      <AdminHeader
        title={t('admin.sections.orgs')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.orgs') },
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
              {t('admin.orgs.new')}
            </Button>
          </>
        }
      />
      <AdminBody>
        {orgs.isPending ? (
          <TableSkeleton />
        ) : orgs.isError ? (
          <LoadError onRetry={() => void orgs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title={q ? t('admin.common.nothingMatches') : t('admin.orgs.empty')}
            action={
              q ? (
                <Button
                  onClick={() => {
                    setFilter('');
                  }}
                >
                  {t('admin.common.clearFilters')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  {t('admin.orgs.new')}
                </Button>
              )
            }
          />
        ) : (
          <>
            <DataTable
              caption={t('admin.sections.orgs')}
              captionHidden
              columns={columns}
              rows={rows}
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.name}
              vimKeys={singleKeyShortcuts}
              onRowActivate={(row) => {
                router.push(`/admin/orgs/${row.id}`);
              }}
            />
            {orgs.hasNextPage ? (
              <div className="p-3">
                <Button
                  onClick={() => void orgs.fetchNextPage()}
                  disabled={orgs.isFetchingNextPage}
                >
                  {t('admin.audit.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </AdminBody>
      {creating ? (
        <OrgSheet
          open
          org={null}
          extraTiers={rows.map((row) => row.tier)}
          onClose={() => {
            setCreating(false);
          }}
          onSaved={(saved) => {
            router.push(`/admin/orgs/${saved.id}`);
          }}
        />
      ) : null}
    </>
  );
}
