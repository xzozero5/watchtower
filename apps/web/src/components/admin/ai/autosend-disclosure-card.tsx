'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type AutosendDisclosure, setAutosendDisclosureSchema } from '@watchtower/shared';
import { Button, Skeleton, Textarea, TintChip, toast } from '@watchtower/ui';
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useAutosendDisclosure } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';

/**
 * The footer that tells a customer a reply was sent automatically (ADR-025 section 8, owner decision 3): on by
 * default, Thai and English, kept in `instance_setting`. A head may change the words or turn it off, with a
 * reason that goes to the audit log. Everyone on staff can read it.
 */
export function AutosendDisclosureCard() {
  const { t } = useI18n();
  const disclosure = useAutosendDisclosure(true);
  return (
    <section aria-labelledby="ai-disclosure-title" className="px-4 pb-2">
      <div className="rounded-2xl bg-surface px-5 py-4 ring-1 ring-border/60 ring-inset">
        {disclosure.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{t('admin.common.loading')}</span>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-16" />
          </div>
        ) : disclosure.isError ? (
          <LoadError
            message={t('stage3.disclosure.loadError')}
            onRetry={() => void disclosure.refetch()}
          />
        ) : (
          <DisclosureForm key={JSON.stringify(disclosure.data)} current={disclosure.data} />
        )}
      </div>
    </section>
  );
}

function DisclosureForm({ current }: { current: AutosendDisclosure }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const baseId = useId();
  const canChange = can('ai.autonomy.set.any');
  const [enabled, setEnabled] = useState(current.enabled);
  const [th, setTh] = useState(current.text.th);
  const [en, setEn] = useState(current.text.en);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const body = { enabled, text: { th: th.trim(), en: en.trim() }, reason: reason.trim() };
  const valid = setAutosendDisclosureSchema.safeParse(body).success;
  const dirty =
    enabled !== current.enabled || th.trim() !== current.text.th || en.trim() !== current.text.en;

  const save = useMutation({
    mutationFn: () => api.setAutosendDisclosure(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...adminKeys(userId).all, 'autosend-disclosure'],
      });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
      setError(null);
      setReason('');
      toast(t('stage3.disclosure.saved'));
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  const id = (name: string) => `${baseId}-${name}`;
  const disabled = !canChange || save.isPending;
  const bothTexts = th.trim() !== '' && en.trim() !== '';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-disclosure-title" className="text-sm font-semibold">
          {t('stage3.disclosure.title')}
        </h2>
        <TintChip
          tone={current.enabled ? 'teal' : 'amber'}
          icon={current.enabled ? CircleCheck : TriangleAlert}
        >
          {t(current.enabled ? 'admin.ai.on' : 'admin.ai.off')}
        </TintChip>
      </div>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        {t('stage3.disclosure.lead')}
      </p>
      {!current.enabled ? (
        <p className="mt-1 text-sm font-medium">{t('stage3.disclosure.off')}</p>
      ) : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canChange && dirty && valid) {
            setError(null);
            save.mutate();
          }
        }}
        className="mt-3 flex max-w-xl flex-col gap-3"
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
            }}
            className="size-4"
          />
          {t('stage3.disclosure.enabled')}
        </label>
        <FormField id={id('th')} label={t('stage3.disclosure.th')}>
          <Textarea
            id={id('th')}
            rows={2}
            lang="th"
            maxLength={400}
            value={th}
            disabled={disabled}
            onChange={(event) => {
              setTh(event.target.value);
            }}
          />
        </FormField>
        <FormField id={id('en')} label={t('stage3.disclosure.en')}>
          <Textarea
            id={id('en')}
            rows={2}
            lang="en"
            maxLength={400}
            value={en}
            disabled={disabled}
            onChange={(event) => {
              setEn(event.target.value);
            }}
          />
        </FormField>
        {!canChange ? (
          <p className="text-sm text-muted-foreground">{t('stage3.disclosure.readOnly')}</p>
        ) : (
          <>
            {!bothTexts ? (
              <p className="text-sm font-medium text-danger">{t('stage3.disclosure.invalid')}</p>
            ) : null}
            <FormField id={id('reason')} label={t('stage3.disclosure.reason')}>
              <Textarea
                id={id('reason')}
                rows={2}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </FormField>
            {error ? (
              <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
                <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
            <div>
              <Button variant="primary" type="submit" disabled={save.isPending || !dirty || !valid}>
                {save.isPending ? t('stage3.disclosure.saving') : t('stage3.disclosure.save')}
              </Button>
            </div>
          </>
        )}
      </form>
    </>
  );
}
