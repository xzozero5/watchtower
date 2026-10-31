'use client';

import type { SlaPolicy, SlaTargets } from '@watchtower/shared';
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@watchtower/ui';
import { CalendarDays, Plus, Timer } from 'lucide-react';
import { useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { useI18n } from '@/i18n/provider';
import type { CalendarView } from '@/lib/admin/contracts';
import { useCalendars, useSlaPolicies } from '@/lib/admin/queries';
import { formatDuration } from '@/lib/format';
import { usePreferences } from '@/lib/preferences';

import { PolicySheet } from './policy-sheet';

export function SlaPage() {
  return (
    <RequirePermission permission="sla.manage" role="head">
      <SlaBody />
    </RequirePermission>
  );
}

const minutes = (value: number) => value * 60_000;

function targetText(targets: SlaTargets, priority: 'P1' | 'P2' | 'P3' | 'P4', locale: 'en' | 'th') {
  const target = targets[priority];
  if (!target) return '—';
  return `${formatDuration(minutes(target.first_response_min), locale)} / ${formatDuration(minutes(target.resolution_min), locale)}`;
}

function SlaBody() {
  const { t, locale } = useI18n();
  const { singleKeyShortcuts } = usePreferences();
  const policies = useSlaPolicies(true);
  const calendars = useCalendars(true);
  const [sheet, setSheet] = useState<{ policy: SlaPolicy | null } | null>(null);
  const calendarName = new Map((calendars.data?.calendars ?? []).map((c) => [c.id, c.name]));

  const policyColumns: DataTableColumn<SlaPolicy>[] = [
    {
      id: 'name',
      header: t('admin.common.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <button
          type="button"
          onClick={() => {
            setSheet({ policy: row });
          }}
          className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row.name}
        </button>
      ),
    },
    { id: 'tier', header: t('admin.orgs.tier'), cell: (row) => row.tier ?? '—' },
    ...(['P1', 'P2', 'P3', 'P4'] as const).map((priority): DataTableColumn<SlaPolicy> => ({
      id: priority,
      header: priority,
      className: 'tabular whitespace-nowrap',
      cell: (row) => targetText(row.targets, priority, locale),
    })),
    {
      id: 'calendar',
      header: t('admin.sla.calendar'),
      cell: (row) =>
        row.businessCalendarId ? (calendarName.get(row.businessCalendarId) ?? '—') : '—',
    },
  ];

  const calendarColumns: DataTableColumn<CalendarView>[] = [
    {
      id: 'name',
      header: t('admin.common.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <AppLink
          href={`/admin/sla/calendars/${row.id}`}
          className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row.name}
        </AppLink>
      ),
    },
    { id: 'tz', header: t('admin.sla.timezone'), cell: (row) => row.timezone },
    {
      id: 'default',
      header: t('admin.sla.default'),
      cell: (row) => (row.isDefault ? t('admin.common.yes') : '—'),
    },
    {
      id: 'holidays',
      header: t('admin.sla.holidays'),
      sortValue: (row) => row.holidays.length,
      className: 'tabular',
      cell: (row) => row.holidays.length,
    },
  ];

  return (
    <>
      <AdminHeader
        title={t('admin.sections.sla')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.sla') },
        ]}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setSheet({ policy: null });
            }}
          >
            <Plus aria-hidden className="size-4" />
            {t('admin.sla.newPolicy')}
          </Button>
        }
      />
      <AdminBody>
        <Tabs defaultValue="policies" className="flex flex-col">
          <TabsList className="border-b border-border px-4 pt-1.5 pb-2">
            <TabsTrigger value="policies">{t('admin.sla.policies')}</TabsTrigger>
            <TabsTrigger value="calendars">{t('admin.sla.calendars')}</TabsTrigger>
          </TabsList>
          <TabsContent value="policies">
            {policies.isPending ? (
              <TableSkeleton />
            ) : policies.isError ? (
              <LoadError onRetry={() => void policies.refetch()} />
            ) : policies.data.policies.length === 0 ? (
              <EmptyState icon={<Timer />} title={t('admin.sla.empty')} />
            ) : (
              <DataTable
                caption={t('admin.sla.policies')}
                captionHidden
                columns={policyColumns}
                rows={policies.data.policies}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                vimKeys={singleKeyShortcuts}
                onRowActivate={(row) => {
                  setSheet({ policy: row });
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="calendars">
            {calendars.isPending ? (
              <TableSkeleton />
            ) : calendars.isError ? (
              <LoadError onRetry={() => void calendars.refetch()} />
            ) : calendars.data.calendars.length === 0 ? (
              <EmptyState icon={<CalendarDays />} title={t('admin.sla.noCalendars')} />
            ) : (
              <DataTable
                caption={t('admin.sla.calendars')}
                captionHidden
                columns={calendarColumns}
                rows={calendars.data.calendars}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                vimKeys={singleKeyShortcuts}
              />
            )}
          </TabsContent>
        </Tabs>
      </AdminBody>
      {sheet ? (
        <PolicySheet
          open
          policy={sheet.policy}
          onClose={() => {
            setSheet(null);
          }}
        />
      ) : null}
    </>
  );
}
