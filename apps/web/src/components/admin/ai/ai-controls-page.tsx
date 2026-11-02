'use client';

import type { AiSwitch, AiSwitchKey } from '@watchtower/shared';
import {
  AUTONOMY_STAGES,
  Button,
  cn,
  Skeleton,
  StageBadge,
  TINT_CLASSES,
  type TintId,
  TintChip,
} from '@watchtower/ui';
import { CircleCheck, CircleStop, Lock, ShieldCheck, ShieldOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { RelativeTime } from '@/components/relative-time';
import type { MessageKey } from '@/i18n';
import { useT } from '@/i18n/provider';
import { useAutonomy } from '@/lib/admin/queries';
import { canFlipSwitches } from '@/lib/admin/sections';
import { asStage, STAGE_LABEL_KEYS } from '@/lib/admin/stages';
import { useSession } from '@/lib/auth/session';

import { SwitchConfirmDialog, type SwitchTarget } from './switch-confirm-dialog';

const ROWS: readonly {
  key: AiSwitchKey;
  icon: LucideIcon;
  /** The hue of the icon bubble and of the chip while the switch is on. */
  tone: TintId;
  title: MessageKey;
  body: MessageKey;
  turnOn: MessageKey;
  turnOff: MessageKey;
}[] = [
  {
    key: 'ai_stage_cap_pinned',
    icon: ShieldCheck,
    tone: 'teal',
    title: 'admin.ai.capTitle',
    body: 'admin.ai.capBody',
    turnOn: 'admin.ai.turnOn',
    turnOff: 'admin.ai.turnOff',
  },
  {
    key: 'ai_kill_switch',
    icon: CircleStop,
    tone: 'amber',
    title: 'admin.ai.killTitle',
    body: 'admin.ai.killBody',
    turnOn: 'admin.ai.turnOn',
    turnOff: 'admin.ai.turnOff',
  },
];

export function AiControlsPage() {
  return (
    <RequirePermission permission="ai.autonomy.set" role="lead">
      <AiControlsBody />
    </RequirePermission>
  );
}

function AiControlsBody() {
  const t = useT();
  const { can } = useSession();
  const autonomy = useAutonomy(true);
  const [target, setTarget] = useState<SwitchTarget | null>(null);
  const canFlip = canFlipSwitches(can);

  return (
    <>
      <AdminHeader
        title={t('admin.sections.ai')}
        breadcrumb={[{ label: t('rail.admin'), href: '/admin' }, { label: t('admin.sections.ai') }]}
        actions={
          canFlip ? null : (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              {t('admin.ai.headOnly')}
            </span>
          )
        }
      />
      <AdminBody>
        {autonomy.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2 p-4">
            <span className="sr-only">{t('admin.common.loading')}</span>
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : autonomy.isError ? (
          <LoadError message={t('admin.ai.loadError')} onRetry={() => void autonomy.refetch()} />
        ) : (
          <>
            <ul className="flex flex-col gap-3 p-4 pb-2">
              {ROWS.map((row) => (
                <SwitchRow
                  key={row.key}
                  row={row}
                  state={autonomy.data.switches.find((item) => item.key === row.key)}
                  canFlip={canFlip}
                  onFlip={(on) => {
                    setTarget({ switchKey: row.key, on });
                  }}
                />
              ))}
            </ul>
            <StageSummary intents={autonomy.data.intents} />
            <StageLegend />
          </>
        )}
      </AdminBody>
      <SwitchConfirmDialog
        target={target}
        onClose={() => {
          setTarget(null);
        }}
      />
    </>
  );
}

function SwitchRow({
  row,
  state,
  canFlip,
  onFlip,
}: {
  row: (typeof ROWS)[number];
  state: AiSwitch | undefined;
  canFlip: boolean;
  onFlip: (on: boolean) => void;
}) {
  const t = useT();
  const on = state?.on ?? false;
  const Icon = row.icon;
  const titleId = `switch-${row.key}`;
  return (
    <li
      aria-labelledby={titleId}
      data-switch={row.key}
      data-on={on}
      className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-2xl bg-surface px-5 py-4 ring-1 ring-border/60 ring-inset"
    >
      <span
        aria-hidden
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center rounded-full',
          TINT_CLASSES[on ? row.tone : 'slate'].chip,
          TINT_CLASSES[on ? row.tone : 'slate'].icon,
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-sm font-semibold">
          {t(row.title)}
        </h2>
        <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">{t(row.body)}</p>
        {state && state.reason !== '' ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            {state.changedByName ? (
              <span className="text-foreground">{state.changedByName} · </span>
            ) : null}
            <RelativeTime iso={state.changedAt} /> · “{state.reason}”
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <TintChip tone={on ? row.tone : 'slate'} icon={on ? CircleCheck : ShieldOff} strong={on}>
          {on && state ? (
            <>
              {t('admin.ai.on')} · <RelativeTime iso={state.changedAt} className="font-normal" />
            </>
          ) : (
            t('admin.ai.off')
          )}
        </TintChip>
        {canFlip ? (
          <Button
            className="rounded-full"
            onClick={() => {
              onFlip(!on);
            }}
          >
            {on ? t(row.turnOff) : t(row.turnOn)}
            <span className="sr-only"> — {t(row.title)}</span>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function StageLegend() {
  const t = useT();
  const items = [
    'admin.ai.legend0',
    'admin.ai.legend1',
    'admin.ai.legend2',
    'admin.ai.legend3',
  ] as const;
  return (
    <section aria-labelledby="stage-legend" className="px-5 pb-4">
      <h2 id="stage-legend" className="text-sm font-semibold">
        {t('admin.ai.legendTitle')}
      </h2>
      <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
        {items.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </section>
  );
}

function StageSummary({
  intents,
}: {
  intents: readonly { isActive: boolean; effectiveStage: number; pinned: boolean }[];
}) {
  const t = useT();
  const active = intents.filter((intent) => intent.isActive);
  const pinned = active.filter((intent) => intent.pinned).length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <ul aria-label={t('home.ai.stages')} className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {AUTONOMY_STAGES.map((stage) => (
          <li key={stage} className="flex items-center gap-1.5">
            <StageBadge stage={stage} label={t(STAGE_LABEL_KEYS[stage])} />
            <span className="tabular text-sm font-semibold">
              {active.filter((intent) => asStage(intent.effectiveStage) === stage).length}
            </span>
          </li>
        ))}
        {pinned > 0 ? (
          <li className="flex items-center gap-1 text-sm">
            <Lock aria-hidden className="size-3.5 text-muted-foreground" />
            {t('home.ai.pinned', { count: pinned })}
          </li>
        ) : null}
      </ul>
      <AppLink
        href="/admin/intents"
        className="text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {t('home.ai.intents')}
      </AppLink>
    </div>
  );
}
