'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { emailSchema, type IntegrationStatus } from '@watchtower/shared';
import { Alert, Button, Input, toast } from '@watchtower/ui';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { FormField } from '@/components/portal/form-field';
import { useI18n } from '@/i18n/provider';
import { adminKeys, useGmailStatus } from '@/lib/admin/queries';
import { describeIntegrationError, isSafeRedirect } from '@/lib/admin/integrations';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { navigateTo } from '@/lib/navigate';

/**
 * Connect the one support mailbox with its Gmail sign-in (T-102e): status, Connect (sends the browser
 * to the consent page, which returns to this page with `?gmail_oauth=`), and Disconnect. Never shows a token.
 * `integration` is the Gmail card's status; it tells whether the environment holds the grant.
 */
export function GmailConnection({ integration }: { integration: IntegrationStatus }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const status = useGmailStatus();
  const mailboxId = useId();
  const [mailbox, setMailbox] = useState('');
  const [mailboxError, setMailboxError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const envLocked = integration.fields.some(
    (entry) =>
      (entry.field === 'oauthRefreshToken' || entry.field === 'oauthMailbox') &&
      entry.source === 'env',
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).gmailStatus });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).integrations });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).channelAccounts });
  };

  const start = useMutation({
    mutationFn: (address: string) => api.gmailOauthStart(address),
    onSuccess: (result) => {
      if (!isSafeRedirect(result.authorizationUrl)) {
        setError(t('admin.integrations.gmail.unsafeUrl'));
        return;
      }
      navigateTo(result.authorizationUrl);
    },
    onError: (failure) => {
      setError(describeIntegrationError(failure, t).message);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.gmailOauthDisconnect(),
    onSuccess: (result) => {
      setConfirming(false);
      setError(null);
      refresh();
      toast(
        result.revoke === 'revoked'
          ? t('admin.integrations.gmail.disconnected')
          : result.revoke === 'failed'
            ? t('admin.integrations.gmail.disconnectedNotRevoked')
            : t('admin.integrations.gmail.disconnectedNothing'),
      );
    },
    onError: (failure) => {
      setError(describeIntegrationError(failure, t).message);
    },
  });

  if (status.isPending) {
    return (
      <p role="status" aria-busy="true" className="mt-4 text-sm text-muted-foreground">
        {t('admin.common.loading')}
      </p>
    );
  }
  if (status.isError) {
    return (
      <LoadError
        className="mt-3 px-0"
        message={t('admin.integrations.gmail.statusLoadError')}
        onRetry={() => void status.refetch()}
      />
    );
  }

  const data = status.data;
  const typed = mailbox !== '' ? mailbox : (data.oauthMailbox ?? '');

  const connect = () => {
    setError(null);
    const parsed = emailSchema.safeParse(typed);
    if (!parsed.success) {
      setMailboxError(t('admin.integrations.gmail.mailboxInvalid'));
      return;
    }
    setMailboxError(null);
    start.mutate(parsed.data);
  };

  return (
    <div
      role="group"
      aria-label={t('admin.integrations.gmail.heading')}
      className="mt-4 flex flex-col gap-2 rounded-lg border border-border/60 bg-surface-muted/40 p-3"
    >
      <h4 className="text-sm font-medium">{t('admin.integrations.gmail.heading')}</h4>
      <p className="text-sm text-muted-foreground">
        {t('admin.integrations.gmail.using', {
          method: t(`admin.integrations.gmail.method.${data.effectiveMethod ?? 'none'}`),
        })}
      </p>
      <p className="text-sm">
        {data.oauthConnected && data.oauthMailbox
          ? t('admin.integrations.gmail.connectedAs', { mailbox: data.oauthMailbox })
          : t('admin.integrations.gmail.notConnected')}
      </p>
      {data.needsReconnect ? (
        <Alert tone="error" title={t('admin.integrations.gmail.needsReconnect')} />
      ) : null}
      {data.oauthClientConfigured ? null : (
        <p className="text-sm text-muted-foreground">
          {t('admin.integrations.gmail.clientMissing')}
        </p>
      )}
      {envLocked ? (
        <p className="text-sm text-muted-foreground">{t('admin.integrations.gmail.envLocked')}</p>
      ) : null}
      <div className="text-sm">
        <p className="text-muted-foreground">{t('admin.integrations.gmail.redirectUri')}</p>
        <code className="font-mono break-all">{data.redirectUri}</code>
      </div>

      <FormField
        id={mailboxId}
        label={t('admin.integrations.gmail.mailboxLabel')}
        {...(mailboxError ? { error: mailboxError } : {})}
      >
        <Input
          id={mailboxId}
          type="email"
          autoComplete="off"
          value={typed}
          disabled={envLocked}
          aria-invalid={mailboxError ? true : undefined}
          aria-describedby={mailboxError ? `${mailboxId}-error` : undefined}
          onChange={(event) => {
            setMailbox(event.target.value);
          }}
          className="w-full max-w-sm"
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={connect}
          disabled={envLocked || !data.oauthClientConfigured || start.isPending}
        >
          {start.isPending
            ? t('admin.integrations.gmail.connecting')
            : data.oauthConnected
              ? t('admin.integrations.gmail.reconnect')
              : t('admin.integrations.gmail.connect')}
        </Button>
        {data.oauthConnected ? (
          <Button
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            disabled={envLocked || disconnect.isPending}
          >
            {t('admin.integrations.gmail.disconnect')}
          </Button>
        ) : null}
      </div>
      {error && !confirming ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
          title={t('admin.integrations.gmail.disconnectTitle', {
            mailbox: data.oauthMailbox ?? '',
          })}
          description={t('admin.integrations.gmail.disconnectBody')}
          confirmLabel={t('admin.integrations.gmail.disconnectConfirm')}
          onConfirm={() => {
            disconnect.mutate();
          }}
          pending={disconnect.isPending}
          error={error}
        />
      ) : null}
    </div>
  );
}
