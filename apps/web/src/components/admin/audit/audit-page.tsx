'use client';

import {
  type AuditActorType,
  type AuditLogEntry,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
} from '@watchtower/shared';
import {
  Button,
  Combobox,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Select,
  SegmentedControl,
  Sheet,
  SheetContent,
} from '@watchtower/ui';
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Eye,
  EyeOff,
  Lock,
  ScrollText,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { type AuditFilters, useAuditLogs, useUsers } from '@/lib/admin/queries';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { usePreferences } from '@/lib/preferences';
import { useRuntimeConfig } from '@/lib/runtime-config-context';

const RANGES = [
  { id: '24h', ms: 24 * 3_600_000 },
  { id: '7d', ms: 7 * 24 * 3_600_000 },
  { id: '30d', ms: 30 * 24 * 3_600_000 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];
type OutcomeFilter = 'any' | AuditLogEntry['outcome'];

const ACTION_CODES = Object.values(AUDIT_ACTIONS).sort();

/** "ticket.status_change" read as "Ticket · status change"; the code itself stays beside it. */
export function actionLabel(code: string): string {
  const [head = '', ...rest] = code.split('.');
  const words = rest.join(' · ').replaceAll('_', ' ');
  const title = head.charAt(0).toUpperCase() + head.slice(1).replaceAll('_', ' ');
  return words === '' ? title : `${title} · ${words}`;
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : '—';
}

export function AuditPage() {
  return (
    <RequirePermission permission="audit.read" role="head">
      <AuditBody />
    </RequirePermission>
  );
}

function AuditBody() {
  const { t, locale } = useI18n();
  const { singleKeyShortcuts } = usePreferences();
  const users = useUsers(true);
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('any');
  const [actorType, setActorType] = useState<AuditActorType | ''>('');
  const { can } = useSession();
  const { apiUrl } = useRuntimeConfig();
  const [range, setRange] = useState<{ id: RangeId; from: string }>(() => ({
    id: '24h',
    from: new Date(Date.now() - RANGES[0].ms).toISOString(),
  }));
  const [open, setOpen] = useState<AuditLogEntry | null>(null);

  const filters = useMemo<AuditFilters>(
    () => ({
      from: range.from,
      ...(actorId ? { actorId } : {}),
      ...(actorType ? { actorType } : {}),
      ...(action ? { action } : {}),
      ...(outcome === 'any' ? {} : { outcome }),
    }),
    [range.from, actorId, actorType, action, outcome],
  );
  const log = useAuditLogs(filters);
  // The export takes the filters of the list, without paging. The browser sends the session cookie.
  const exportHref = `${apiUrl}/v1/audit-logs/export?${new URLSearchParams(filters).toString()}`;
  const entries = useMemo(
    () => (log.data?.pages ?? []).flatMap((page) => page.entries),
    [log.data],
  );
  const nameOf = useMemo(
    () => new Map((users.data?.users ?? []).map((user) => [user.id, user.name])),
    [users.data],
  );

  const actorName = (entry: AuditLogEntry): string => {
    if (entry.actorType === 'system') return t('admin.audit.actor.system');
    if (entry.actorType === 'ai') return t('admin.audit.actor.ai');
    if (entry.actorType === 'anonymous') return t('admin.audit.actor.anonymous');
    return (entry.actorId && nameOf.get(entry.actorId)) || shortId(entry.actorId);
  };

  const outcomeView = (value: AuditLogEntry['outcome']) => {
    const Icon = value === 'success' ? CircleCheck : value === 'failure' ? CircleX : Lock;
    return (
      <span className="inline-flex items-center gap-1" data-outcome={value}>
        <Icon aria-hidden className="size-3.5" />
        {t(`admin.audit.outcome.${value}`)}
      </span>
    );
  };

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      id: 'time',
      header: t('admin.audit.col.time'),
      className: 'whitespace-nowrap',
      cell: (row) => <RelativeTime iso={row.createdAt} />,
    },
    { id: 'actor', header: t('admin.audit.col.actor'), cell: (row) => actorName(row) },
    {
      id: 'action',
      header: t('admin.audit.col.action'),
      cell: (row) => (
        <span className="flex flex-col">
          <span>{actionLabel(row.action)}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.action}</span>
        </span>
      ),
    },
    {
      id: 'target',
      header: t('admin.audit.col.target'),
      cell: (row) =>
        row.targetType ? (
          <span className="flex flex-col">
            <span>{row.targetType}</span>
            <span className="font-mono text-xs text-muted-foreground">{shortId(row.targetId)}</span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'outcome',
      header: t('admin.audit.col.outcome'),
      cell: (row) => outcomeView(row.outcome),
    },
  ];

  const actorOptions = [
    { value: '', label: t('admin.audit.anyActor') },
    ...(users.data?.users ?? []).map((user) => ({ value: user.id, label: user.name })),
  ];
  const actionOptions = [
    { value: '', label: t('admin.audit.anyAction') },
    ...ACTION_CODES.map((code) => ({ value: code, label: code, keywords: [actionLabel(code)] })),
  ];

  return (
    <>
      <AdminHeader
        title={t('admin.sections.audit')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.audit') },
        ]}
        actions={
          <>
            <span className="text-xs text-muted-foreground">{t('admin.audit.readNote')}</span>
            {can('pii.export') ? (
              <Button asChild>
                <a href={exportHref} download>
                  <Download aria-hidden className="size-4" />
                  {t('admin.audit.export')}
                </a>
              </Button>
            ) : null}
          </>
        }
      />
      <AdminBody>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
          <div className="w-44">
            <Combobox
              fieldLabel={t('admin.audit.col.actor')}
              value={actorId}
              onValueChange={setActorId}
              options={actorOptions}
              searchPlaceholder={t('admin.common.search')}
              emptyText={t('admin.common.nothingMatches')}
              listLabel={t('admin.audit.col.actor')}
              selectedText={t('admin.common.selected')}
            >
              <span className="min-w-0 flex-1 truncate">
                {actorOptions.find((option) => option.value === actorId)?.label}
              </span>
              <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Combobox>
          </div>
          <div className="w-52">
            <Combobox
              fieldLabel={t('admin.audit.col.action')}
              value={action}
              onValueChange={setAction}
              options={actionOptions}
              searchPlaceholder={t('admin.common.search')}
              emptyText={t('admin.common.nothingMatches')}
              listLabel={t('admin.audit.col.action')}
              selectedText={t('admin.common.selected')}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {actionOptions.find((option) => option.value === action)?.label}
              </span>
              <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Combobox>
          </div>
          <Select
            aria-label={t('admin.audit.actorType')}
            value={actorType}
            onChange={(event) => {
              setActorType(event.target.value as AuditActorType | '');
            }}
          >
            <option value="">{t('admin.audit.anyType')}</option>
            {AUDIT_ACTOR_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`admin.audit.type.${value}`)}
              </option>
            ))}
          </Select>
          <SegmentedControl
            aria-label={t('admin.audit.col.outcome')}
            value={outcome}
            onValueChange={setOutcome}
            options={[
              { value: 'any', label: t('admin.audit.outcome.any') },
              { value: 'success', label: t('admin.audit.outcome.success') },
              { value: 'failure', label: t('admin.audit.outcome.failure') },
              { value: 'denied', label: t('admin.audit.outcome.denied') },
            ]}
          />
          <Select
            aria-label={t('admin.audit.range')}
            value={range.id}
            onChange={(event) => {
              const next = RANGES.find((item) => item.id === event.target.value) ?? RANGES[0];
              setRange({ id: next.id, from: new Date(Date.now() - next.ms).toISOString() });
            }}
          >
            {RANGES.map((item) => (
              <option key={item.id} value={item.id}>
                {t(`admin.audit.ranges.${item.id}`)}
              </option>
            ))}
          </Select>
        </div>

        {log.isPending ? (
          <TableSkeleton />
        ) : log.isError ? (
          <LoadError onRetry={() => void log.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState icon={<ScrollText />} title={t('admin.audit.empty')} />
        ) : (
          <>
            <DataTable
              caption={t('admin.sections.audit')}
              captionHidden
              columns={columns}
              rows={entries}
              getRowId={(row) => row.id}
              getRowLabel={(row) =>
                `${actionLabel(row.action)}, ${formatDateTime(row.createdAt, locale)}`
              }
              vimKeys={singleKeyShortcuts}
              selectedId={open?.id ?? null}
              onRowActivate={setOpen}
            />
            {log.hasNextPage ? (
              <div className="p-3">
                <Button onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                  {log.isFetchingNextPage ? t('admin.common.loading') : t('admin.audit.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </AdminBody>
      <AuditDetailSheet
        entry={open}
        actor={open ? actorName(open) : ''}
        onClose={() => {
          setOpen(null);
        }}
      />
    </>
  );
}

function diffRows(
  before: unknown,
  after: unknown,
): { field: string; before: string; after: string }[] {
  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const b = asRecord(before);
  const a = asRecord(after);
  const show = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value));
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((key) => JSON.stringify(b[key]) !== JSON.stringify(a[key]))
    .map((field) => ({ field, before: show(b[field]), after: show(a[field]) }));
}

/** Every field of one entry. Values that can hold personal data stay hidden until "Show". */
function AuditDetailSheet({
  entry,
  actor,
  onClose,
}: {
  entry: AuditLogEntry | null;
  actor: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [revealed, setRevealed] = useState(false);
  return (
    <Sheet
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) {
          setRevealed(false);
          onClose();
        }
      }}
    >
      {entry ? (
        <SheetContent
          title={actionLabel(entry.action)}
          description={formatDateTime(entry.createdAt, locale)}
          closeLabel={t('admin.common.close')}
        >
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
            <Field label={t('admin.audit.col.actor')}>{actor}</Field>
            <Field label={t('admin.audit.col.action')}>
              <span className="font-mono text-xs">{entry.action}</span>
            </Field>
            <Field label={t('admin.audit.col.target')}>
              {entry.targetType ?? '—'}{' '}
              <span className="font-mono text-xs text-muted-foreground">
                {entry.targetId ?? ''}
              </span>
            </Field>
            <Field label={t('admin.audit.col.outcome')}>
              {t(`admin.audit.outcome.${entry.outcome}`)}
            </Field>
            <Field label={t('admin.audit.requestId')}>
              <span className="font-mono text-xs break-all">{entry.requestId ?? '—'}</span>
            </Field>
            <Field label={t('admin.audit.id')}>
              <span className="inline-flex items-center gap-1">
                <span className="font-mono text-xs break-all">{entry.id}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('admin.audit.copyId')}
                  onClick={() => void navigator.clipboard.writeText(entry.id)}
                >
                  <Copy aria-hidden className="size-3.5" />
                </Button>
              </span>
            </Field>
            <Field label={t('admin.audit.ip')}>
              <span className="font-mono text-xs">{revealed ? (entry.ip ?? '—') : '••••••'}</span>
            </Field>
          </dl>
          <div className="mt-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('admin.audit.changes')}</h3>
            <Button
              size="sm"
              aria-pressed={revealed}
              onClick={() => {
                setRevealed((value) => !value);
              }}
            >
              {revealed ? (
                <EyeOff aria-hidden className="size-3.5" />
              ) : (
                <Eye aria-hidden className="size-3.5" />
              )}
              {revealed ? t('admin.audit.hide') : t('admin.audit.show')}
            </Button>
          </div>
          {revealed ? (
            <ChangesTable entry={entry} />
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">••••••</p>
          )}
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function ChangesTable({ entry }: { entry: AuditLogEntry }) {
  const { t } = useI18n();
  const rows = diffRows(entry.before, entry.after);
  const metadata = Object.entries(entry.metadata);
  if (rows.length === 0 && metadata.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">{t('admin.audit.noChanges')}</p>;
  }
  return (
    <div className="mt-2 flex flex-col gap-3">
      {rows.length > 0 ? (
        <table className="w-full text-xs">
          <caption className="sr-only">{t('admin.audit.changes')}</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">
                {t('admin.audit.field')}
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                {t('admin.audit.before')}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t('admin.audit.after')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field} className="border-t border-border align-top">
                <td className="py-1 pr-2 font-mono">{row.field}</td>
                <td className="py-1 pr-2 font-mono break-all">{row.before}</td>
                <td className="py-1 font-mono break-all">{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {metadata.length > 0 ? (
        <pre className="overflow-x-auto rounded-md bg-surface-muted p-2 font-mono text-xs">
          {JSON.stringify(entry.metadata, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
