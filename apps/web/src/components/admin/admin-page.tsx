'use client';

import type { Permission } from '@watchtower/shared';
import { Breadcrumb, type BreadcrumbItem, Button, EmptyState, Skeleton } from '@watchtower/ui';
import { Lock, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { AppLink } from '@/components/app-link';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';

/** Breadcrumb that renders its links through the app router. */
export function PageBreadcrumb({ items }: { items: readonly BreadcrumbItem[] }) {
  const t = useT();
  return (
    <Breadcrumb
      label={t('admin.breadcrumb')}
      items={items}
      renderLink={(item, className) => (
        <AppLink href={item.href} className={className}>
          {item.label}
        </AppLink>
      )}
    />
  );
}

/**
 * The header every console page has: where you are on the left (a breadcrumb or a plain title), the
 * page's actions on the right. Soft Beacon: a light 26px title on the Canvas, no hairline (Overview
 * has its own 34px head). Normal case, no UPPERCASE.
 */
export function PageHeader({
  title,
  breadcrumb,
  actions,
  sectionPicker,
}: {
  /** Used as the `h1`. With a breadcrumb it is read by screen readers and hidden on screen. */
  title: string;
  breadcrumb?: readonly BreadcrumbItem[];
  actions?: ReactNode;
  /** Below 768px the admin section list becomes this picker. */
  sectionPicker?: ReactNode;
}) {
  return (
    <div className="flex min-h-[56px] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-2 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        {breadcrumb ? (
          <>
            <h1 className="sr-only">{title}</h1>
            <PageBreadcrumb items={breadcrumb} />
          </>
        ) : (
          <h1 className="text-[1.7333rem] leading-tight font-light text-foreground-strong">
            {title}
          </h1>
        )}
        {sectionPicker ? <div className="md:hidden">{sectionPicker}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** "You don't have access to this page. It needs the {role} role." with a way back (UI spec section 13). */
export function AccessDenied({ role }: { role: 'agent' | 'lead' | 'head' }) {
  const t = useT();
  return (
    <main id="main-content" className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<Lock />}
        tone="amber"
        title={t('states.denied.title')}
        description={t('states.denied.body', { role: t(`roles.${role}`) })}
        action={
          <Button asChild>
            <AppLink href="/">{t('states.denied.back')}</AppLink>
          </Button>
        }
      />
    </main>
  );
}

/** Renders `children` only for someone who holds the permission; others get the denied page. */
export function RequirePermission({
  permission,
  role,
  children,
}: {
  permission: Permission;
  role: 'lead' | 'head';
  children: ReactNode;
}) {
  const { can } = useSession();
  return can(permission) ? <>{children}</> : <AccessDenied role={role} />;
}

/** Table-shaped placeholder: five rows, announced as loading after a moment. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  const t = useT();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-1.5 p-4">
      <span className="sr-only">{t('admin.common.loading')}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8" />
      ))}
    </div>
  );
}

/** An inline failure with a retry; the rest of the page keeps working. */
export function LoadError({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2 px-4 py-3 text-sm ${className ?? ''}`}
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span>{message ?? t('admin.common.loadError')}</span>
      <Button size="sm" onClick={onRetry}>
        {t('errors.retry')}
      </Button>
    </div>
  );
}
