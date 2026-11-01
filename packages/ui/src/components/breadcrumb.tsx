import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page (the last item). */
  href?: string;
}

export interface BreadcrumbProps {
  items: readonly BreadcrumbItem[];
  /** Translated name of the landmark, for example "Breadcrumb". */
  label: string;
  /** Renders a link, so the app can use its router. Defaults to a plain anchor. */
  renderLink?: (item: BreadcrumbItem & { href: string }, className: string) => ReactNode;
  className?: string;
}

const LINK =
  'rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * Where the page sits: `Admin / Organizations / Acme Logistics`. Every item but the last is a link;
 * the last one is plain text marked `aria-current="page"`. The chevrons are decoration.
 */
export function Breadcrumb({ items, label, renderLink, className }: BreadcrumbProps) {
  return (
    <nav aria-label={label} className={className}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${String(index)}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              {last || item.href === undefined ? (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={cn(
                    'truncate',
                    last ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {item.label}
                </span>
              ) : renderLink ? (
                renderLink({ ...item, href: item.href }, LINK)
              ) : (
                <a href={item.href} className={LINK}>
                  {item.label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
