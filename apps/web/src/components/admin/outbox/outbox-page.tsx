'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type DeadOutboxEffect,
  type DeadOutboxItem,
  formatTicketKey,
  type OutboxHealth,
  type OutboxHealthStatus,
} from '@watchtower/shared';
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  HelpHint,
  IconButton,
  TintChip,
  type TintId,
  toast,
} from '@watchtower/ui';
import {
  CircleCheck,
  type LucideIcon,
  OctagonAlert,
  RefreshCw,
  RotateCcw,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useDeadOutbox, useOutboxHealth } from '@/lib/admin/queries';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { formatRelative } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { useRuntimeConfig } from '@/lib/runtime-config-context';
import type { Locale, Translate } from '@/i18n';

/** Icon, tone and words for the age of the oldest waiting job: never a colour on its own. */
const STATUS_LOOK: Record<OutboxHealthStatus, { icon: LucideIcon; tone: TintId }> = {
  ok: { icon: CircleCheck, tone: 'green' },
  warning: { icon: TriangleAlert, tone: 'amber' },
  critical: { icon: OctagonAlert, tone: 'red' },
};

const KNOWN_CHANNELS = [
  'gmail',
  'line',
  'portal',
  'discord',
  'webhook',
  'internal',
  'phone',
  'walk_in',
  'chat',
  'other',
] as const;

/** The channel in words when the UI knows it, the raw name when it does not (a new channel type). */
function channelName(t: Translate, channel: string): string {
  const known = KNOWN_CHANNELS.find((candidate) => candidate === channel);
  return known ? t(`channel.${known}`) : channel;
}

/** "45s", "3m", "2h 10m": seconds are shown while the wait is under a minute. */
export function ageText(seconds: number, locale: Locale): string {
  if (seconds < 60) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'narrow',
    }).format(seconds);
  }
  const parts: string[] = [];
  let rest = Math.floor(seconds / 60);
  for (const [unit, size] of [
    ['day', 1440],
    ['hour', 60],
    ['minute', 1],
  ] as const) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 && parts.length < 2) {
      parts.push(
        new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(count),
      );
    }
  }
  return parts.join(' ');
}

export function OutboxPage() {
  return (
    <RequirePermission permission="outbox.manage" role="head">
      <OutboxBody />
    </RequirePermission>
  );
}

function OutboxBody() {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const health = useOutboxHealth();
  const dead = useDeadOutbox();
  const [target, setTarget] = useState<DeadOutboxItem | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  const refresh = () => {
    void health.refetch();
    void dead.refetch();
  };

  const resend = useMutation({
    mutationFn: (row: DeadOutboxItem) => api.resendOutbox(row.id),
    onSuccess: () => {
      setTarget(null);
      toast(t('outboxAdmin.resent'));
    },
    onError: (error) => {
      setResendError(
        isApiError(error) && error.status === 404
          ? t('outboxAdmin.notFound')
          : describeError(error, t).message,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).outboxHealth });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).outboxDead });
    },
  });

  const rows = dead.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <AdminHeader
        title={t('outboxAdmin.title')}
        breadcrumb={[{ label: t('rail.admin'), href: '/admin' }, { label: t('outboxAdmin.title') }]}
        actions={
          <>
            <HelpHint label={t('outboxAdmin.helpLabel')}>{t('outboxAdmin.help')}</HelpHint>
            <IconButton
              label={t('outboxAdmin.refresh')}
              icon={<RefreshCw aria-hidden className="size-4" />}
              onClick={refresh}
            />
          </>
        }
      />
      <AdminBody>
        <AskAiElement element="admin.outbox" />
        <ElementInsight element="admin.outbox" scope="instance" period="-" className="mx-4 mt-4" />
        <div className="flex flex-col gap-4 p-4">
          <HealthStrip
            health={health.data}
            error={health.isError}
            onRetry={() => void health.refetch()}
          />
          <section aria-labelledby="outbox-dead-title" className="flex flex-col gap-2">
            <h2 id="outbox-dead-title" className="text-sm font-semibold">
              {t('outboxAdmin.dead.title')}
            </h2>

            {dead.isPending ? (
              <TableSkeleton rows={3} />
            ) : dead.isError ? (
              <LoadError onRetry={() => void dead.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState icon={<CircleCheck />} title={t('outboxAdmin.dead.empty')} />
            ) : (
              <>
                <DeadTable
                  rows={rows}
                  onResend={(row) => {
                    setResendError(null);
                    setTarget(row);
                  }}
                />
                {dead.hasNextPage ? (
                  <div>
                    <Button
                      onClick={() => void dead.fetchNextPage()}
                      disabled={dead.isFetchingNextPage}
                    >
                      {t('outboxAdmin.dead.loadMore')}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </AdminBody>
      <ResendDialog
        row={target}
        pending={resend.isPending}
        error={resendError}
        onClose={() => {
          setTarget(null);
        }}
        onConfirm={() => {
          if (target) resend.mutate(target);
        }}
      />
    </>
  );
}

function HealthStrip({
  health,
  error,
  onRetry,
}: {
  health: OutboxHealth | undefined;
  error: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  if (error && !health) return <LoadError onRetry={onRetry} />;
  if (!health) return <TableSkeleton rows={1} />;
  const look = STATUS_LOOK[health.status];
  const waiting = health.pending > 0;
  return (
    <section aria-label={t('outboxAdmin.health.label')} className="flex flex-col gap-2">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border/60 p-3">
          <dt className="text-xs text-muted-foreground">{t('outboxAdmin.health.oldest')}</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">
              {waiting ? ageText(health.oldestPendingSeconds, locale) : '—'}
            </span>
            <TintChip tone={look.tone} icon={look.icon}>
              {t(`outboxAdmin.health.status.${health.status}`)}
            </TintChip>
            <HelpHint label={t('outboxAdmin.helpLabel')}>
              {t('outboxAdmin.health.statusHelp', {
                warning: ageText(health.warningSeconds, locale),
                critical: ageText(health.criticalSeconds, locale),
              })}
            </HelpHint>
          </dd>
          {waiting ? null : (
            <dd className="text-xs text-muted-foreground">{t('outboxAdmin.health.oldestNone')}</dd>
          )}
        </div>
        <div className="rounded-xl border border-border/60 p-3">
          <dt className="text-xs text-muted-foreground">{t('outboxAdmin.health.pending')}</dt>
          <dd className="mt-1 text-lg font-semibold">{health.pending}</dd>
        </div>
        <div className="rounded-xl border border-border/60 p-3">
          <dt className="text-xs text-muted-foreground">{t('outboxAdmin.health.dead')}</dt>
          <dd className="mt-1 text-lg font-semibold">{health.dead}</dd>
        </div>
      </dl>
      {health.byQueue.length > 0 ? (
        <ul aria-label={t('outboxAdmin.health.byQueue')} className="flex flex-wrap gap-2 text-xs">
          {health.byQueue.map((queue) => (
            <li
              key={queue.queue}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-muted-foreground"
            >
              <span className="font-medium text-foreground">{queue.queue}</span> {queue.pending} /{' '}
              {queue.dead}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** What a resend would do, in the words the head reads (and the dialog repeats): never a body. */
function effectText(t: Translate, effect: DeadOutboxEffect, prefix: string) {
  const channel = channelName(t, effect.channel);
  const account = effect.channelAccountName;
  if (effect.kind === 'customer_message') {
    const ticket =
      effect.ticketNumber === null ? '—' : formatTicketKey(effect.ticketNumber, prefix);
    return {
      title: t('outboxAdmin.effect.customer'),
      detail: t('outboxAdmin.effect.customerDetail', { ticket, channel, account }),
      confirm: t('outboxAdmin.confirm.customer', { ticket, channel, account }),
    };
  }
  // A received message that was never processed. On LINE the same job acknowledges the customer.
  return effect.mayAcknowledge
    ? {
        title: t('outboxAdmin.effect.reprocessAck'),
        detail: t('outboxAdmin.effect.reprocessAckDetail', { channel, account }),
        confirm: t('outboxAdmin.confirm.reprocessAck', { channel, account }),
      }
    : {
        title: t('outboxAdmin.effect.reprocess'),
        detail: t('outboxAdmin.effect.reprocessDetail', { channel, account }),
        confirm: t('outboxAdmin.confirm.reprocess', { channel, account }),
      };
}

function DeadTable({
  rows,
  onResend,
}: {
  rows: DeadOutboxItem[];
  onResend: (row: DeadOutboxItem) => void;
}) {
  const { t, locale } = useI18n();
  const { ticketKeyPrefix } = useRuntimeConfig();
  const now = useNow();
  const columns: DataTableColumn<DeadOutboxItem>[] = [
    {
      id: 'when',
      header: t('outboxAdmin.dead.col.when'),
      cell: (row) => {
        const at = row.finishedAt ?? row.createdAt;
        return <time dateTime={at}>{formatRelative(at, now, locale)}</time>;
      },
    },
    {
      id: 'job',
      header: t('outboxAdmin.dead.col.job'),
      cell: (row) => (
        <span className="font-mono text-xs">
          {row.queue} · {row.jobName}
        </span>
      ),
    },
    {
      id: 'effect',
      header: t('outboxAdmin.dead.col.effect'),
      cell: (row) => {
        if (!row.replayable || row.effect === null) {
          return (
            <span className="text-muted-foreground">
              {t('outboxAdmin.dead.notReplayable', { reason: row.notReplayableReason ?? '—' })}
            </span>
          );
        }
        const text = effectText(t, row.effect, ticketKeyPrefix);
        return (
          <span className="flex flex-col gap-0.5">
            {row.effect.kind === 'customer_message' ? (
              <span className="inline-flex items-center gap-1 font-medium">
                <Send aria-hidden className="size-3.5 shrink-0" />
                {text.title}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-medium">
                <RotateCcw aria-hidden className="size-3.5 shrink-0" />
                {text.title}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{text.detail}</span>
          </span>
        );
      },
    },
    { id: 'tries', header: t('outboxAdmin.dead.col.tries'), cell: (row) => row.attempts },
    {
      id: 'error',
      header: t('outboxAdmin.dead.col.error'),
      cell: (row) => (
        <span className="break-words text-xs text-muted-foreground">
          {row.lastError ?? t('outboxAdmin.dead.noError')}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('admin.common.actions'),
      hideHeader: true,
      className: 'w-28 text-right',
      cell: (row) =>
        // Without an `effect` the head cannot be told what a resend does, so there is no button.
        row.replayable && row.effect !== null ? (
          <Button
            aria-label={t('outboxAdmin.dead.resendRow', { job: `${row.queue} · ${row.jobName}` })}
            onClick={() => {
              onResend(row);
            }}
          >
            <RotateCcw aria-hidden className="size-4" />
            {t('outboxAdmin.dead.resend')}
          </Button>
        ) : null,
    },
  ];
  return (
    <DataTable
      caption={t('outboxAdmin.dead.caption')}
      captionHidden
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      getRowLabel={(row) => `${row.queue} · ${row.jobName}`}
    />
  );
}

function ResendDialog({
  row,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  row: DeadOutboxItem | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const { ticketKeyPrefix } = useRuntimeConfig();
  const job = row ? `${row.queue} · ${row.jobName}` : '';
  const text = row?.effect ? effectText(t, row.effect, ticketKeyPrefix).confirm : '';
  return (
    <ConfirmDialog
      // Never confirm a resend whose effect is unknown.
      open={row !== null && row.effect !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('outboxAdmin.confirm.title', { job })}
      description={`${text} ${t('outboxAdmin.confirm.audited')}`}
      confirmLabel={t('outboxAdmin.confirm.action')}
      onConfirm={onConfirm}
      pending={pending}
      error={error}
    />
  );
}
