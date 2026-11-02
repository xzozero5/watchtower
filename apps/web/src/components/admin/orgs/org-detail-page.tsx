'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Contact } from '@watchtower/shared';
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  IconButton,
  Pill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@watchtower/ui';
import { CircleCheck, Layers, Link2, Pencil, Plus, SearchX, Trash2, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { AppLink } from '@/components/app-link';
import { OrgHealthCard } from '@/components/ops/org-health-card';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useContacts, useOrg, useOrgTiers, useSlaPolicies } from '@/lib/admin/queries';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { queueHref } from '@/lib/tickets/filters';

import { ContactSheet } from './contact-sheet';
import { OrgSheet } from './org-sheet';
import { TiersSheet } from './tiers-sheet';

/** What each way of linking a LINE account means for staff (T-103, PRD R-2.11). */
const LINE_VIA_COPY = {
  staff_code: 'admin.contacts.lineViaStaffCode',
  line_login: 'admin.contacts.lineViaLogin',
  email_code: 'admin.contacts.lineViaEmail',
  none: 'admin.contacts.lineViaNone',
} as const;

export function OrgDetailPage({ orgId }: { orgId: string }) {
  return (
    <RequirePermission permission="org.manage" role="lead">
      <OrgDetailBody orgId={orgId} />
    </RequirePermission>
  );
}

function OrgDetailBody({ orgId }: { orgId: string }) {
  const t = useT();
  const api = useApi();
  const router = useRouter();
  const userId = useUserId();
  const { can } = useSession();
  // The Client Health Score is for lead and up (org.health.read); everyone else never sees the tab.
  const canSeeHealth = can('org.health.read');
  const queryClient = useQueryClient();
  const org = useOrg(orgId);
  const contacts = useContacts(orgId);
  const policies = useSlaPolicies(true);
  // Adding, renaming and deleting tiers is the head's (`sla.manage`, the same as SLA policies).
  const canManageTiers = can('sla.manage');
  const tiers = useOrgTiers();
  const [managingTiers, setManagingTiers] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [contactSheet, setContactSheet] = useState<{ contact: Contact | null } | null>(null);
  const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);

  const remove = useMutation({
    mutationFn: () => api.deleteOrg(orgId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).orgs });
      toast(t('admin.common.deleted'));
      router.push('/admin/orgs');
    },
    onError: (error) => {
      setDeleteError(describeError(error, t).message);
    },
  });
  const removeContact = useMutation({
    mutationFn: (contact: Contact) => api.deleteContact(contact.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).contacts(orgId) });
      setContactToDelete(null);
      toast(t('admin.common.deleted'));
    },
    onError: (error) => {
      setDeleteError(describeError(error, t).message);
    },
  });

  const data = org.data;
  const notFound = org.isError && isApiError(org.error) && org.error.status === 404;

  const contactColumns: DataTableColumn<Contact>[] = [
    {
      id: 'name',
      header: t('admin.common.name'),
      sortValue: (row) => row.name,
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { id: 'emails', header: t('admin.users.email'), cell: (row) => row.emails.join(', ') },
    {
      id: 'line',
      header: 'LINE',
      cell: (row) =>
        row.lineUserId ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Link2 aria-hidden className="size-3.5" />
            {t('admin.contacts.linked')}
            {/* A staff-issued code links the account but does not verify it: staff must be able to tell. */}
            <Pill
              className={row.lineVerified ? undefined : 'text-muted-foreground'}
              title={t(LINE_VIA_COPY[row.lineLinkedVia ?? 'none'])}
            >
              {row.lineVerified ? <CircleCheck aria-hidden className="size-3" /> : null}
              {t(
                row.lineVerified
                  ? 'admin.contacts.lineVerifiedChip'
                  : 'admin.contacts.lineUnverifiedChip',
              )}
            </Pill>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'verified',
      header: t('admin.contacts.verified'),
      cell: (row) =>
        row.verifiedAt ? (
          <Pill>
            <CircleCheck aria-hidden className="size-3" />
            {t('admin.contacts.verifiedChip')}
          </Pill>
        ) : (
          <Pill className="text-muted-foreground">{t('admin.contacts.unverifiedChip')}</Pill>
        ),
    },
    { id: 'role', header: t('admin.contacts.role'), cell: (row) => row.roleInOrg ?? '—' },
    {
      id: 'actions',
      header: t('admin.common.actions'),
      hideHeader: true,
      className: 'w-24 text-right',
      cell: (row) => (
        <span className="inline-flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('admin.contacts.edit', { name: row.name })}
            onClick={() => {
              setContactSheet({ contact: row });
            }}
          >
            <Pencil aria-hidden className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('admin.contacts.delete', { name: row.name })}
            onClick={() => {
              setDeleteError(null);
              setContactToDelete(row);
            }}
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <AdminHeader
        title={data?.name ?? t('admin.sections.orgs')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.orgs'), href: '/admin/orgs' },
          { label: data?.name ?? '…' },
        ]}
        actions={
          data ? (
            <>
              <Button
                onClick={() => {
                  setEditing(true);
                }}
              >
                <Pencil aria-hidden className="size-4" />
                {t('admin.common.edit')}
              </Button>
              <Button
                onClick={() => {
                  setDeleteError(null);
                  setDeleting(true);
                }}
              >
                {t('admin.orgs.delete')}
              </Button>
            </>
          ) : null
        }
      />
      <AdminBody>
        {org.isPending ? (
          <TableSkeleton rows={3} />
        ) : notFound ? (
          <EmptyState icon={<SearchX />} title={t('admin.orgs.notFound')} />
        ) : org.isError || !data ? (
          <LoadError onRetry={() => void org.refetch()} />
        ) : (
          <Tabs defaultValue="details" className="flex flex-col">
            <TabsList className="border-b border-border px-4 pt-1.5 pb-2">
              <TabsTrigger value="details">{t('admin.orgs.tabs.details')}</TabsTrigger>
              <TabsTrigger value="contacts">{t('admin.orgs.tabs.contacts')}</TabsTrigger>
              <TabsTrigger value="tickets">{t('admin.orgs.tabs.tickets')}</TabsTrigger>
              {canSeeHealth ? (
                <TabsTrigger value="health">{t('ops.health.tab')}</TabsTrigger>
              ) : null}
            </TabsList>
            <TabsContent value="details" className="p-4">
              <dl className="grid max-w-xl grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('admin.orgs.tier')}</dt>
                <dd className="flex items-center gap-1.5">
                  <span>
                    {tiers.data?.tiers.find((item) => item.slug === data.tier)?.name ?? data.tier}
                  </span>
                  {canManageTiers ? (
                    <IconButton
                      label={t('admin.orgs.tiers.manage')}
                      icon={<Layers aria-hidden className="size-4" />}
                      onClick={() => {
                        setManagingTiers(true);
                      }}
                    />
                  ) : null}
                </dd>
                <dt className="text-muted-foreground">{t('admin.common.status')}</dt>
                <dd>
                  {data.status === 'active' ? t('admin.common.active') : t('admin.common.inactive')}
                </dd>
                <dt className="text-muted-foreground">{t('admin.orgs.slaPolicy')}</dt>
                <dd>
                  {data.slaPolicyId
                    ? (policies.data?.policies.find((policy) => policy.id === data.slaPolicyId)
                        ?.name ?? '—')
                    : t('admin.orgs.tierDefault')}
                </dd>
                <dt className="text-muted-foreground">{t('admin.orgs.domains')}</dt>
                <dd>{data.domains.length > 0 ? data.domains.join(', ') : '—'}</dd>
                {data.notes ? (
                  <>
                    <dt className="text-muted-foreground">{t('admin.orgs.notes')}</dt>
                    <dd className="whitespace-pre-wrap">{data.notes}</dd>
                  </>
                ) : null}
              </dl>
            </TabsContent>
            <TabsContent value="contacts">
              <div className="flex justify-end px-4 py-2">
                <Button
                  onClick={() => {
                    setContactSheet({ contact: null });
                  }}
                >
                  <Plus aria-hidden className="size-4" />
                  {t('admin.contacts.new')}
                </Button>
              </div>
              {contacts.isPending ? (
                <TableSkeleton />
              ) : contacts.isError ? (
                <LoadError onRetry={() => void contacts.refetch()} />
              ) : contacts.data.items.length === 0 ? (
                <EmptyState icon={<Users />} title={t('admin.contacts.empty')} />
              ) : (
                <DataTable
                  caption={t('admin.orgs.tabs.contacts')}
                  captionHidden
                  columns={contactColumns}
                  rows={contacts.data.items}
                  getRowId={(row) => row.id}
                  getRowLabel={(row) => row.name}
                />
              )}
            </TabsContent>
            <TabsContent value="tickets" className="p-4">
              <AppLink
                href={queueHref({})}
                className="text-sm font-medium underline-offset-2 hover:underline"
              >
                {t('admin.orgs.openTickets')}
              </AppLink>
            </TabsContent>
            {canSeeHealth ? (
              <TabsContent value="health" className="p-4">
                <OrgHealthCard orgId={orgId} />
              </TabsContent>
            ) : null}
          </Tabs>
        )}
      </AdminBody>
      {managingTiers ? (
        <TiersSheet
          open
          onClose={() => {
            setManagingTiers(false);
          }}
        />
      ) : null}
      {editing && data ? (
        <OrgSheet
          open
          org={data}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}
      {contactSheet ? (
        <ContactSheet
          open
          orgId={orgId}
          contact={contactSheet.contact}
          onClose={() => {
            setContactSheet(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('admin.orgs.deleteTitle', { name: data?.name ?? '' })}
        description={t('admin.orgs.deleteConfirm')}
        confirmLabel={t('admin.orgs.delete')}
        onConfirm={() => {
          remove.mutate();
        }}
        pending={remove.isPending}
        error={deleteError}
      />
      <ConfirmDialog
        open={contactToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setContactToDelete(null);
        }}
        title={t('admin.contacts.deleteTitle', { name: contactToDelete?.name ?? '' })}
        description={t('admin.contacts.deleteConfirm')}
        confirmLabel={t('admin.common.delete')}
        onConfirm={() => {
          if (contactToDelete) removeContact.mutate(contactToDelete);
        }}
        pending={removeContact.isPending}
        error={deleteError}
      />
    </>
  );
}
