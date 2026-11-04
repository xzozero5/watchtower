'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Intent, TICKET_PRIORITIES, type TicketPriority } from '@watchtower/shared';
import {
  Button,
  EmptyState,
  Pill,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Input,
  toast,
} from '@watchtower/ui';
import { SearchX } from 'lucide-react';
import { useId, useState } from 'react';

import { AdminBody, AdminHeader } from '@/components/admin/admin-layout';
import { LoadError, RequirePermission, TableSkeleton } from '@/components/admin/admin-page';
import { FormField } from '@/components/portal/form-field';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useAutonomy, useIntentHistory, useSlaPolicies } from '@/lib/admin/queries';
import { asStage, STAGE_LABEL_KEYS } from '@/lib/admin/stages';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { referenceKeys, useIntents } from '@/lib/tickets/queries';

import { isFullIntent } from './intents-page';
import { IntentAutonomyControl } from './intent-autonomy-control';
import { ProcedureTab } from './procedure/procedure-tab';
import { Stage3Tab } from './stage3/stage3-tab';

export function IntentDetailPage({ intentId }: { intentId: string }) {
  return (
    <RequirePermission permission="intent.manage" role="lead">
      <IntentDetailBody intentId={intentId} />
    </RequirePermission>
  );
}

function IntentDetailBody({ intentId }: { intentId: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const intents = useIntents(true);
  const autonomy = useAutonomy(true);
  const intent = (intents.data?.intents ?? []).filter(isFullIntent).find((i) => i.id === intentId);
  const state = autonomy.data?.intents.find((i) => i.id === intentId);
  const capOn = autonomy.data?.switches.find((s) => s.key === 'ai_stage_cap_pinned')?.on ?? false;
  const canHistory = can('ai.autonomy.set');
  const history = useIntentHistory(intentId, canHistory);

  // After a fresh sign-in the owner comes back to `?tab=stage3&approve=<id>`: open that tab and that dialog.
  // Read from the address on the client (not `useSearchParams`, which would need a Suspense boundary).
  // This body only renders after the session loaded in the browser, so reading the address here is safe.
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).get('tab') === 'stage3' ? 'stage3' : 'details',
  );
  const [approveId, setApproveId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('approve'),
  );

  const pinEntry = history.data?.items.find((entry) => entry.change === 'pin');
  const pinnedBy =
    state?.pinned && pinEntry
      ? { name: pinEntry.changedByName ?? null, at: pinEntry.changedAt }
      : null;

  return (
    <>
      <AdminHeader
        title={intent?.name ?? t('admin.sections.intents')}
        breadcrumb={[
          { label: t('rail.admin'), href: '/admin' },
          { label: t('admin.sections.intents'), href: '/admin/intents' },
          { label: intent?.name ?? '…' },
        ]}
      />
      <AdminBody>
        {intents.isPending ? (
          <TableSkeleton rows={3} />
        ) : intents.isError ? (
          <LoadError onRetry={() => void intents.refetch()} />
        ) : !intent ? (
          <EmptyState icon={<SearchX />} title={t('admin.intents.notFound')} />
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="flex flex-col">
            <TabsList className="border-b border-border px-4 pt-1.5 pb-2">
              <TabsTrigger value="details">{t('admin.intents.tabs.details')}</TabsTrigger>
              <TabsTrigger value="autonomy">{t('admin.intents.tabs.autonomy')}</TabsTrigger>
              <TabsTrigger value="stage3">{t('stage3.tab')}</TabsTrigger>
              {can('procedure.read') ? (
                <TabsTrigger value="procedure">{t('procedure.tab')}</TabsTrigger>
              ) : null}
              <TabsTrigger value="history">{t('admin.intents.tabs.history')}</TabsTrigger>
            </TabsList>
            <TabsContent value="details" className="p-4">
              <IntentDetailsForm intent={intent} />
            </TabsContent>
            <TabsContent value="autonomy" className="p-4">
              {autonomy.isPending ? (
                <Skeleton className="h-24 max-w-xl" />
              ) : autonomy.isError || !state ? (
                <LoadError
                  message={t('admin.ai.loadError')}
                  onRetry={() => void autonomy.refetch()}
                />
              ) : (
                <IntentAutonomyControl
                  intent={state}
                  capOn={capOn}
                  canChange={can('ai.autonomy.set')}
                  canPin={can('ai.autonomy.set.any')}
                  pinnedBy={pinnedBy}
                />
              )}
            </TabsContent>
            <TabsContent value="stage3" className="p-4">
              {autonomy.isPending ? (
                <Skeleton className="h-24 max-w-xl" />
              ) : autonomy.isError || !state ? (
                <LoadError
                  message={t('admin.ai.loadError')}
                  onRetry={() => void autonomy.refetch()}
                />
              ) : (
                <Stage3Tab
                  intent={state}
                  autosendFlag={autonomy.data.autosendFlag}
                  approveId={approveId}
                  onApproveHandled={() => {
                    setApproveId(null);
                    window.history.replaceState(null, '', window.location.pathname);
                  }}
                />
              )}
            </TabsContent>
            {can('procedure.read') ? (
              <TabsContent value="procedure" className="p-4">
                <ProcedureTab intentId={intentId} />
              </TabsContent>
            ) : null}
            <TabsContent value="history" className="p-4">
              {!canHistory || history.isError ? (
                <p className="text-sm text-muted-foreground">
                  {t('admin.intents.historyHeadOnly')}
                </p>
              ) : history.isPending ? (
                <Skeleton className="h-24 max-w-xl" />
              ) : history.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('admin.intents.historyEmpty')}</p>
              ) : (
                <ul className="max-w-2xl divide-y divide-border">
                  {history.data.items.map((entry) => {
                    const from = asStage(entry.fromStage);
                    const to = asStage(entry.toStage);
                    return (
                      <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <span className="font-medium">
                            {entry.change === 'stage'
                              ? `${t(STAGE_LABEL_KEYS[from])} → ${t(STAGE_LABEL_KEYS[to])}`
                              : entry.change === 'pin'
                                ? t('admin.intents.pinned')
                                : t('admin.intents.unpinApply')}
                          </span>
                          <span className="text-muted-foreground">
                            {entry.changedByName ?? ''} <RelativeTime iso={entry.changedAt} />
                          </span>
                        </div>
                        <p className="text-muted-foreground">“{entry.reason}”</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        )}
      </AdminBody>
    </>
  );
}

function IntentDetailsForm({ intent }: { intent: Intent }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const policies = useSlaPolicies(true);
  const base = useId();
  const [name, setName] = useState(intent.name);
  const [description, setDescription] = useState(intent.description);
  const [evidence, setEvidence] = useState(intent.typicalEvidence);
  const [priority, setPriority] = useState<TicketPriority>(intent.defaultPriority);
  const [policyId, setPolicyId] = useState(intent.slaPolicyId ?? '');
  const [isActive, setIsActive] = useState(intent.isActive);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.updateIntent(intent.id, {
        name: name.trim(),
        description,
        typicalEvidence: evidence,
        defaultPriority: priority,
        slaPolicyId: policyId === '' ? null : policyId,
        isActive,
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: referenceKeys(userId).intents });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
      toast(t('admin.common.saved'));
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      className="flex max-w-xl flex-col gap-3"
    >
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t('admin.form.notSaved')} {error}
        </p>
      ) : null}
      <FormField id={`${base}-name`} label={t('admin.common.name')}>
        <Input
          id={`${base}-name`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </FormField>
      <FormField id={`${base}-description`} label={t('admin.intents.description')}>
        <Textarea
          id={`${base}-description`}
          rows={3}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </FormField>
      <FormField id={`${base}-evidence`} label={t('admin.intents.evidence')}>
        <Textarea
          id={`${base}-evidence`}
          rows={3}
          value={evidence}
          onChange={(event) => {
            setEvidence(event.target.value);
          }}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id={`${base}-priority`} label={t('admin.intents.col.priority')}>
          <Select
            id={`${base}-priority`}
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as TicketPriority);
            }}
          >
            {TICKET_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value} · {t(`severity.${value.toLowerCase() as 'p1' | 'p2' | 'p3' | 'p4'}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id={`${base}-sla`} label={t('admin.intents.col.sla')}>
          <Select
            id={`${base}-sla`}
            value={policyId}
            onChange={(event) => {
              setPolicyId(event.target.value);
            }}
          >
            <option value="">{t('admin.orgs.tierDefault')}</option>
            {(policies.data?.policies ?? []).map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(event) => {
            setIsActive(event.target.checked);
          }}
          className="size-4"
        />
        {t('admin.common.active')}
      </label>
      {intent.allowedTools.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('admin.intents.tools')}</span>
          <ul className="flex flex-wrap gap-1.5">
            {intent.allowedTools.map((tool) => (
              <li key={tool}>
                <Pill className="font-mono">{tool}</Pill>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <Button variant="primary" type="submit" disabled={save.isPending || name.trim() === ''}>
          {save.isPending ? t('admin.form.saving') : t('admin.common.save')}
        </Button>
      </div>
    </form>
  );
}
