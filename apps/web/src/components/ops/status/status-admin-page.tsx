'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@watchtower/ui';
import { ExternalLink } from 'lucide-react';

import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import { OpsSkeleton } from '@/components/ops/ops-bits';
import { StatusComponentsSection } from '@/components/ops/status/status-components';
import { StatusMaintenanceSection } from '@/components/ops/status/status-maintenance';
import { StatusPostsSection } from '@/components/ops/status/status-posts';
import { IntroHint } from '@/components/intro-hint';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useStatusSubscribers } from '@/lib/ops/queries';

/**
 * Staff side of the public status page (R-6.1 to R-6.3): components, posts, maintenance windows and
 * a count of subscribers. Nothing here is public until a person with `incident.manage` publishes it,
 * and the public page itself is closed unless the instance switches it on.
 */
export function StatusAdminPage() {
  return (
    <RequirePermission permission="ticket.read" role="lead">
      <StatusAdminBody />
    </RequirePermission>
  );
}

function StatusAdminBody() {
  const { t } = useI18n();
  const { can } = useSession();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <AskAiElement element="statuspage.admin" />
      <ElementInsight element="statuspage.admin" scope="instance" period="-" />
      <p className="text-sm text-muted-foreground">
        {t('ops.statusAdmin.intro')}{' '}
        <a
          href="/status"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t('ops.statusAdmin.openPublic')}
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      </p>
      <Tabs defaultValue="posts" className="flex flex-col gap-4">
        <TabsList aria-label={t('ops.statusAdmin.tabs.label')} className="flex-wrap">
          <TabsTrigger value="posts">{t('ops.statusAdmin.tabs.posts')}</TabsTrigger>
          <TabsTrigger value="maintenance">{t('ops.statusAdmin.tabs.maintenance')}</TabsTrigger>
          <TabsTrigger value="components">{t('ops.statusAdmin.tabs.components')}</TabsTrigger>
          {can('incident.manage') ? (
            <TabsTrigger value="subscribers">{t('ops.statusAdmin.tabs.subscribers')}</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="posts">
          <StatusPostsSection />
        </TabsContent>
        <TabsContent value="maintenance">
          <StatusMaintenanceSection />
        </TabsContent>
        <TabsContent value="components">
          <StatusComponentsSection />
        </TabsContent>
        {can('incident.manage') ? (
          <TabsContent value="subscribers">
            <SubscribersSection />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

/** Counts only: the addresses are never listed in the app (N1). */
function SubscribersSection() {
  const { t } = useI18n();
  const summary = useStatusSubscribers(true);
  return (
    <section aria-label={t('ops.statusAdmin.subscribers.title')} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{t('ops.statusAdmin.subscribers.title')}</h2>

      <IntroHint topic={t('ops.statusAdmin.subscribers.title')}>
        {t('ops.statusAdmin.subscribers.intro')}
      </IntroHint>
      {summary.isPending ? (
        <OpsSkeleton rows={1} />
      ) : summary.isError ? (
        <LoadError onRetry={() => void summary.refetch()} />
      ) : (
        <dl className="grid grid-cols-3 gap-3">
          {(['confirmed', 'pending', 'unsubscribed'] as const).map((key) => (
            <div key={key} className="rounded-inner bg-surface px-3.5 py-2.5 shadow-card">
              <dt className="text-xs text-muted-foreground">
                {t(`ops.statusAdmin.subscribers.${key}`)}
              </dt>
              <dd className="tabular text-xl font-semibold">{summary.data[key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
