'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ASSIGNMENT_MODES, type AssignmentMode, type TeamQueue } from '@watchtower/shared';
import {
  Avatar,
  Button,
  Combobox,
  DataTable,
  type DataTableColumn,
  EmptyState,
  HelpHint,
  Input,
  SegmentedControl,
  toast,
} from '@watchtower/ui';
import { ChevronDown, Layers, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { FormField } from '@/components/portal/form-field';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { useUsers } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { usePreferences } from '@/lib/preferences';
import { referenceKeys, useQueues } from '@/lib/tickets/queries';

export function QueuesPage() {
  return (
    <RequirePermission permission="queue.manage" role="lead">
      <QueuesBody />
    </RequirePermission>
  );
}

function QueuesBody() {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const { singleKeyShortcuts } = usePreferences();
  const queues = useQueues(true);
  const [sheet, setSheet] = useState<{ queue: TeamQueue | null } | null>(null);
  const [toDelete, setToDelete] = useState<TeamQueue | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (queue: TeamQueue) => api.deleteQueue(queue.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: referenceKeys(userId).queues });
      setToDelete(null);
      toast(t('admin.common.deleted'));
    },
    onError: (error) => {
      setDeleteError(describeError(error, t).message);
    },
  });

  const columns: DataTableColumn<TeamQueue>[] = [
    {
      id: 'name',
      header: t('admin.common.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <button
          type="button"
          onClick={() => {
            setSheet({ queue: row });
          }}
          className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row.name}
        </button>
      ),
    },
    {
      id: 'mode',
      header: t('admin.queues.assignment'),
      cell: (row) => t(MODE_LABELS[row.assignmentMode]),
    },
    {
      id: 'default',
      header: t('admin.sla.default'),
      cell: (row) => (row.isDefault ? t('admin.common.yes') : '—'),
    },
    {
      id: 'members',
      header: t('admin.queues.members'),
      sortValue: (row) => row.members.length,
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <span className="flex -space-x-1.5" aria-hidden>
            {row.members.slice(0, 4).map((member) => (
              <Avatar
                key={member.userId}
                name={member.name}
                id={member.userId}
                size={20}
                className="ring-2 ring-background"
              />
            ))}
          </span>
          <span className="tabular">{row.members.length}</span>
          <span className="sr-only">{row.members.map((member) => member.name).join(', ')}</span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('admin.common.actions'),
      hideHeader: true,
      className: 'w-10 text-right',
      cell: (row) => (
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('admin.queues.delete', { name: row.name })}
          onClick={() => {
            setDeleteError(null);
            setToDelete(row);
          }}
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      ),
    },
  ];

  return (
    <>
      <AdminHeader
        title={t('admin.sections.queues')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.queues') },
        ]}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setSheet({ queue: null });
            }}
          >
            <Plus aria-hidden className="size-4" />

            {t('admin.queues.new')}
          </Button>
        }
      />
      <AdminBody>
        <AskAiElement element="admin.queues" />
        <ElementInsight element="admin.queues" scope="instance" period="-" className="mx-4 mt-4" />
        {queues.isPending ? (
          <TableSkeleton />
        ) : queues.isError ? (
          <LoadError onRetry={() => void queues.refetch()} />
        ) : queues.data.queues.length === 0 ? (
          <EmptyState icon={<Layers />} title={t('admin.queues.empty')} />
        ) : (
          <DataTable
            caption={t('admin.sections.queues')}
            captionHidden
            columns={columns}
            rows={queues.data.queues}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.name}
            vimKeys={singleKeyShortcuts}
            onRowActivate={(row) => {
              setSheet({ queue: row });
            }}
          />
        )}
      </AdminBody>
      {sheet ? (
        <QueueSheet
          queue={sheet.queue}
          onClose={() => {
            setSheet(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={t('admin.queues.deleteTitle', { name: toDelete?.name ?? '' })}
        description={t('admin.queues.deleteConfirm')}
        confirmLabel={t('admin.common.delete')}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        error={deleteError}
      />
    </>
  );
}

const MODE_LABELS = {
  manual: 'admin.queues.manual',
  round_robin: 'admin.queues.roundRobin',
  load_balanced: 'admin.queues.loadBalanced',
  stay_with_last_handler: 'admin.queues.stayWithLast',
} as const satisfies Record<AssignmentMode, string>;

function QueueSheet({ queue, onClose }: { queue: TeamQueue | null; onClose: () => void }) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const users = useUsers(true);
  const base = useId();
  const [name, setName] = useState(queue?.name ?? '');
  const [mode, setMode] = useState<AssignmentMode>(queue?.assignmentMode ?? 'manual');
  const [isDefault, setIsDefault] = useState(queue?.isDefault ?? false);
  const [members, setMembers] = useState<string[]>(
    queue?.members.map((member) => member.userId) ?? [],
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const staff = useMemo(
    () =>
      (users.data?.users ?? []).filter(
        (user) => user.status === 'active' && ['agent', 'lead', 'head'].includes(user.role),
      ),
    [users.data],
  );

  const dirty =
    queue === null
      ? name !== '' || members.length > 0
      : name !== queue.name ||
        mode !== queue.assignmentMode ||
        isDefault !== queue.isDefault ||
        members.slice().sort().join() !==
          queue.members
            .map((m) => m.userId)
            .sort()
            .join();

  const save = useMutation({
    mutationFn: () =>
      queue === null
        ? api.createQueue({
            name: name.trim(),
            assignmentMode: mode,
            isDefault,
            memberIds: members,
          })
        : api.updateQueue(queue.id, {
            name: name.trim(),
            assignmentMode: mode,
            isDefault,
            memberIds: members,
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: referenceKeys(userId).queues });
      toast(t('admin.common.saved'));
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={queue ? queue.name : t('admin.queues.new')}
      description={t('admin.sections.queues')}
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
          setSummary(null);
          if (name.trim() === '') {
            setNameError(t('admin.common.required'));
            return;
          }
          setNameError(null);
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
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-sm font-medium">
            {t('admin.queues.assignment')}
            <HelpHint label={t('admin.moreInfo', { topic: t('admin.queues.assignment') })}>
              {t('admin.queues.onlyOnShift')}
            </HelpHint>
          </span>
          <SegmentedControl
            aria-label={t('admin.queues.assignment')}
            value={mode}
            onValueChange={setMode}
            options={ASSIGNMENT_MODES.map((value) => ({ value, label: t(MODE_LABELS[value]) }))}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(event) => {
              setIsDefault(event.target.checked);
            }}
            className="size-4"
          />
          {t('admin.queues.isDefault')}
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('admin.queues.members')}</span>
          <Combobox
            multiple
            fieldLabel={t('admin.queues.members')}
            values={members}
            onToggle={(id) => {
              setMembers((current) =>
                current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
              );
            }}
            options={staff.map((user) => ({
              value: user.id,
              label: user.name,
              icon: <Avatar name={user.name} id={user.id} size={20} />,
            }))}
            searchPlaceholder={t('admin.common.search')}
            emptyText={t('admin.common.nothingMatches')}
            listLabel={t('admin.queues.members')}
            selectedText={t('admin.common.selected')}
          >
            <span className="min-w-0 flex-1 truncate">
              {members.length === 0
                ? t('admin.queues.noMembers')
                : staff
                    .filter((user) => members.includes(user.id))
                    .map((user) => user.name)
                    .join(', ')}
            </span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </Combobox>
        </div>
      </form>
    </EntitySheet>
  );
}
