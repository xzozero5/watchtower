'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ALERT_SOURCES,
  ESCALATION_TARGETS,
  type AlertSource,
  type EscalationPolicy,
  type EscalationStep,
  type Heartbeat,
  type Service,
  type ServiceMatchRule,
} from '@watchtower/shared';
import { Button, EmptyState, Input, Select, TintChip, toast } from '@watchtower/ui';
import { Heart, HeartCrack, Layers, Plus, Route } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { LoadError } from '@/components/admin/admin-page';
import { Moment, OpsSkeleton } from '@/components/ops/ops-bits';
import { FormField } from '@/components/portal/form-field';
import { IntroHint } from '@/components/intro-hint';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import {
  describeOpsError,
  describeRule,
  ESCALATION_TARGET_LABELS,
  labelsToLines,
  parseLabelLines,
  secondsToMinutes,
} from '@/lib/ops/model';
import { opsKeys, useEscalationPolicies, useHeartbeats, useServices } from '@/lib/ops/queries';

/** The row of a catalog list: the facts on the left, Edit and Delete on the right. */
function Row({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      <div className="flex items-center gap-1.5">{actions}</div>
    </li>
  );
}

function SectionBar({
  title,
  onAdd,
  addLabel,
}: {
  title: string;
  onAdd: (() => void) | null;
  addLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {onAdd ? (
        <Button onClick={onAdd}>
          <Plus aria-hidden className="size-4" />
          {addLabel}
        </Button>
      ) : null}
    </div>
  );
}

function useDelete(remove: () => Promise<unknown>, key: readonly unknown[], onDone: () => void) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: remove,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      toast(t('ops.common.deleted'));
      onDone();
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  return {
    mutation,
    error,
    reset: () => {
      setError(null);
    },
  };
}

// --- services ------------------------------------------------------------------------------------

export function ServicesSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const list = useServices();
  const policies = useEscalationPolicies();
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const manage = can('service.manage');
  return (
    <section aria-label={t('ops.services.title')} className="flex flex-col gap-2">
      <SectionBar
        title={t('ops.services.title')}
        addLabel={t('ops.services.add')}
        onAdd={
          manage
            ? () => {
                setEditing('new');
              }
            : null
        }
      />
      <IntroHint topic={t('ops.services.title')}>{t('ops.services.intro')}</IntroHint>
      {list.isPending ? (
        <OpsSkeleton rows={3} />
      ) : list.isError ? (
        <LoadError onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Layers />} title={t('ops.services.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.data.items.map((service) => (
            <Row
              key={service.id}
              actions={
                manage ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(service);
                      }}
                    >
                      {t('ops.common.edit')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setDeleting(service);
                      }}
                    >
                      {t('ops.common.delete')}
                    </Button>
                  </>
                ) : null
              }
            >
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{service.name}</span>
                <code className="text-xs text-muted-foreground">{service.slug}</code>
                {service.active ? null : (
                  <TintChip tone="slate">{t('ops.common.inactive')}</TintChip>
                )}
              </p>
              <p className="text-muted-foreground">
                {t('ops.services.policy')}:{' '}
                {policies.data?.items.find((p) => p.id === service.escalationPolicyId)?.name ??
                  t('ops.services.defaultPolicy')}
              </p>
              {service.matchRules.length === 0 ? (
                <p className="text-muted-foreground">{t('ops.services.noRules')}</p>
              ) : (
                <ul className="text-xs text-muted-foreground">
                  {service.matchRules.map((rule, index) => (
                    <li key={index}>{describeRule(rule)}</li>
                  ))}
                </ul>
              )}
            </Row>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <ServiceSheet
          key={editing === 'new' ? 'new' : editing.id}
          service={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteService
          service={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DeleteService({ service, onClose }: { service: Service; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { mutation, error } = useDelete(
    () => api.deleteService(service.id),
    opsKeys(userId).all,
    onClose,
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('ops.services.deleteTitle', { name: service.name })}
      description={t('ops.services.deleteBody')}
      confirmLabel={t('ops.common.delete')}
      onConfirm={() => {
        mutation.mutate();
      }}
      pending={mutation.isPending}
      error={error}
    />
  );
}

interface RuleDraft {
  source: AlertSource | '';
  policyName: string;
  labels: string;
}

const draftOfRule = (rule: ServiceMatchRule): RuleDraft => ({
  source: rule.source ?? '',
  policyName: rule.policyName ?? '',
  labels: labelsToLines(rule.labels),
});

function ServiceSheet({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const policies = useEscalationPolicies();
  const [slug, setSlug] = useState(service?.slug ?? '');
  const [name, setName] = useState(service?.name ?? '');
  const [policyId, setPolicyId] = useState(service?.escalationPolicyId ?? '');
  const [runbook, setRunbook] = useState(service?.runbookUrl ?? '');
  const [dashboard, setDashboard] = useState(service?.dashboardUrl ?? '');
  const [repos, setRepos] = useState((service?.repos ?? []).join('\n'));
  const [rules, setRules] = useState<RuleDraft[]>((service?.matchRules ?? []).map(draftOfRule));
  const [active, setActive] = useState(service?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => {
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof build>) =>
      service === null ? api.createService(body) : api.updateService(service.id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).services });
      toast(t('ops.common.saved'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const build = () => ({
    slug: slug.trim(),
    name: name.trim(),
    escalationPolicyId: policyId === '' ? null : policyId,
    runbookUrl: runbook.trim() === '' ? null : runbook.trim(),
    dashboardUrl: dashboard.trim() === '' ? null : dashboard.trim(),
    repos: repos
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    matchRules: rules.map((rule) => ({
      ...(rule.source === '' ? {} : { source: rule.source }),
      ...(rule.policyName.trim() === '' ? {} : { policyName: rule.policyName.trim() }),
      labels: parseLabelLines(rule.labels) ?? {},
    })),
    active,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim()) || slug.trim().length < 2) {
      next.slug = t('ops.services.slugInvalid');
    }
    if (name.trim() === '') next.name = t('ops.common.required');
    for (const url of [
      ['runbook', runbook],
      ['dashboard', dashboard],
    ] as const) {
      if (url[1].trim() !== '' && !/^https?:\/\//i.test(url[1].trim()))
        next[url[0]] = t('ops.common.urlInvalid');
    }
    rules.forEach((rule, index) => {
      if (parseLabelLines(rule.labels) === null)
        next[`rule${String(index)}`] = t('ops.services.labelsInvalid');
    });
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate(build());
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={service ? service.name : t('ops.services.add')}
      description={t('ops.services.sheetDescription')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-name`}
          label={t('ops.common.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField
          id={`${base}-slug`}
          label={t('ops.services.slug')}
          hint={t('ops.services.slugHint')}
          {...(errors.slug ? { error: errors.slug } : {})}
        >
          <Input
            id={`${base}-slug`}
            value={slug}
            aria-invalid={errors.slug ? true : undefined}
            aria-describedby={`${base}-slug-hint${errors.slug ? ` ${base}-slug-error` : ''}`}
            onChange={(e) => {
              setSlug(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField id={`${base}-policy`} label={t('ops.services.policy')}>
          <Select
            id={`${base}-policy`}
            value={policyId}
            onChange={(e) => {
              setPolicyId(e.target.value);
              touch();
            }}
          >
            <option value="">{t('ops.services.defaultPolicy')}</option>
            {(policies.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          id={`${base}-runbook`}
          label={t('ops.services.runbook')}
          optionalLabel={t('ops.common.optional')}
          {...(errors.runbook ? { error: errors.runbook } : {})}
        >
          <Input
            id={`${base}-runbook`}
            type="url"
            inputMode="url"
            value={runbook}
            aria-invalid={errors.runbook ? true : undefined}
            aria-describedby={errors.runbook ? `${base}-runbook-error` : undefined}
            onChange={(e) => {
              setRunbook(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField
          id={`${base}-dashboard`}
          label={t('ops.services.dashboard')}
          optionalLabel={t('ops.common.optional')}
          {...(errors.dashboard ? { error: errors.dashboard } : {})}
        >
          <Input
            id={`${base}-dashboard`}
            type="url"
            inputMode="url"
            value={dashboard}
            aria-invalid={errors.dashboard ? true : undefined}
            aria-describedby={errors.dashboard ? `${base}-dashboard-error` : undefined}
            onChange={(e) => {
              setDashboard(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField
          id={`${base}-repos`}
          label={t('ops.services.repos')}
          hint={t('ops.services.reposHint')}
          optionalLabel={t('ops.common.optional')}
        >
          <textarea
            id={`${base}-repos`}
            rows={2}
            value={repos}
            aria-describedby={`${base}-repos-hint`}
            className="rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm"
            onChange={(e) => {
              setRepos(e.target.value);
              touch();
            }}
          />
        </FormField>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('ops.services.rules')}</legend>
          <p className="text-sm text-muted-foreground">{t('ops.services.rulesHint')}</p>
          {rules.map((rule, index) => {
            const id = `${base}-rule-${String(index)}`;
            const update = (patch: Partial<RuleDraft>) => {
              setRules((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
              touch();
            };
            return (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-inner bg-surface shadow-card p-2"
              >
                <div className="grid grid-cols-2 gap-2">
                  <FormField id={`${id}-source`} label={t('ops.services.ruleSource')}>
                    <Select
                      id={`${id}-source`}
                      value={rule.source}
                      onChange={(e) => {
                        update({ source: e.target.value as AlertSource | '' });
                      }}
                    >
                      <option value="">{t('ops.services.anySource')}</option>
                      {ALERT_SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {t(`ops.alerts.source.${source}`)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField
                    id={`${id}-policy`}
                    label={t('ops.services.rulePolicyName')}
                    optionalLabel={t('ops.common.optional')}
                  >
                    <Input
                      id={`${id}-policy`}
                      value={rule.policyName}
                      onChange={(e) => {
                        update({ policyName: e.target.value });
                      }}
                    />
                  </FormField>
                </div>
                <FormField
                  id={`${id}-labels`}
                  label={t('ops.services.ruleLabels')}
                  hint={t('ops.services.ruleLabelsHint')}
                  optionalLabel={t('ops.common.optional')}
                  {...(errors[`rule${String(index)}`]
                    ? { error: errors[`rule${String(index)}`] }
                    : {})}
                >
                  <textarea
                    id={`${id}-labels`}
                    rows={2}
                    value={rule.labels}
                    aria-describedby={`${id}-labels-hint`}
                    className="rounded-md border border-border-strong bg-surface px-2.5 py-2 font-mono text-sm"
                    onChange={(e) => {
                      update({ labels: e.target.value });
                    }}
                  />
                </FormField>
                <div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setRules((current) => current.filter((_, i) => i !== index));
                      touch();
                    }}
                  >
                    {t('ops.services.removeRule')}
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              onClick={() => {
                setRules((current) => [...current, { source: '', policyName: '', labels: '' }]);
                touch();
              }}
            >
              <Plus aria-hidden className="size-4" />
              {t('ops.services.addRule')}
            </Button>
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={active}
            onChange={(e) => {
              setActive(e.target.checked);
              touch();
            }}
          />
          {t('ops.common.active')}
        </label>
      </form>
    </EntitySheet>
  );
}

// --- escalation policies -------------------------------------------------------------------------

export function PoliciesSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const list = useEscalationPolicies();
  const [editing, setEditing] = useState<EscalationPolicy | 'new' | null>(null);
  const [deleting, setDeleting] = useState<EscalationPolicy | null>(null);
  const manage = can('alert.manage');
  return (
    <section aria-label={t('ops.policies.title')} className="flex flex-col gap-2">
      <SectionBar
        title={t('ops.policies.title')}
        addLabel={t('ops.policies.add')}
        onAdd={
          manage
            ? () => {
                setEditing('new');
              }
            : null
        }
      />
      <IntroHint topic={t('ops.policies.title')}>{t('ops.policies.intro')}</IntroHint>
      {list.isPending ? (
        <OpsSkeleton rows={3} />
      ) : list.isError ? (
        <LoadError onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Route />} title={t('ops.policies.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.data.items.map((policy) => (
            <Row
              key={policy.id}
              actions={
                manage ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(policy);
                      }}
                    >
                      {t('ops.common.edit')}
                    </Button>
                    {policy.isDefault ? null : (
                      <Button
                        size="sm"
                        onClick={() => {
                          setDeleting(policy);
                        }}
                      >
                        {t('ops.common.delete')}
                      </Button>
                    )}
                  </>
                ) : null
              }
            >
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{policy.name}</span>
                {policy.isDefault ? (
                  <TintChip tone="indigo">{t('ops.policies.default')}</TintChip>
                ) : null}
              </p>
              <ol className="text-muted-foreground">
                {policy.steps.map((step, index) => (
                  <li key={index}>
                    {t('ops.policies.stepLine', {
                      target: t(ESCALATION_TARGET_LABELS[step.target]),
                      minutes: secondsToMinutes(step.afterSeconds),
                    })}
                  </li>
                ))}
              </ol>
            </Row>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <PolicySheet
          key={editing === 'new' ? 'new' : editing.id}
          policy={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeletePolicy
          policy={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DeletePolicy({ policy, onClose }: { policy: EscalationPolicy; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { mutation, error } = useDelete(
    () => api.deleteEscalationPolicy(policy.id),
    opsKeys(userId).all,
    onClose,
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('ops.policies.deleteTitle', { name: policy.name })}
      description={t('ops.policies.deleteBody')}
      confirmLabel={t('ops.common.delete')}
      onConfirm={() => {
        mutation.mutate();
      }}
      pending={mutation.isPending}
      error={error}
    />
  );
}

interface StepDraft {
  target: EscalationStep['target'];
  minutes: string;
}

function PolicySheet({
  policy,
  onClose,
}: {
  policy: EscalationPolicy | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [name, setName] = useState(policy?.name ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(
    policy
      ? policy.steps.map((s) => ({
          target: s.target,
          minutes: String(secondsToMinutes(s.afterSeconds)),
        }))
      : [{ target: 'on_shift', minutes: '0' }],
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const save = useMutation({
    mutationFn: (body: { name: string; steps: EscalationStep[] }) =>
      policy === null
        ? api.createEscalationPolicy(body)
        : api.updateEscalationPolicy(policy.id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).all });
      toast(t('ops.common.saved'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const submit = () => {
    setSummary(null);
    const parsed: EscalationStep[] = steps.map((s) => ({
      target: s.target,
      afterSeconds: Math.round(Number(s.minutes) * 60),
    }));
    let problem: string | null = null;
    if (
      steps.some(
        (s) =>
          s.minutes.trim() === '' || !Number.isFinite(Number(s.minutes)) || Number(s.minutes) < 0,
      )
    ) {
      problem = t('ops.policies.minutesInvalid');
    } else if (parsed[0]?.afterSeconds !== 0) {
      problem = t('ops.policies.firstAtZero');
    } else if (
      parsed.some((s, i) => i > 0 && s.afterSeconds <= (parsed[i - 1]?.afterSeconds ?? 0))
    ) {
      problem = t('ops.policies.increasing');
    }
    setNameError(name.trim() === '' ? t('ops.common.required') : null);
    setStepError(problem);
    if (name.trim() !== '' && problem === null) save.mutate({ name: name.trim(), steps: parsed });
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={policy ? policy.name : t('ops.policies.add')}
      description={t('ops.policies.sheetDescription')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-name`}
          label={t('ops.common.name')}
          {...(nameError ? { error: nameError } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${base}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </FormField>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('ops.policies.steps')}</legend>
          {steps.map((step, index) => {
            const id = `${base}-step-${String(index)}`;
            const update = (patch: Partial<StepDraft>) => {
              setSteps((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));
              setDirty(true);
            };
            return (
              <div key={index} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
                <FormField
                  id={`${id}-target`}
                  label={t('ops.policies.stepTarget', { number: index + 1 })}
                >
                  <Select
                    id={`${id}-target`}
                    value={step.target}
                    onChange={(e) => {
                      update({ target: e.target.value as EscalationStep['target'] });
                    }}
                  >
                    {ESCALATION_TARGETS.map((target) => (
                      <option key={target} value={target}>
                        {t(ESCALATION_TARGET_LABELS[target])}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField id={`${id}-after`} label={t('ops.policies.afterMinutes')}>
                  <Input
                    id={`${id}-after`}
                    inputMode="numeric"
                    value={step.minutes}
                    disabled={index === 0}
                    onChange={(e) => {
                      update({ minutes: e.target.value });
                    }}
                  />
                </FormField>
                {index > 0 ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setSteps((c) => c.filter((_, i) => i !== index));
                      setDirty(true);
                    }}
                  >
                    {t('ops.policies.removeStep')}
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
          {stepError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {stepError}
            </p>
          ) : null}
          {steps.length < 5 ? (
            <div>
              <Button
                size="sm"
                onClick={() => {
                  setSteps((c) => [...c, { target: 'lead', minutes: '' }]);
                  setDirty(true);
                }}
              >
                <Plus aria-hidden className="size-4" />
                {t('ops.policies.addStep')}
              </Button>
            </div>
          ) : null}
        </fieldset>
      </form>
    </EntitySheet>
  );
}

// --- heartbeats ----------------------------------------------------------------------------------

export function HeartbeatsSection() {
  const { t } = useI18n();
  const { can } = useSession();
  const list = useHeartbeats();
  const services = useServices();
  const [editing, setEditing] = useState<Heartbeat | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Heartbeat | null>(null);
  const manage = can('alert.manage');
  return (
    <section aria-label={t('ops.heartbeats.title')} className="flex flex-col gap-2">
      <SectionBar
        title={t('ops.heartbeats.title')}
        addLabel={t('ops.heartbeats.add')}
        onAdd={
          manage
            ? () => {
                setEditing('new');
              }
            : null
        }
      />
      <IntroHint topic={t('ops.heartbeats.title')}>{t('ops.heartbeats.intro')}</IntroHint>
      {list.isPending ? (
        <OpsSkeleton rows={3} />
      ) : list.isError ? (
        <LoadError onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Heart />} title={t('ops.heartbeats.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.data.items.map((beat) => (
            <Row
              key={beat.id}
              actions={
                manage ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(beat);
                      }}
                    >
                      {t('ops.common.edit')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setDeleting(beat);
                      }}
                    >
                      {t('ops.common.delete')}
                    </Button>
                  </>
                ) : null
              }
            >
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{beat.name}</span>
                <code className="text-xs text-muted-foreground">{beat.slug}</code>
                {beat.state === 'missing' ? (
                  <TintChip tone="red" icon={HeartCrack} strong>
                    {t('ops.heartbeats.missing')}
                  </TintChip>
                ) : (
                  <TintChip tone="green" icon={Heart}>
                    {t('ops.heartbeats.ok')}
                  </TintChip>
                )}
                {beat.active ? null : <TintChip tone="slate">{t('ops.common.inactive')}</TintChip>}
              </p>
              <p className="text-muted-foreground">
                {t('ops.heartbeats.every', {
                  minutes: secondsToMinutes(beat.expectedIntervalSeconds),
                  grace: secondsToMinutes(beat.graceSeconds),
                })}
                {' · '}
                {services.data?.items.find((s) => s.id === beat.serviceId)?.name ??
                  t('ops.alerts.unmapped')}
              </p>
              <p className="text-muted-foreground">
                {beat.lastBeatAt ? (
                  <>
                    {t('ops.heartbeats.lastBeat')} <Moment iso={beat.lastBeatAt} />
                  </>
                ) : (
                  t('ops.heartbeats.neverBeat')
                )}
                {beat.missingSince ? (
                  <>
                    {' '}
                    · {t('ops.heartbeats.missingSince')} <Moment iso={beat.missingSince} />
                  </>
                ) : null}
              </p>
            </Row>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <HeartbeatSheet
          key={editing === 'new' ? 'new' : editing.id}
          beat={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteHeartbeat
          beat={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DeleteHeartbeat({ beat, onClose }: { beat: Heartbeat; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { mutation, error } = useDelete(
    () => api.deleteHeartbeat(beat.id),
    opsKeys(userId).all,
    onClose,
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('ops.heartbeats.deleteTitle', { name: beat.name })}
      description={t('ops.heartbeats.deleteBody')}
      confirmLabel={t('ops.common.delete')}
      onConfirm={() => {
        mutation.mutate();
      }}
      pending={mutation.isPending}
      error={error}
    />
  );
}

const BEAT_SEVERITIES = ['critical', 'error', 'warning', 'info'] as const;

function HeartbeatSheet({ beat, onClose }: { beat: Heartbeat | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const services = useServices();
  const [slug, setSlug] = useState(beat?.slug ?? '');
  const [name, setName] = useState(beat?.name ?? '');
  const [interval, setInterval] = useState(
    String(beat ? secondsToMinutes(beat.expectedIntervalSeconds) : 5),
  );
  const [grace, setGrace] = useState(String(beat ? secondsToMinutes(beat.graceSeconds) : 2));
  const [severity, setSeverity] = useState<(typeof BEAT_SEVERITIES)[number]>(
    beat?.severity ?? 'error',
  );
  const [serviceId, setServiceId] = useState(beat?.serviceId ?? '');
  const [active, setActive] = useState(beat?.active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => {
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof build>) =>
      beat === null ? api.createHeartbeat(body) : api.updateHeartbeat(beat.id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).heartbeats });
      toast(t('ops.common.saved'));
      onClose();
    },
    onError: (e) => {
      setSummary(describeOpsError(e, t).message);
    },
  });

  const build = () => ({
    slug: slug.trim(),
    name: name.trim(),
    expectedIntervalSeconds: Math.round(Number(interval) * 60),
    graceSeconds: Math.round(Number(grace) * 60),
    severity,
    serviceId: serviceId === '' ? null : serviceId,
    active,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim()) || slug.trim().length < 2)
      next.slug = t('ops.services.slugInvalid');
    if (name.trim() === '') next.name = t('ops.common.required');
    const every = Number(interval);
    if (!Number.isFinite(every) || every < 0.5 || every > 10_080)
      next.interval = t('ops.heartbeats.intervalInvalid');
    const extra = Number(grace);
    if (!Number.isFinite(extra) || extra < 0 || extra > 1440)
      next.grace = t('ops.heartbeats.graceInvalid');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length === 0) save.mutate(build());
  };

  return (
    <EntitySheet
      open
      onClose={onClose}
      title={beat ? beat.name : t('ops.heartbeats.add')}
      description={t('ops.heartbeats.sheetDescription')}
      dirty={dirty}
      pending={save.isPending}
      formId={`${base}-form`}
      error={summary}
    >
      <form
        id={`${base}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <FormField
          id={`${base}-name`}
          label={t('ops.common.name')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              touch();
            }}
          />
        </FormField>
        <FormField
          id={`${base}-slug`}
          label={t('ops.services.slug')}
          hint={t('ops.services.slugHint')}
          {...(errors.slug ? { error: errors.slug } : {})}
        >
          <Input
            id={`${base}-slug`}
            value={slug}
            aria-invalid={errors.slug ? true : undefined}
            aria-describedby={`${base}-slug-hint${errors.slug ? ` ${base}-slug-error` : ''}`}
            onChange={(e) => {
              setSlug(e.target.value);
              touch();
            }}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            id={`${base}-interval`}
            label={t('ops.heartbeats.interval')}
            {...(errors.interval ? { error: errors.interval } : {})}
          >
            <Input
              id={`${base}-interval`}
              inputMode="decimal"
              value={interval}
              aria-invalid={errors.interval ? true : undefined}
              aria-describedby={errors.interval ? `${base}-interval-error` : undefined}
              onChange={(e) => {
                setInterval(e.target.value);
                touch();
              }}
            />
          </FormField>
          <FormField
            id={`${base}-grace`}
            label={t('ops.heartbeats.grace')}
            {...(errors.grace ? { error: errors.grace } : {})}
          >
            <Input
              id={`${base}-grace`}
              inputMode="decimal"
              value={grace}
              aria-invalid={errors.grace ? true : undefined}
              aria-describedby={errors.grace ? `${base}-grace-error` : undefined}
              onChange={(e) => {
                setGrace(e.target.value);
                touch();
              }}
            />
          </FormField>
        </div>
        <FormField id={`${base}-severity`} label={t('ops.heartbeats.severity')}>
          <Select
            id={`${base}-severity`}
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value as typeof severity);
              touch();
            }}
          >
            {BEAT_SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {t(`ops.alerts.severity.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id={`${base}-service`} label={t('ops.heartbeats.service')}>
          <Select
            id={`${base}-service`}
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              touch();
            }}
          >
            <option value="">{t('ops.alerts.unmapped')}</option>
            {(services.data?.items ?? []).map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>
        </FormField>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={active}
            onChange={(e) => {
              setActive(e.target.checked);
              touch();
            }}
          />
          {t('ops.common.active')}
        </label>
      </form>
    </EntitySheet>
  );
}
