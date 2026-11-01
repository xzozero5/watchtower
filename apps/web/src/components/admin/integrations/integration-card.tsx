'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CredentialFieldStatus,
  IntegrationStatus,
  TestConnectionResult,
  TestMode,
} from '@watchtower/shared';
import { Button, Input, Pill, Textarea, toast } from '@watchtower/ui';
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Eye, EyeOff, Lock } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { useI18n } from '@/i18n/provider';
import { adminKeys } from '@/lib/admin/queries';
import {
  type CardState,
  cardState,
  describeIntegrationError,
  fieldLabel,
  groupFields,
  integrationName,
  typedFields,
} from '@/lib/admin/integrations';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';

const STATE_ICON: Record<CardState | 'failed', typeof CircleCheck> = {
  not_configured: CircleDashed,
  partial: CircleAlert,
  configured: CircleCheck,
  env: Lock,
  failed: CircleX,
};

/** Icon and words together, so the state never rests on colour alone. */
export function StatusChip({ state }: { state: CardState | 'failed' }) {
  const { t } = useI18n();
  const Icon = STATE_ICON[state];
  return (
    <Pill data-state={state}>
      <Icon aria-hidden className="size-3.5" />
      {t(`admin.integrations.status.${state}`)}
    </Pill>
  );
}

/**
 * One integration (docs/06-UI-SPEC.md section 12): a status chip, its fields write-only (the value
 * is never shown, not even masked), "Set by environment variable NAME" where the environment wins,
 * and "Test connection", which can try the values typed but not yet saved. `children` is extra
 * content under the fields (the Gmail connection panel).
 */
export function IntegrationCard({
  integration,
  testMode,
  children,
}: {
  integration: IntegrationStatus;
  testMode: TestMode;
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const headingId = useId();
  const name = integrationName(t, integration.key, integration.name);

  /** A field is being replaced when it has a draft (even an empty one). */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<CredentialFieldStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    { kind: 'result'; value: TestConnectionResult } | { kind: 'error'; message: string } | null
  >(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).integrations });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).gmailStatus });
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).channelAccounts });
  };

  const typed = typedFields(drafts);
  const hasTyped = Object.keys(typed).length > 0;

  const save = useMutation({
    mutationFn: () => api.putIntegration(integration.key, { fields: typed }),
    onSuccess: () => {
      setDrafts({});
      setShown({});
      setActionError(null);
      setTestResult(null);
      refresh();
      toast(t('admin.integrations.saved'));
    },
    onError: (error) => {
      setActionError(describeIntegrationError(error, t).message);
    },
  });

  const test = useMutation({
    mutationFn: () => api.testIntegration(integration.key, hasTyped ? { fields: typed } : {}),
    onSuccess: (value) => {
      setTestResult({ kind: 'result', value });
    },
    onError: (error) => {
      setTestResult({ kind: 'error', message: describeIntegrationError(error, t).message });
    },
  });

  const remove = useMutation({
    mutationFn: (field: string) => api.deleteIntegrationField(integration.key, field),
    onSuccess: () => {
      setRemoving(null);
      setActionError(null);
      setTestResult(null);
      refresh();
      toast(t('admin.integrations.removed'));
    },
    onError: (error) => {
      setActionError(describeIntegrationError(error, t).message);
    },
  });

  const failed = testResult?.kind === 'error' || testResult?.value.ok === false;
  const state: CardState | 'failed' = failed ? 'failed' : cardState(integration);
  const groups = groupFields(integration.key, integration.fields);

  const startEdit = (field: string) => {
    setDrafts((current) => ({ ...current, [field]: current[field] ?? '' }));
  };
  const stopEdit = (field: string) => {
    setDrafts((current) => {
      return Object.fromEntries(Object.entries(current).filter(([name]) => name !== field));
    });
  };

  return (
    <section
      aria-labelledby={headingId}
      data-integration={integration.key}
      className="rounded-xl border border-border/60 bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold">
          {name}
        </h3>
        <StatusChip state={state} />
      </div>

      <div className="mt-3 flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.id ?? 'all'} className="flex flex-col gap-1">
            {group.id ? (
              <h4 className="text-sm font-medium text-muted-foreground">
                {t(`admin.integrations.groups.${group.id}`)}
              </h4>
            ) : null}
            <ul
              aria-label={t('admin.integrations.field.list', { name })}
              className="flex flex-col divide-y divide-border/60"
            >
              {group.fields.map((entry) => (
                <FieldRow
                  key={entry.field}
                  entry={entry}
                  integrationKey={integration.key}
                  editing={entry.field in drafts}
                  value={drafts[entry.field] ?? ''}
                  revealed={shown[entry.field] === true}
                  disabled={save.isPending}
                  locale={locale}
                  onEdit={() => {
                    startEdit(entry.field);
                  }}
                  onDiscard={() => {
                    stopEdit(entry.field);
                  }}
                  onChange={(value) => {
                    setDrafts((current) => ({ ...current, [entry.field]: value }));
                  }}
                  onToggle={() => {
                    setShown((current) => ({ ...current, [entry.field]: !current[entry.field] }));
                  }}
                  onRemove={() => {
                    setActionError(null);
                    setRemoving(entry);
                  }}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {children}

      {actionError && !removing ? (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{actionError}</span>
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            setTestResult(null);
            test.mutate();
          }}
          disabled={test.isPending}
        >
          {test.isPending
            ? t('admin.integrations.test.running')
            : t('admin.integrations.test.button')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setActionError(null);
            save.mutate();
          }}
          disabled={!hasTyped || save.isPending}
        >
          {save.isPending ? t('admin.form.saving') : t('admin.integrations.save')}
        </Button>
        {hasTyped ? (
          <span className="text-xs text-muted-foreground">
            {t('admin.integrations.test.withUnsaved')}
          </span>
        ) : null}
      </div>

      <div aria-live="polite" className="mt-2 min-h-5 text-sm">
        {testResult?.kind === 'result' ? (
          <TestOutcome result={testResult.value} testMode={testMode} locale={locale} />
        ) : null}
        {testResult?.kind === 'error' ? (
          <p className="flex items-start gap-1.5 font-medium text-danger">
            <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              {t('admin.integrations.test.failed')}. {testResult.message}
            </span>
          </p>
        ) : null}
      </div>

      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={t('admin.integrations.removeTitle', {
            label: fieldLabel(t, removing.field, removing.label),
          })}
          description={t('admin.integrations.removeBody', { name })}
          confirmLabel={t('admin.integrations.removeConfirm')}
          onConfirm={() => {
            remove.mutate(removing.field);
          }}
          pending={remove.isPending}
          error={actionError}
        />
      ) : null}
    </section>
  );
}

function TestOutcome({
  result,
  testMode,
  locale,
}: {
  result: TestConnectionResult;
  testMode: TestMode;
  locale: 'th' | 'en';
}) {
  const { t } = useI18n();
  const Icon = result.ok ? CircleCheck : CircleX;
  const headline = result.ok
    ? result.mode === 'mock' || testMode === 'mock'
      ? t('admin.integrations.test.okMock')
      : t('admin.integrations.test.ok')
    : t('admin.integrations.test.failed');
  return (
    <div data-ok={result.ok} className="flex flex-col gap-0.5">
      <p
        className={
          result.ok
            ? 'flex items-start gap-1.5 font-medium'
            : 'flex items-start gap-1.5 font-medium text-danger'
        }
      >
        <Icon
          aria-hidden
          className={result.ok ? 'mt-0.5 size-4 shrink-0 text-success' : 'mt-0.5 size-4 shrink-0'}
        />
        <span>{headline}</span>
      </p>
      {result.ok && result.identity ? (
        <p className="ps-5.5 text-muted-foreground">
          {t('admin.integrations.test.identity', { identity: result.identity })}
        </p>
      ) : null}
      {/* The api's own sentence: plain language, never a submitted or stored value (ADR-012). */}
      {result.message ? <p className="ps-5.5 text-muted-foreground">{result.message}</p> : null}
      <p className="ps-5.5 text-xs text-muted-foreground">
        {t('admin.integrations.test.checkedAt', { date: formatDateTime(result.checkedAt, locale) })}
      </p>
    </div>
  );
}

function FieldRow({
  entry,
  integrationKey,
  editing,
  value,
  revealed,
  disabled,
  locale,
  onEdit,
  onDiscard,
  onChange,
  onToggle,
  onRemove,
}: {
  entry: CredentialFieldStatus;
  integrationKey: string;
  editing: boolean;
  value: string;
  revealed: boolean;
  disabled: boolean;
  locale: 'th' | 'en';
  onEdit: () => void;
  onDiscard: () => void;
  onChange: (value: string) => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const label = fieldLabel(t, entry.field, entry.label);
  const envLocked = entry.source === 'env';
  const editWord =
    entry.source === 'db'
      ? t('admin.integrations.field.replace')
      : t('admin.integrations.field.setValue');
  const multiline =
    integrationKey === 'github'
      ? entry.field === 'privateKey'
      : entry.field === 'serviceAccountJson';

  return (
    <li data-field={entry.field} className="flex flex-col gap-1.5 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {label}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              (
              {entry.required
                ? t('admin.integrations.field.required')
                : t('admin.integrations.field.optional')}
              )
            </span>
          </p>
          <FieldState entry={entry} locale={locale} />
        </div>
        {envLocked ? null : (
          <div className="flex shrink-0 items-center gap-1.5">
            {editing ? (
              <Button
                size="sm"
                onClick={onDiscard}
                disabled={disabled}
                aria-label={`${t('admin.integrations.field.cancelEdit')} ${label}`}
              >
                {t('admin.integrations.field.cancelEdit')}
              </Button>
            ) : (
              <>
                {/* The visible word comes first in the accessible name, then which field. */}
                <Button
                  size="sm"
                  onClick={onEdit}
                  disabled={disabled}
                  aria-label={`${editWord} ${label}`}
                >
                  {editWord}
                </Button>
                {entry.source === 'db' ? (
                  <Button
                    size="sm"
                    onClick={onRemove}
                    disabled={disabled}
                    aria-label={`${t('admin.integrations.field.remove')} ${label}`}
                  >
                    {t('admin.integrations.field.remove')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
      {editing && !envLocked ? (
        <div className="flex items-start gap-1.5">
          {multiline ? (
            <Textarea
              id={inputId}
              aria-label={t('admin.integrations.field.newValue', { label })}
              value={value}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => {
                onChange(event.target.value);
              }}
              className={`w-full font-mono ${entry.secret && !revealed ? '[-webkit-text-security:disc]' : ''}`}
            />
          ) : (
            <Input
              id={inputId}
              aria-label={t('admin.integrations.field.newValue', { label })}
              type={entry.secret && !revealed ? 'password' : 'text'}
              value={value}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => {
                onChange(event.target.value);
              }}
              className="w-full"
            />
          )}
          {entry.secret ? (
            <Button
              size="icon"
              variant="ghost"
              aria-pressed={revealed}
              aria-label={
                revealed ? t('admin.integrations.field.hide') : t('admin.integrations.field.show')
              }
              onClick={onToggle}
            >
              {revealed ? (
                <EyeOff aria-hidden className="size-4" />
              ) : (
                <Eye aria-hidden className="size-4" />
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Never a value: "Set · updated {date} by {name}", or where the environment sets it. */
function FieldState({ entry, locale }: { entry: CredentialFieldStatus; locale: 'th' | 'en' }) {
  const { t } = useI18n();
  if (entry.source === 'env') {
    return (
      <p className="flex items-start gap-1 text-sm text-muted-foreground">
        <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('admin.integrations.field.envLocked', { name: entry.envVar })}</span>
      </p>
    );
  }
  if (entry.source === 'db') {
    const date = entry.updatedAt ? formatDateTime(entry.updatedAt, locale) : null;
    return (
      <p className="text-sm text-muted-foreground">
        {date && entry.updatedBy
          ? t('admin.integrations.field.setBy', { date, name: entry.updatedBy.name })
          : date
            ? t('admin.integrations.field.setAt', { date })
            : t('admin.integrations.field.setPlain')}
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">{t('admin.integrations.field.notSet')}</p>;
}
