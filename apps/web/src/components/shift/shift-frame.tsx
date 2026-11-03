'use client';

import { cn } from '@watchtower/ui';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { AccessDenied, PageHeader } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { shiftSectionsFor } from '@/lib/shifts/sections';

/**
 * The shift screens: a header with the sections this person may open (My shift, Daily brief,
 * Handoff, Notes, Lead view) and the page under it as the `main` landmark. Someone who holds none of
 * the permissions gets the denied page.
 */
export function ShiftFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const { can } = useSession();
  const pathname = usePathname();
  const sections = shiftSectionsFor(can);
  if (sections.length === 0) return <AccessDenied role="lead" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('shift.title')}
        actions={
          <nav aria-label={t('shift.nav.label')}>
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
      <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 lg:p-6">{children}</div>
      </main>
    </div>
  );
}
