'use client';

import { EmptyState } from '@watchtower/ui';
import { Plug } from 'lucide-react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { RequirePermission } from '@/components/admin/admin-page';
import { useT } from '@/i18n/provider';

/** Placeholder: the integration cards (docs/06-UI-SPEC.md section 12) arrive with T-116. */
export function IntegrationsPage() {
  return (
    <RequirePermission permission="integration.manage" role="head">
      <IntegrationsBody />
    </RequirePermission>
  );
}

function IntegrationsBody() {
  const t = useT();
  return (
    <>
      <AdminHeader
        title={t('admin.sections.integrations')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.integrations') },
        ]}
      />
      <AdminBody>
        <EmptyState
          icon={<Plug />}
          title={t('admin.integrations.title')}
          description={t('admin.integrations.body')}
          hint={<code className="font-mono">docs/06-UI-SPEC.md §12</code>}
        />
      </AdminBody>
    </>
  );
}
