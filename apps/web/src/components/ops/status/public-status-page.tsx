'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { PublicMaintenance, PublicPost } from '@watchtower/shared';
import { Alert, Button, Input, TintChip } from '@watchtower/ui';
import { useId, useState } from 'react';

import NotFoundPage from '@/app/not-found';
import {
  COMPONENT_STATUS_VIEW,
  OVERALL_VIEW,
  StatusComponentChip,
  StatusPhaseChip,
} from '@/components/ops/status/status-bits';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { formatPortalTime, formatWait } from '@/lib/portal/portal-format';
import { classifyStatusError } from '@/lib/status/status-client';
import { useStatusApi } from '@/lib/status/use-status';

const REFRESH_MS = 60_000;

/** A moment with the time zone named: a visitor can be anywhere (PRD section 8.4). */
function PublicTime({ iso }: { iso: string }) {
  const { locale } = useI18n();
  return <time dateTime={iso}>{formatPortalTime(iso, locale)}</time>;
}

/**
 * The public status page (R-6.1). No sign-in, no staff navigation, nothing that is not in the
 * public answer. When the instance has the page switched off the api answers 404 and this renders
 * the same not-found page as any address that does not exist. Words always carry the state; the
 * icon and hue only back them up.
 */
export function PublicStatusPage() {
  const { t } = useI18n();
  const api = useStatusApi();
  const current = useQuery({
    queryKey: ['public-status', 'current'],
    queryFn: ({ signal }) => api.current(signal),
    retry: false,
    refetchInterval: REFRESH_MS,
  });
  const history = useQuery({
    queryKey: ['public-status', 'history'],
    queryFn: ({ signal }) => api.history(signal),
    retry: false,
    enabled: current.isSuccess,
  });

  if (current.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('ops.status.loading')}
      </p>
    );
  }
  if (current.isError) {
    if (classifyStatusError(current.error).kind === 'closed') return <NotFoundPage />;
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="error" title={t('ops.status.loadError')} />
        <div>
          <Button
            onClick={() => {
              void current.refetch();
            }}
          >
            {t('errors.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const status = current.data;
  const overall = OVERALL_VIEW[status.overall];
  return (
    <>
      <section aria-labelledby="status-overall" className="flex flex-col gap-1">
        <h1 id="status-overall" className="sr-only">
          {t('ops.status.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <TintChip tone={overall.tone} icon={overall.icon} strong={status.overall === 'outage'}>
            {t(`ops.status.overall.${status.overall}`)}
          </TintChip>
        </div>
        <p className="text-lg font-semibold">{t(`ops.status.overallLine.${status.overall}`)}</p>
        <p className="text-xs text-muted-foreground">
          {t('ops.status.updatedAt')} <PublicTime iso={status.generatedAt} />
        </p>
      </section>

      <section aria-labelledby="status-components" className="flex flex-col gap-2">
        <h2 id="status-components" className="text-sm font-semibold">
          {t('ops.status.components')}
        </h2>
        {status.components.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.status.noComponents')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {status.components.map((component) => (
              <li
                key={component.slug}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{component.name}</span>
                  {component.description ? (
                    <span className="block text-muted-foreground">{component.description}</span>
                  ) : null}
                </span>
                <StatusComponentChip status={component.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {status.activePosts.length > 0 ? (
        <section aria-labelledby="status-active" className="flex flex-col gap-2">
          <h2 id="status-active" className="text-sm font-semibold">
            {t('ops.status.active')}
          </h2>
          <PostList posts={status.activePosts} />
        </section>
      ) : null}

      {status.ongoingMaintenance.length > 0 || status.upcomingMaintenance.length > 0 ? (
        <section aria-labelledby="status-maintenance" className="flex flex-col gap-2">
          <h2 id="status-maintenance" className="text-sm font-semibold">
            {t('ops.status.maintenance')}
          </h2>
          <MaintenanceList items={status.ongoingMaintenance} ongoing />
          <MaintenanceList items={status.upcomingMaintenance} ongoing={false} />
        </section>
      ) : null}

      <SubscribeForm />

      <section aria-labelledby="status-history" className="flex flex-col gap-2">
        <h2 id="status-history" className="text-sm font-semibold">
          {t('ops.status.history')}
        </h2>
        {history.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('ops.status.loading')}
          </p>
        ) : history.isError ? (
          <Alert tone="error" title={t('ops.status.historyError')} />
        ) : history.data.posts.length === 0 && history.data.maintenance.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('ops.status.noHistory', { days: history.data.days })}
          </p>
        ) : (
          <>
            <PostList posts={history.data.posts} />
            <MaintenanceList items={history.data.maintenance} ongoing={false} past />
          </>
        )}
      </section>
    </>
  );
}

function PostList({ posts }: { posts: readonly PublicPost[] }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-2">
      {posts.map((post) => (
        <li
          key={post.id}
          className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusPhaseChip phase={post.phase} />
            <span className="text-xs text-muted-foreground">
              <PublicTime iso={post.updatedAt} />
            </span>
          </div>
          <p className="font-medium break-words">{post.title}</p>
          <p className="whitespace-pre-wrap break-words">{post.body}</p>
          {post.components.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('ops.status.affects')}:{' '}
              {post.components.map((component) => component.name).join(', ')}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function MaintenanceList({
  items,
  ongoing,
  past = false,
}: {
  items: readonly PublicMaintenance[];
  ongoing: boolean;
  past?: boolean;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  const view = COMPONENT_STATUS_VIEW.under_maintenance;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <TintChip tone={view.tone} icon={view.icon}>
              {past
                ? t('ops.status.maintenancePast')
                : ongoing
                  ? t('ops.status.maintenanceOngoing')
                  : t('ops.status.maintenanceUpcoming')}
            </TintChip>
            <span className="text-xs text-muted-foreground">
              <PublicTime iso={item.startsAt} /> – <PublicTime iso={item.endsAt} />
            </span>
          </div>
          <p className="font-medium break-words">{item.title}</p>
          <p className="whitespace-pre-wrap break-words">{item.body}</p>
          {item.components.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('ops.status.affects')}:{' '}
              {item.components.map((component) => component.name).join(', ')}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Double opt-in (R-6.2): the answer is the same for every address, so the page never says "already subscribed". */
function SubscribeForm() {
  const { t, locale } = useI18n();
  const api = useStatusApi();
  const base = useId();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const subscribe = useMutation({
    mutationFn: () => api.subscribe({ email: email.trim().toLowerCase(), locale }),
    onError: (e) => {
      const failure = classifyStatusError(e);
      if (failure.kind === 'rateLimited') {
        setError(
          t('ops.status.subscribe.rateLimited', {
            wait: formatWait(failure.retryAfterSeconds ?? 60, locale),
          }),
        );
      } else if (failure.kind === 'validation') setError(t('ops.status.subscribe.invalid'));
      else if (failure.kind === 'network') setError(t('ops.status.subscribe.network'));
      else setError(t('ops.status.subscribe.failed'));
    },
  });
  return (
    <section aria-labelledby="status-subscribe" className="flex flex-col gap-2">
      <h2 id="status-subscribe" className="text-sm font-semibold">
        {t('ops.status.subscribe.heading')}
      </h2>
      {subscribe.isSuccess ? (
        <Alert tone="success" title={t('ops.status.subscribe.sent')}>
          {t('ops.status.subscribe.sentBody')}
        </Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
              setError(t('ops.status.subscribe.invalid'));
              return;
            }
            setError(null);
            subscribe.mutate();
          }}
        >
          <FormField
            id={`${base}-email`}
            label={t('ops.status.subscribe.email')}
            hint={t('ops.status.subscribe.hint')}
            {...(error ? { error } : {})}
          >
            <Input
              id={`${base}-email`}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${base}-email-hint${error ? ` ${base}-email-error` : ''}`}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </FormField>
          <div>
            <Button type="submit" variant="primary" disabled={subscribe.isPending}>
              {subscribe.isPending ? t('ops.common.saving') : t('ops.status.subscribe.submit')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
