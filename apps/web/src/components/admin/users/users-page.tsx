'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { emailSchema, type Role, type User } from '@watchtower/shared';
import {
  Avatar,
  Button,
  Combobox,
  DataTable,
  type DataTableColumn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Select,
  StatusDot,
  toast,
} from '@watchtower/ui';
import { ChevronDown, Lock, MoreHorizontal, Plus, Users } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';

import {
  AdminBody,
  AdminHeader,
  FilterField,
  useAdminListKeys,
} from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { FormField } from '@/components/portal/form-field';
import { RelativeTime } from '@/components/relative-time';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useUsers } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { SSO_PROVIDER } from '@/lib/auth/providers';
import { useSession, useUserId } from '@/lib/auth/session';
import { usePreferences } from '@/lib/preferences';

const EDITABLE_ROLES = ['agent', 'lead', 'head'] as const satisfies readonly Role[];
type EditableRole = (typeof EDITABLE_ROLES)[number];

type Pending =
  | { kind: 'promote'; user: User }
  | { kind: 'disable'; user: User }
  | { kind: 'signout'; user: User };

export function UsersPage() {
  return (
    <RequirePermission permission="user.read" role="lead">
      <UsersBody />
    </RequirePermission>
  );
}

function UsersBody() {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const { can, session } = useSession();
  const { singleKeyShortcuts } = usePreferences();
  const users = useUsers(true);
  const canManage = can('user.manage');
  const canSignOut = can('session.revoke.any');
  const [filter, setFilter] = useState('');
  const [inviting, setInviting] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  useAdminListKeys({
    focusFilter: () => filterRef.current?.focus(),
    ...(canManage
      ? {
          startNew: () => {
            setInviting(true);
          },
        }
      : {}),
  });

  const rows = useMemo(
    () =>
      (users.data?.users ?? [])
        .filter((user) => user.role !== 'client' && user.role !== 'system')
        .filter((user) =>
          `${user.name} ${user.email}`.toLowerCase().includes(filter.trim().toLowerCase()),
        ),
    [users.data, filter],
  );

  const refreshUsers = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).users });
  };

  const update = useMutation({
    mutationFn: ({
      user,
      ...body
    }: {
      user: User;
      role?: EditableRole;
      status?: 'active' | 'disabled';
    }) => api.updateUser(user.id, body),
    onSuccess: (updated) => {
      refreshUsers();
      setPending(null);
      setActionError(null);
      toast(t('admin.common.saved'));
      return updated;
    },
    onError: (error) => {
      setActionError(describeError(error, t).message);
    },
  });
  const signOut = useMutation({
    mutationFn: (user: User) => api.forceLogout(user.id),
    onSuccess: () => {
      setPending(null);
      setActionError(null);
      toast(t('admin.users.signedOut'));
    },
    onError: (error) => {
      setActionError(describeError(error, t).message);
    },
  });

  const columns: DataTableColumn<User>[] = [
    {
      id: 'name',
      header: t('admin.common.name'),
      sortValue: (row) => row.name,
      cell: (row) => (
        <span className="flex items-center gap-2">
          <Avatar name={row.name} id={row.id} size={24} />
          <span className="font-medium">{row.name}</span>
        </span>
      ),
    },
    {
      id: 'email',
      header: t('admin.users.email'),
      sortValue: (row) => row.email,
      cell: (row) => row.email,
    },
    {
      id: 'role',
      header: t('admin.users.role'),
      sortValue: (row) => row.role,
      cell: (row) => {
        const editable =
          canManage && !row.isBreakGlass && row.id !== session?.user.id && row.status === 'active';
        if (!editable) return t(`roles.${row.role}`);
        return (
          <Combobox
            fieldLabel={t('admin.users.role')}
            value={row.role}
            onValueChange={(value) => {
              if (value === row.role) return;
              if (value === 'head') setPending({ kind: 'promote', user: row });
              else update.mutate({ user: row, role: value as EditableRole });
            }}
            options={EDITABLE_ROLES.map((role) => ({ value: role, label: t(`roles.${role}`) }))}
            searchPlaceholder={t('admin.common.search')}
            emptyText={t('admin.common.nothingMatches')}
            listLabel={t('admin.users.role')}
            selectedText={t('admin.common.selected')}
          >
            <span>{t(`roles.${row.role}`)}</span>
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </Combobox>
        );
      },
    },
    {
      id: 'status',
      header: t('admin.common.status'),
      sortValue: (row) => row.status,
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5" data-status={row.status}>
          <StatusDot tone={row.status === 'active' ? 'success' : 'outline'} />
          {row.status === 'active' ? t('admin.common.active') : t('admin.users.disabled')}
        </span>
      ),
    },
    {
      id: 'last',
      header: t('admin.users.lastSignIn'),
      sortValue: (row) => (row.lastLoginAt ? Date.parse(row.lastLoginAt) : null),
      cell: (row) =>
        row.lastLoginAt ? (
          <RelativeTime iso={row.lastLoginAt} />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'actions',
      header: t('admin.common.actions'),
      hideHeader: true,
      className: 'w-10 text-right',
      cell: (row) => {
        if (row.isBreakGlass) {
          return (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              {t('admin.users.breakGlass')}
            </span>
          );
        }
        if (row.id === session?.user.id) {
          return (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              {t('admin.users.selfLocked')}
            </span>
          );
        }
        if (!canManage && !canSignOut) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('admin.users.actionsFor', { name: row.name })}
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canManage ? (
                row.status === 'active' ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setActionError(null);
                      setPending({ kind: 'disable', user: row });
                    }}
                  >
                    {t('admin.users.disable')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={() => {
                      update.mutate({ user: row, status: 'active' });
                    }}
                  >
                    {t('admin.users.enable')}
                  </DropdownMenuItem>
                )
              ) : null}
              {canSignOut ? (
                <DropdownMenuItem
                  onSelect={() => {
                    setActionError(null);
                    setPending({ kind: 'signout', user: row });
                  }}
                >
                  {t('admin.users.signOutAll')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const confirm = pending
    ? pending.kind === 'promote'
      ? {
          title: t('admin.users.promoteTitle', { name: pending.user.name }),
          description: t('admin.users.promoteHead', { name: pending.user.name }),
          label: t('admin.users.promote'),
          run: () => {
            update.mutate({ user: pending.user, role: 'head' });
          },
        }
      : pending.kind === 'disable'
        ? {
            title: t('admin.users.disableTitle', { name: pending.user.name }),
            description: t('admin.users.disableConfirm'),
            label: t('admin.users.disable'),
            run: () => {
              update.mutate({ user: pending.user, status: 'disabled' });
            },
          }
        : {
            title: t('admin.users.signOutTitle', { name: pending.user.name }),
            description: t('admin.users.signOutConfirm'),
            label: t('admin.users.signOutAll'),
            run: () => {
              signOut.mutate(pending.user);
            },
          }
    : null;

  return (
    <>
      <AdminHeader
        title={t('admin.sections.users')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.users') },
        ]}
        actions={
          <>
            <FilterField
              value={filter}
              onChange={setFilter}
              label={t('admin.common.filter')}
              inputRef={filterRef}
            />
            {canManage ? (
              <Button
                variant="primary"
                onClick={() => {
                  setInviting(true);
                }}
              >
                <Plus aria-hidden className="size-4" />
                {t('admin.users.invite')}
              </Button>
            ) : null}
          </>
        }
      />
      <AdminBody>
        {users.isPending ? (
          <TableSkeleton />
        ) : users.isError ? (
          <LoadError onRetry={() => void users.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={filter ? t('admin.common.nothingMatches') : t('admin.users.empty')}
          />
        ) : (
          <DataTable
            caption={t('admin.sections.users')}
            captionHidden
            columns={columns}
            rows={rows}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.name}
            vimKeys={singleKeyShortcuts}
          />
        )}
      </AdminBody>
      <InviteSheet
        open={inviting}
        onClose={() => {
          setInviting(false);
        }}
        onDone={refreshUsers}
      />
      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.label}
          onConfirm={confirm.run}
          pending={update.isPending || signOut.isPending}
          error={actionError}
        />
      ) : null}
    </>
  );
}

function InviteSheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const api = useApi();
  const base = useId();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<EditableRole>('agent');
  const [errors, setErrors] = useState<{ email?: string; name?: string }>({});
  const [summary, setSummary] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createUser({ email: email.trim(), name: name.trim(), role }),
    onSuccess: () => {
      onDone();
      toast(t('admin.users.invited'));
      reset();
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  function reset() {
    setEmail('');
    setName('');
    setRole('agent');
    setErrors({});
    setSummary(null);
  }

  const submit = () => {
    const next: { email?: string; name?: string } = {};
    if (!emailSchema.safeParse(email).success) next.email = t('admin.users.emailInvalid');
    if (name.trim() === '') next.name = t('admin.common.required');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) create.mutate();
  };

  return (
    <EntitySheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('admin.users.invite')}
      description={t('admin.users.inviteHint', { provider: SSO_PROVIDER.displayName })}
      dirty={email !== '' || name !== ''}
      pending={create.isPending}
      formId={`${base}-form`}
      submitLabel={t('admin.users.invite')}
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
          id={`${base}-email`}
          label={t('admin.users.email')}
          {...(errors.email ? { error: errors.email } : {})}
        >
          <Input
            id={`${base}-email`}
            type="email"
            autoComplete="off"
            value={email}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${base}-email-error` : undefined}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </FormField>
        <FormField
          id={`${base}-name`}
          label={t('admin.common.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </FormField>
        <FormField id={`${base}-role`} label={t('admin.users.role')}>
          <Select
            id={`${base}-role`}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as EditableRole);
            }}
          >
            {EDITABLE_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`roles.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
      </form>
    </EntitySheet>
  );
}
