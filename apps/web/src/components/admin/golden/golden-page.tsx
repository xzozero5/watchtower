'use client';

import type { GoldenAnswer } from '@watchtower/shared';
import {
  DataTable,
  type DataTableColumn,
  EmptyState,
  HelpHint,
  IconButton,
  Button,
  toast,
} from '@watchtower/ui';
import { RefreshCw, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { AppLink } from '@/components/app-link';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { useDeleteGolden, useGoldenAnswers } from '@/lib/ai/grade-queries';
import { humanizeKey } from '@/lib/ai/prose';
import { isApiError } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { useNow } from '@/lib/use-now';

/** Lead and head: the replies kept as examples for the drafter (T-302a), with a way to take one back. */
export function GoldenPage() {
  return (
    <RequirePermission permission="ai.golden.manage" role="lead">
      <GoldenBody />
    </RequirePermission>
  );
}

function GoldenBody() {
  const { t, locale } = useI18n();
  const now = useNow();
  const list = useGoldenAnswers(true);
  const remove = useDeleteGolden();
  const [target, setTarget] = useState<GoldenAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data?.items ?? [];

  const columns: DataTableColumn<GoldenAnswer>[] = [
    {
      id: 'intent',
      header: t('grade.admin.col.intent'),
      cell: (row) => (
        <span title={row.intent.key}>{row.intent.name || humanizeKey(row.intent.key)}</span>
      ),
    },
    {
      id: 'reply',
      header: t('grade.admin.col.reply'),
      cell: (row) => <p className="max-w-xl text-sm break-words whitespace-pre-wrap">{row.text}</p>,
    },
    {
      id: 'ticket',
      header: t('grade.admin.col.ticket'),
      cell: (row) =>
        row.ticketKey === null ? (
          '—'
        ) : (
          <AppLink
            href={`/?ticket=${encodeURIComponent(row.ticketKey)}`}
            className="text-link underline"
          >
            {row.ticketKey}
          </AppLink>
        ),
    },
    {
      id: 'by',
      header: t('grade.admin.col.by'),
      cell: (row) => row.createdBy?.name ?? t('grade.admin.unknownPerson'),
    },
    {
      id: 'when',
      header: t('grade.admin.col.when'),
      cell: (row) => (
        <time dateTime={row.createdAt}>{formatRelative(row.createdAt, now, locale)}</time>
      ),
    },
    {
      id: 'actions',
      header: t('grade.admin.col.actions'),
      hideHeader: true,
      className: 'w-28 text-right',
      cell: (row) => (
        <Button
          aria-label={t('grade.admin.removeFor', { ticket: row.ticketKey ?? row.id })}
          onClick={() => {
            setError(null);
            setTarget(row);
          }}
        >
          <Trash2 aria-hidden className="size-4" />
          {t('grade.admin.remove')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <AdminHeader
        title={t('grade.admin.title')}
        breadcrumb={[{ label: t('rail.admin'), href: '/admin' }, { label: t('grade.admin.title') }]}
        actions={
          <>
            <HelpHint label={t('grade.admin.helpLabel')}>{t('grade.admin.help')}</HelpHint>
            <IconButton
              label={t('grade.admin.refresh')}
              icon={<RefreshCw aria-hidden className="size-4" />}
              onClick={() => void list.refetch()}
            />
          </>
        }
      />
      <AdminBody>
        <div className="flex flex-col gap-4 p-4">
          {list.isPending ? (
            <TableSkeleton rows={3} />
          ) : list.isError ? (
            <LoadError message={t('grade.admin.loadError')} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Star />}
              title={t('grade.admin.empty')}
              description={t('grade.admin.emptyHint')}
            />
          ) : (
            <DataTable
              caption={t('grade.admin.title')}
              captionHidden
              columns={columns}
              rows={rows}
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.ticketKey ?? row.id}
            />
          )}
        </div>
      </AdminBody>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={t('grade.admin.confirmTitle')}
        description={t('grade.admin.confirmBody', {
          intent: target ? target.intent.name || humanizeKey(target.intent.key) : '',
        })}
        confirmLabel={t('grade.admin.remove')}
        pending={remove.isPending}
        error={error}
        onConfirm={() => {
          if (!target) return;
          remove.mutate(target.id, {
            onSuccess: () => {
              setTarget(null);
              toast(t('grade.admin.removed'));
            },
            onError: (failure) => {
              setError(
                isApiError(failure) && failure.status === 404
                  ? t('grade.admin.notFound')
                  : describeError(failure, t).message,
              );
            },
          });
        }}
      />
    </>
  );
}
