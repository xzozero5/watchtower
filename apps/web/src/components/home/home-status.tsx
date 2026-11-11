'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import type { UseQueryResult } from '@tanstack/react-query';
import type { AutonomyState } from '@watchtower/shared';
import { AUTONOMY_STAGES, Skeleton, StageBadge } from '@watchtower/ui';
import {
  CircleCheck,
  CircleStop,
  CircleX,
  Lock,
  Minus,
  ShieldCheck,
  ShieldOff,
  Sparkles,
} from 'lucide-react';

import { LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { useT } from '@/i18n/provider';
import type { ReadinessView } from '@/lib/admin/contracts';
import { asStage, STAGE_LABEL_KEYS } from '@/lib/admin/stages';
import { useSession } from '@/lib/auth/session';

/**
 * The AI at a glance: are the two switches on, how many intents sit at each stage, and two quiet
 * slots for "Draft ready" and "Needs you" that fill in when the AI insight endpoint exists
 * (docs/design/ai-first-workspace.md section 6). Until then they show a dash, never a made-up number.
 */
export function AiStatus({ query }: { query: UseQueryResult<AutonomyState> }) {
  const t = useT();
  const { can } = useSession();
  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">{t('loading.label')}</span>
        <div aria-hidden className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div aria-hidden className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          {[0, 1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <Skeleton variant="pill" className="h-5 w-20" />
              <Skeleton className="h-4 w-5" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <LoadError
        message={t('home.ai.error')}
        onRetry={() => void query.refetch()}
        className="px-0"
      />
    );
  }
  const { switches, intents } = query.data;
  const killOn = switches.find((item) => item.key === 'ai_kill_switch')?.on ?? false;
  const capOn = switches.find((item) => item.key === 'ai_stage_cap_pinned')?.on ?? false;
  const active = intents.filter((intent) => intent.isActive);
  const pinned = active.filter((intent) => intent.pinned).length;
  const perStage = AUTONOMY_STAGES.map((stage) => ({
    stage,
    n: active.filter((intent) => asStage(intent.effectiveStage) === stage).length,
  }));

  return (
    <div className="flex flex-col gap-3">
      <ElementInsight
        element="home.status"
        period="-"
        followUp={<AskAiElement presentation="follow-up" element="home.status" />}
      />
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">{t('home.ai.runs')}</dt>
          <dd
            className="inline-flex items-center gap-1 font-medium"
            data-state={killOn ? 'stopped' : 'on'}
          >
            {killOn ? (
              <CircleStop aria-hidden className="size-4 text-link" />
            ) : (
              <CircleCheck aria-hidden className="size-4 text-success" />
            )}
            {killOn ? t('home.ai.stopped') : t('home.ai.on')}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">{t('home.ai.limit')}</dt>
          <dd
            className="inline-flex items-center gap-1 font-medium"
            data-state={capOn ? 'on' : 'off'}
          >
            {capOn ? (
              <ShieldCheck aria-hidden className="size-4 text-link" />
            ) : (
              <ShieldOff aria-hidden className="size-4 text-muted-foreground" />
            )}
            {capOn ? t('home.ai.limitOn') : t('home.ai.limitOff')}
          </dd>
        </div>
        <div
          className="flex items-center gap-1.5 text-muted-foreground"
          title={t('home.unavailable')}
        >
          <dt>{t('home.ai.draftReady')}</dt>
          <dd className="font-medium">—</dd>
        </div>
        <div
          className="flex items-center gap-1.5 text-muted-foreground"
          title={t('home.unavailable')}
        >
          <dt>{t('home.ai.needsYou')}</dt>
          <dd className="font-medium">—</dd>
        </div>
      </dl>
      <ul aria-label={t('home.ai.stages')} className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {perStage.map(({ stage, n }) => (
          <li key={stage} className="flex items-center gap-1.5">
            <StageBadge stage={stage} label={t(STAGE_LABEL_KEYS[stage])} />
            <span className="tabular text-sm font-semibold">{n}</span>
          </li>
        ))}
        {pinned > 0 ? (
          <li className="flex items-center gap-1 text-sm">
            <Lock aria-hidden className="size-3.5 text-muted-foreground" />
            <span>{t('home.ai.pinned', { count: pinned })}</span>
          </li>
        ) : null}
      </ul>
      <div className="flex flex-wrap gap-4 text-sm font-medium">
        {can('intent.manage') ? (
          <AppLink href="/admin/intents" className="underline-offset-2 hover:underline">
            {t('home.ai.intents')}
          </AppLink>
        ) : null}
        {can('ai.autonomy.set') ? (
          <AppLink href="/admin/ai" className="underline-offset-2 hover:underline">
            {t('home.ai.controls')}
          </AppLink>
        ) : null}
      </div>
    </div>
  );
}

/** Readiness of Postgres and Redis; the rows that have no data source yet say so and are never green. */
export function SystemHealth({ query }: { query: UseQueryResult<ReadinessView> }) {
  const t = useT();
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      <li className="flex items-center gap-2">
        {query.isPending ? (
          <Skeleton className="h-5 w-56" />
        ) : query.isError ? (
          <>
            <CircleX aria-hidden className="size-4 shrink-0 text-danger" />
            <span data-health="down">{t('home.health.notReady')}</span>
          </>
        ) : (
          <>
            <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
            <span data-health="ready">{t('home.health.ready')}</span>
          </>
        )}
      </li>
      {(['outbox', 'integrations'] as const).map((row) => (
        <li key={row} className="flex items-center gap-2 text-muted-foreground">
          <Minus aria-hidden className="size-4 shrink-0" />
          <span>
            {t(row === 'outbox' ? 'home.health.outboxLabel' : 'home.health.integrationsLabel')}
            {': '}
            {t('home.health.unavailable')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BotMark() {
  return <Sparkles className="size-4.5" />;
}
