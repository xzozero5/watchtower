'use client';

import { Alert, HelpHint, TintChip } from '@watchtower/ui';
import { FlaskConical, Lock, Radio } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { ChannelAccountsSection } from '@/components/admin/integrations/channel-accounts-section';
import { GmailConnection } from '@/components/admin/integrations/gmail-connection';
import { IntegrationCard } from '@/components/admin/integrations/integration-card';
import { useT } from '@/i18n/provider';
import { GMAIL_RESULT_KEY, parseGmailOauthResult } from '@/lib/admin/integrations';
import { useIntegrations } from '@/lib/admin/queries';

/**
 * Admin / Integrations (docs/06-UI-SPEC.md section 12, ADR-012), head only. Channel accounts first,
 * then one card per integration. Values are write-only: nothing here can show one.
 * The outbox dead-letter view is not here: its api (T-121a) is not on this branch yet.
 */
export function IntegrationsPage() {
  return (
    <RequirePermission permission="integration.manage" role="head">
      <IntegrationsBody />
    </RequirePermission>
  );
}

function IntegrationsBody() {
  const t = useT();
  const integrations = useIntegrations();

  return (
    <>
      <AdminHeader
        title={t('admin.sections.integrations')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.integrations') },
        ]}
      />
      <AdminBody className="px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {/* The two sentences that used to sit here are one chip each, with the words in a hint. */}
          <div role="note" className="flex flex-wrap items-center gap-2">
            <TintChip tone="slate" icon={Lock}>
              {t('admin.integrations.encrypted')}
            </TintChip>
            <HelpHint label={t('admin.moreInfo', { topic: t('admin.integrations.encrypted') })}>
              {t('admin.integrations.intro')}
            </HelpHint>
            {integrations.data ? (
              <>
                <TintChip
                  tone={integrations.data.testMode === 'mock' ? 'amber' : 'teal'}
                  icon={integrations.data.testMode === 'mock' ? FlaskConical : Radio}
                >
                  {integrations.data.testMode === 'mock'
                    ? t('admin.integrations.demo')
                    : t('admin.integrations.live')}
                </TintChip>
                <HelpHint
                  label={t('admin.moreInfo', {
                    topic:
                      integrations.data.testMode === 'mock'
                        ? t('admin.integrations.demo')
                        : t('admin.integrations.live'),
                  })}
                >
                  {integrations.data.testMode === 'mock'
                    ? t('admin.integrations.testMock')
                    : t('admin.integrations.testLive')}
                </HelpHint>
              </>
            ) : null}
          </div>
          <GmailOauthResultBanner />

          <ChannelAccountsSection />

          <section aria-labelledby="credentials-heading" className="flex flex-col gap-3">
            <div className="flex items-center gap-1">
              <h2 id="credentials-heading" className="text-base font-semibold">
                {t('admin.integrations.credentialsHeading')}
              </h2>
              <HelpHint
                label={t('admin.moreInfo', { topic: t('admin.integrations.credentialsHeading') })}
              >
                {t('admin.integrations.credentialsHint')}
              </HelpHint>
            </div>
            {integrations.isPending ? (
              <TableSkeleton rows={4} />
            ) : integrations.isError ? (
              <LoadError
                message={t('admin.integrations.loadError')}
                onRetry={() => void integrations.refetch()}
              />
            ) : (
              integrations.data.items.map((integration) => (
                <IntegrationCard
                  key={integration.key}
                  integration={integration}
                  testMode={integrations.data.testMode}
                >
                  {integration.key === 'gmail' ? (
                    <GmailConnection integration={integration} />
                  ) : null}
                </IntegrationCard>
              ))
            )}
          </section>
        </div>
      </AdminBody>
    </>
  );
}

/**
 * The page the consent flow sends the browser back to carries `?gmail_oauth=<result>` (nothing sensitive).
 * Shown once, in words; dismissing removes the parameter so a reload does not repeat it.
 */
function GmailOauthResultBanner() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const result = parseGmailOauthResult(params.get('gmail_oauth'));
  if (result === null) return null;
  return (
    <div className="flex flex-col gap-2" aria-label={t('admin.integrations.gmail.resultLabel')}>
      <Alert
        tone={result === 'connected' ? 'success' : 'error'}
        title={t(GMAIL_RESULT_KEY(result))}
      />
      <button
        type="button"
        className="self-start text-sm text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => {
          router.replace('/admin/integrations');
        }}
      >
        {t('admin.integrations.gmail.dismiss')}
      </button>
    </div>
  );
}
