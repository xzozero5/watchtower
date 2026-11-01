'use client';

import { type BreadcrumbItem, cn, Combobox, Input } from '@watchtower/ui';
import { ChevronDown, Search } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, type Ref } from 'react';

import { AppLink } from '@/components/app-link';
import { AccessDenied, PageHeader } from '@/components/admin/admin-page';
import { useT } from '@/i18n/provider';
import { type AdminSection, adminSectionsFor } from '@/lib/admin/sections';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';

function isCurrent(section: AdminSection, pathname: string): boolean {
  return pathname === section.href || pathname.startsWith(`${section.href}/`);
}

/**
 * Admin: the section list (plain text links, hairline on its right) next to the page. Only the
 * sections this person may open are listed; someone with none gets the denied page.
 */
export function AdminLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const { can } = useSession();
  const pathname = usePathname();
  const sections = adminSectionsFor(can);
  if (sections.length === 0) return <AccessDenied role="lead" />;
  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label={t('admin.sectionsLabel')}
        className="hidden w-[220px] shrink-0 border-r border-border px-2 py-3 md:block"
      >
        <ul className="flex flex-col gap-0.5">
          {sections.map((section) => {
            const current = isCurrent(section, pathname);
            return (
              <li key={section.id}>
                <AppLink
                  href={section.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'flex h-control items-center rounded-md px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
                    current
                      ? 'bg-primary-subtle font-medium text-foreground'
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** Below 768px the section list is a picker in the page header. */
function SectionPicker() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useSession();
  const sections = adminSectionsFor(can);
  const current = sections.find((section) => isCurrent(section, pathname));
  return (
    <Combobox
      fieldLabel={t('admin.section')}
      value={current?.id ?? ''}
      onValueChange={(id) => {
        const next = sections.find((section) => section.id === id);
        if (next) router.push(next.href);
      }}
      options={sections.map((section) => ({ value: section.id, label: t(section.labelKey) }))}
      searchPlaceholder={t('admin.common.search')}
      emptyText={t('admin.common.nothingMatches')}
      listLabel={t('admin.sectionsLabel')}
      selectedText={t('admin.common.selected')}
      className="w-auto"
    >
      <span className="font-medium">{current ? t(current.labelKey) : t('admin.section')}</span>
      <ChevronDown aria-hidden className="size-4 text-muted-foreground" />
    </Combobox>
  );
}

/** The 48px header of an admin page: breadcrumb, actions, and the section picker on a phone. */
export function AdminHeader({
  title,
  breadcrumb,
  actions,
}: {
  title: string;
  breadcrumb: readonly BreadcrumbItem[];
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      title={title}
      breadcrumb={breadcrumb}
      actions={actions}
      sectionPicker={<SectionPicker />}
    />
  );
}

/** The page body under the header: scrolls on its own and is the `main` landmark. */
export function AdminBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main id="main-content" className={cn('min-h-0 flex-1 overflow-y-auto', className)}>
      {children}
    </main>
  );
}

/**
 * The filter box above a list. `/` focuses it (not the queue search), and a label stays for screen
 * readers only.
 */
export function FilterField({
  value,
  onChange,
  label,
  inputRef,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}) {
  return (
    <div className={cn('relative w-full max-w-xs', className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full pl-8"
      />
    </div>
  );
}

/** `/` moves focus to the page filter and `N` starts "New…" (single keys: the preference applies). */
export function useAdminListKeys({
  focusFilter,
  startNew,
}: {
  focusFilter: () => void;
  startNew?: () => void;
}) {
  useShortcut('/', focusFilter);
  useShortcut('n', startNew ?? (() => undefined), startNew !== undefined);
}
