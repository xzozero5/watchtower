'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ORG_TIERS, type Organization, orgDomainSchema } from '@watchtower/shared';
import { Button, Input, Select, Textarea, toast } from '@watchtower/ui';
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';

import { EntitySheet } from '@/components/admin/entity-sheet';
import { FormField } from '@/components/portal/form-field';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useSlaPolicies } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

/**
 * Create or edit an organization in the right-hand sheet. Domains are chips; a public mailbox
 * provider is refused on the spot with the shared schema's own sentence.
 */
export function OrgSheet({
  open,
  org,
  onClose,
  onSaved,
  extraTiers = [],
}: {
  open: boolean;
  org: Organization | null;
  onClose: () => void;
  onSaved?: (org: Organization) => void;
  /** Tiers seen on organizations already loaded (the tier list has no endpoint yet). */
  extraTiers?: readonly string[];
}) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const policies = useSlaPolicies(open);
  const base = useId();
  const [name, setName] = useState(org?.name ?? '');
  const [tier, setTier] = useState(org?.tier ?? 'standard');
  const [policyId, setPolicyId] = useState(org?.slaPolicyId ?? '');
  const [domains, setDomains] = useState<string[]>(org?.domains ?? []);
  const [domainDraft, setDomainDraft] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [notes, setNotes] = useState(org?.notes ?? '');
  const [status, setStatus] = useState(org?.status ?? 'active');
  const [nameError, setNameError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const dirty =
    org === null
      ? name !== '' || domains.length > 0 || notes !== ''
      : name !== org.name ||
        tier !== org.tier ||
        policyId !== (org.slaPolicyId ?? '') ||
        notes !== org.notes ||
        status !== org.status ||
        domains.join() !== org.domains.join();

  const save = useMutation({
    mutationFn: () =>
      org === null
        ? api.createOrg({
            name: name.trim(),
            tier,
            domains,
            notes,
            ...(policyId ? { slaPolicyId: policyId } : {}),
          })
        : api.updateOrg(org.id, {
            name: name.trim(),
            tier,
            domains,
            notes,
            status,
            slaPolicyId: policyId === '' ? null : policyId,
          }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).orgs });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).org(saved.id) });
      toast(t('admin.common.saved'));
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  const addDomain = () => {
    const parsed = orgDomainSchema.safeParse(domainDraft);
    if (!parsed.success) {
      setDomainError(parsed.error.issues[0]?.message ?? t('admin.orgs.domainInvalid'));
      return;
    }
    if (!domains.includes(parsed.data)) setDomains([...domains, parsed.data]);
    setDomainDraft('');
    setDomainError(null);
  };

  const submit = () => {
    setSummary(null);
    if (name.trim() === '') {
      setNameError(t('admin.common.required'));
      return;
    }
    setNameError(null);
    save.mutate();
  };

  const tiers = [...new Set<string>([...ORG_TIERS, ...extraTiers, tier])];

  return (
    <EntitySheet
      open={open}
      onClose={onClose}
      title={org ? org.name : t('admin.orgs.new')}
      description={org ? t('admin.orgs.edit') : t('admin.orgs.new')}
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
          label={t('admin.common.name')}
          {...(nameError ? { error: nameError } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField id={`${base}-tier`} label={t('admin.orgs.tier')}>
            <Select
              id={`${base}-tier`}
              value={tier}
              onChange={(event) => {
                setTier(event.target.value);
              }}
            >
              {tiers.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id={`${base}-sla`} label={t('admin.orgs.slaPolicy')}>
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
        <FormField
          id={`${base}-domain`}
          label={t('admin.orgs.domains')}
          {...(domainError ? { error: domainError } : {})}
        >
          <div className="flex gap-2">
            <Input
              id={`${base}-domain`}
              value={domainDraft}
              placeholder="example.com"
              aria-invalid={domainError ? true : undefined}
              aria-describedby={domainError ? `${base}-domain-error` : undefined}
              onChange={(event) => {
                setDomainDraft(event.target.value);
                setDomainError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addDomain();
                }
              }}
              className="min-w-0 flex-1"
            />
            <Button onClick={addDomain} disabled={domainDraft.trim() === ''}>
              <Plus aria-hidden className="size-4" />
              {t('admin.common.add')}
            </Button>
          </div>
          {domains.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {domains.map((domain) => (
                <li
                  key={domain}
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs"
                >
                  {domain}
                  <button
                    type="button"
                    aria-label={t('admin.orgs.removeDomain', { domain })}
                    onClick={() => {
                      setDomains(domains.filter((item) => item !== domain));
                    }}
                    className="rounded-full hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </FormField>
        <FormField
          id={`${base}-notes`}
          label={t('admin.orgs.notes')}
          optionalLabel={t('admin.common.optional')}
        >
          <Textarea
            id={`${base}-notes`}
            rows={3}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </FormField>
        {org ? (
          <FormField id={`${base}-status`} label={t('admin.common.status')}>
            <Select
              id={`${base}-status`}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as 'active' | 'inactive');
              }}
            >
              <option value="active">{t('admin.common.active')}</option>
              <option value="inactive">{t('admin.common.inactive')}</option>
            </Select>
          </FormField>
        ) : null}
      </form>
    </EntitySheet>
  );
}
