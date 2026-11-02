'use client';

import { cn } from '@watchtower/ui';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { AccessDenied, PageHeader } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import type { MessageKey } from '@/i18n';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { opsSectionsFor } from '@/lib/ops/sections';

/**
 * The operations screens (alerts, services, incidents, status page): a header with the sections
 * this person may open and the page under it as the `main` landmark. The pages lay out their own
 * columns, so the main area is full width. Someone who holds none of the permissions gets the
 * denied page.
 */
export function OpsFrame({ titleKey, children }: { titleKey: MessageKey; children: ReactNode }) {
  const t = useT();
  const { can } = useSession();
  const pathname = usePathname();
  const sections = opsSectionsFor(can);
  if (sections.length === 0) return <AccessDenied role="lead" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t(titleKey)}
        actions={
          <nav aria-label={t('ops.nav.label')}>
            <ul className="flex flex-wrap items-center gap-1">
              {sections.map((section) => {
                const current = pathname === section.href;
                return (
                  <li key={section.id}>
                    <AppLink
                      href={section.href}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'inline-flex h-control items-center rounded-full px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
                        current
                          ? 'bg-nav-active font-medium shadow-card'
                          : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                      )}
                    >
                      {t(section.labelKey)}
                    </AppLink>
                  </li>
                );
              })}
            </ul>
          </nav>
        }
      />
      <main id="main-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
