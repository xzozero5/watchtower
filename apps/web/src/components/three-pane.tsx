'use client';

import { cn, EmptyState, SEVERITY_IDS, SeverityBadge } from '@watchtower/ui';
import { Inbox, MessageSquareText, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

import { useT } from '@/i18n/provider';

function Pane({
  id,
  title,
  className,
  children,
  footer,
}: {
  id: string;
  title: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        'flex min-h-64 min-w-0 flex-col rounded-lg border border-border bg-surface lg:min-h-0',
        className,
      )}
    >
      <h2
        id={headingId}
        className="border-b border-border px-pane py-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h2>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      {footer}
    </section>
  );
}

function SeverityKey() {
  const t = useT();
  return (
    <details className="border-t border-border px-pane py-3 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        {t('severity.keyTitle')}
      </summary>
      <p className="mt-2 text-muted-foreground">{t('severity.keyHint')}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {SEVERITY_IDS.map((id) => (
          <li key={id}>
            <SeverityBadge severity={id} label={t(`severity.${id}`)} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Queue | conversation | AI assistant. Three columns from the `lg` breakpoint; below it the panes
 * stack in reading order (queue, conversation, assistant) and the page scrolls. All three are empty
 * for now: T-006 fills them with real data.
 */
export function ThreePane() {
  const t = useT();
  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-stack p-stack lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)_minmax(15rem,24rem)]">
      <Pane id="pane-queue" title={t('panes.queue.title')} footer={<SeverityKey />}>
        <EmptyState
          icon={<Inbox className="size-8" />}
          title={t('panes.queue.emptyTitle')}
          description={t('panes.queue.emptyBody')}
        />
      </Pane>
      <Pane id="pane-conversation" title={t('panes.conversation.title')}>
        <EmptyState
          className="flex-1"
          icon={<MessageSquareText className="size-8" />}
          title={t('panes.conversation.emptyTitle')}
          description={t('panes.conversation.emptyBody')}
        />
      </Pane>
      <Pane id="pane-assistant" title={t('panes.assistant.title')}>
        <EmptyState
          icon={<Sparkles className="size-8" />}
          title={t('panes.assistant.emptyTitle')}
          description={t('panes.assistant.emptyBody')}
        />
      </Pane>
    </main>
  );
}
