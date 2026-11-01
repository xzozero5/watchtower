'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ChannelAccount,
  type CreateChannelAccount,
  MANAGED_CHANNEL_TYPES,
  type ManagedChannelType,
  normaliseMailboxAddress,
} from '@watchtower/shared';
import { Button, EmptyState, Input, Pill, Select, toast } from '@watchtower/ui';
import { Copy, Inbox, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { z } from 'zod';

import { LoadError, TableSkeleton } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { EntitySheet } from '@/components/admin/entity-sheet';
import { StatusChip } from '@/components/admin/integrations/integration-card';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useChannelAccounts } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

const emailSchema = z.string().transform(normaliseMailboxAddress).pipe(z.email());

/** LINE accounts and Gmail mailboxes: list, add, switch off, and the LINE webhook URL to copy. */
export function ChannelAccountsSection() {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const accounts = useChannelAccounts();
  const [creating, setCreating] = useState(false);
  const [disabling, setDisabling] = useState<ChannelAccount | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).channelAccounts });
  };

  const disable = useMutation({
    mutationFn: (account: ChannelAccount) => api.disableChannelAccount(account.id),
    onSuccess: () => {
      setDisabling(null);
      setActionError(null);
      refresh();
      toast(t('admin.integrations.accounts.disabledToast'));
    },
    onError: (error) => {
      setActionError(describeError(error, t).message);
    },
  });

  const items = accounts.data?.items ?? [];

  return (
    <section aria-labelledby="channel-accounts-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="channel-accounts-heading" className="text-base font-semibold">
            {t('admin.integrations.accountsHeading')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('admin.integrations.accountsHint')}</p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus aria-hidden className="size-4" />
          {t('admin.integrations.accounts.add')}
        </Button>
      </div>

      {accounts.isPending ? (
        <TableSkeleton rows={2} />
      ) : accounts.isError ? (
        <LoadError onRetry={() => void accounts.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title={t('admin.integrations.accounts.empty')}
          description={t('admin.integrations.accounts.emptyHint')}
        />
      ) : (
        <ul
          aria-label={t('admin.integrations.accounts.listLabel')}
          className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-surface"
        >
          {items.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onDisable={() => {
                setActionError(null);
                setDisabling(account);
              }}
            />
          ))}
        </ul>
      )}

      <CreateSheet
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onDone={refresh}
      />
      {disabling ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDisabling(null);
          }}
          title={t('admin.integrations.accounts.disableTitle', { name: disabling.name })}
          description={t('admin.integrations.accounts.disableBody')}
          confirmLabel={t('admin.integrations.accounts.disableConfirm')}
          onConfirm={() => {
            disable.mutate(disabling);
          }}
          pending={disable.isPending}
          error={actionError}
        />
      ) : null}
    </section>
  );
}

function AccountRow({ account, onDisable }: { account: ChannelAccount; onDisable: () => void }) {
  const { t } = useI18n();
  const urlId = useId();
  const [copied, setCopied] = useState(false);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast(t('admin.integrations.accounts.copied'));
    } catch {
      // The field stays selectable; nothing else to do when the browser refuses the clipboard.
      setCopied(false);
    }
  };

  const health =
    account.health === 'unknown' ? t('admin.integrations.accounts.healthUnknown') : account.health;
  return (
    <li data-account={account.id} className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{account.name}</span>
          <Pill>
            {t(`admin.integrations.accounts.type.${account.type satisfies ManagedChannelType}`)}
          </Pill>
          <Pill data-enabled={account.enabled}>
            {account.enabled
              ? t('admin.integrations.accounts.enabled')
              : t('admin.integrations.accounts.disabled')}
          </Pill>
        </div>
        {account.enabled ? (
          <Button
            size="sm"
            onClick={onDisable}
            aria-label={`${t('admin.integrations.accounts.disable')} ${account.name}`}
          >
            {t('admin.integrations.accounts.disable')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {account.emailAddress ? (
          <span>{t('admin.integrations.accounts.mailbox', { address: account.emailAddress })}</span>
        ) : null}
        <span>{t('admin.integrations.accounts.health', { health })}</span>
        <span className="inline-flex items-center gap-1.5">
          {t('admin.integrations.accounts.credentials')}:
          <StatusChip state={account.credentials} />
        </span>
      </div>
      {account.notes.length > 0 ? (
        <ul className="list-disc ps-5 text-sm text-muted-foreground">
          {account.notes.map((note) => (
            // The api's own sentence about what to do next.
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {account.webhookUrl ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={urlId} className="text-sm font-medium">
            {t('admin.integrations.accounts.webhookUrl')}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id={urlId}
              readOnly
              value={account.webhookUrl}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              className="w-full font-mono"
            />
            <Button
              onClick={() => {
                void copy(account.webhookUrl ?? '');
              }}
            >
              <Copy aria-hidden className="size-4" />
              {copied
                ? t('admin.integrations.accounts.copied')
                : t('admin.integrations.accounts.copy')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function CreateSheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const base = useId();
  const [type, setType] = useState<ManagedChannelType>('line');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [summary, setSummary] = useState<string | null>(null);

  const reset = () => {
    setType('line');
    setName('');
    setEmail('');
    setErrors({});
    setSummary(null);
  };

  const create = useMutation({
    mutationFn: (body: CreateChannelAccount) => api.createChannelAccount(body),
    onSuccess: () => {
      onDone();
      toast(t('admin.integrations.accounts.created'));
      reset();
      onClose();
    },
    onError: (error) => {
      setSummary(describeError(error, t).message);
    },
  });

  const submit = () => {
    const next: { name?: string; email?: string } = {};
    if (name.trim() === '') next.name = t('admin.common.required');
    const address = emailSchema.safeParse(email);
    if (type === 'gmail' && !address.success)
      next.email = t('admin.integrations.accounts.emailInvalid');
    setErrors(next);
    setSummary(null);
    if (Object.keys(next).length > 0) return;
    create.mutate(
      type === 'gmail' && address.success
        ? { type: 'gmail', name: name.trim(), emailAddress: address.data }
        : { type: 'line', name: name.trim() },
    );
  };

  return (
    <EntitySheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('admin.integrations.accounts.createTitle')}
      description={t('admin.integrations.accounts.createHint')}
      dirty={name !== '' || email !== ''}
      pending={create.isPending}
      formId={`${base}-form`}
      submitLabel={t('admin.integrations.accounts.add')}
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
        <FormField id={`${base}-type`} label={t('admin.integrations.accounts.typeLabel')}>
          <Select
            id={`${base}-type`}
            value={type}
            onChange={(event) => {
              setType(event.target.value as ManagedChannelType);
            }}
          >
            {MANAGED_CHANNEL_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`admin.integrations.accounts.type.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          id={`${base}-name`}
          label={t('admin.integrations.accounts.nameLabel')}
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id={`${base}-name`}
            value={name}
            maxLength={120}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${base}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </FormField>
        {type === 'gmail' ? (
          <FormField
            id={`${base}-email`}
            label={t('admin.integrations.accounts.emailLabel')}
            {...(errors.email ? { error: errors.email } : {})}
          >
            <Input
              id={`${base}-email`}
              type="email"
              autoComplete="off"
              value={email}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? `${base}-email-error` : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </FormField>
        ) : null}
      </form>
    </EntitySheet>
  );
}
