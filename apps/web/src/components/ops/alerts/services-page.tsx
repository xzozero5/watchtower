'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@watchtower/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { RequirePermission } from '@/components/admin/admin-page';
import {
  HeartbeatsSection,
  PoliciesSection,
  ServicesSection,
} from '@/components/ops/alerts/services-sections';
import { useI18n } from '@/i18n/provider';

const TABS = ['services', 'policies', 'heartbeats'] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab === value);

/**
 * Service catalog, escalation policies and heartbeats (R-3.7, R-3.8, R-3.10). Reading is for anyone
 * who may read alerts; the buttons that change something appear only for the permission that the
 * api checks (`service.manage` for services, `alert.manage` for policies and heartbeats).
 */
export function ServicesPage() {
  return (
    <RequirePermission permission="alert.read" role="lead">
      <ServicesBody />
    </RequirePermission>
  );
}

function ServicesBody() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = isTab(raw) ? raw : 'services';
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        router.replace(`${pathname}?tab=${next}`);
      }}
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4"
    >
      <TabsList aria-label={t('ops.services.tabs')}>
        {TABS.map((value) => (
          <TabsTrigger key={value} value={value}>
            {t(`ops.services.tab.${value}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="services">
        <ElementInsight
          element="alerts.services"
          scope="instance"
          period="-"
          followUp={<AskAiElement element="alerts.services" presentation="follow-up" />}
        />
        <ServicesSection />
      </TabsContent>
      <TabsContent value="policies">
        <PoliciesSection />
      </TabsContent>
      <TabsContent value="heartbeats">
        <HeartbeatsSection />
      </TabsContent>
    </Tabs>
  );
}
