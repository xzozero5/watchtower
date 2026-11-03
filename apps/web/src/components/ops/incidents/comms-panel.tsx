'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IncidentComm, SendCommResult } from '@watchtower/shared';
import { Button, Dialog, DialogContent, TintChip, Textarea, toast } from '@watchtower/ui';
import { Bot, CircleCheck, CircleX, Send, UserRound } from 'lucide-react';
import { useId, useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { Moment, OpsSkeleton } from '@/components/ops/ops-bits';
import { FormField } from '@/components/portal/form-field';
import { IntroHint } from '@/components/intro-hint';
import { useI18n } from '@/i18n/provider';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useSession, useUserId } from '@/lib/auth/session';
import { describeOpsError } from '@/lib/ops/model';
import { opsKeys, useCommPreview, useIncidentComms } from '@/lib/ops/queries';

/** The comms panel exists for someone who may draft (`incident.create`) or send (`incident.manage`). */
export function canSeeComms(can: (permission: 'incident.create' | 'incident.manage') => boolean) {
  return can('incident.create') || can('incident.manage');
}

/**
 * Customer updates for an incident (R-3.14). A draft goes nowhere. Sending is a person's act (N3):
 * the dialog shows how many customers the update reaches right now, asks for that exact count to
 * be confirmed, and the api refuses if the audience changed in between. Without `incident.manage`
 * the panel can draft but has no Send button, and says who sends.
 */
export function CommsPanel({ incidentId }: { incidentId: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const comms = useIncidentComms(incidentId, true);
  const [sending, setSending] = useState<IncidentComm | null>(null);
  return (
    <section aria-labelledby="comms-heading" className="flex flex-col gap-3">
      <div>
        <h3 id="comms-heading" className="text-sm font-semibold">
          {t('ops.incidents.comms.heading')}
        </h3>
        <IntroHint topic={t('ops.incidents.comms.heading')}>
          {t('ops.incidents.comms.intro')}
        </IntroHint>
      </div>
      {can('incident.create') ? <DraftForm incidentId={incidentId} /> : null}
      {comms.isPending ? (
        <OpsSkeleton rows={2} />
      ) : comms.isError ? (
        <LoadError onRetry={() => void comms.refetch()} />
      ) : comms.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('ops.incidents.comms.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {comms.data.items.map((comm) => (
            <li
              key={comm.id}
              className="flex flex-col gap-2 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                {comm.origin === 'ai' ? (
                  <TintChip tone="violet" icon={Bot}>
                    {t('ops.incidents.comms.origin.ai')}
                  </TintChip>
                ) : (
                  <TintChip tone="slate" icon={UserRound}>
                    {t('ops.incidents.comms.origin.human')}
                  </TintChip>
                )}
                <TintChip
                  tone={
                    comm.status === 'sent'
                      ? 'green'
                      : comm.status === 'cancelled'
                        ? 'slate'
                        : 'amber'
                  }
                  icon={
                    comm.status === 'sent'
                      ? CircleCheck
                      : comm.status === 'cancelled'
                        ? CircleX
                        : Send
                  }
                >
                  {t(`ops.incidents.comms.status.${comm.status}`)}
                </TintChip>
                <span className="text-xs text-muted-foreground">
                  <Moment iso={comm.sentAt ?? comm.createdAt} />
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words">{comm.body}</p>
              {comm.status === 'sent' && comm.confirmedRecipients !== null ? (
                <p className="text-muted-foreground">
                  {t('ops.incidents.comms.sentTo', { count: comm.confirmedRecipients })}
                </p>
              ) : null}
              {comm.status === 'draft' || comm.status === 'sending' ? (
                can('incident.manage') ? (
                  <div>
                    <Button
                      onClick={() => {
                        setSending(comm);
                      }}
                    >
                      {comm.status === 'sending'
                        ? t('ops.incidents.comms.finish')
                        : t('ops.incidents.comms.review')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground">{t('ops.incidents.comms.leadSends')}</p>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {sending ? (
        <SendDialog
          incidentId={incidentId}
          comm={sending}
          onClose={() => {
            setSending(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DraftForm({ incidentId }: { incidentId: string }) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const draft = useMutation({
    mutationFn: () => api.draftIncidentComm(incidentId, { body: body.trim() }),
    onSuccess: async () => {
      setBody('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).incident(incidentId) });
      toast(t('ops.incidents.comms.drafted'));
    },
    onError: (e) => {
      setError(describeOpsError(e, t).message);
    },
  });
  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim() === '') {
          setError(t('ops.common.required'));
          return;
        }
        draft.mutate();
      }}
    >
      <FormField
        id={`${base}-body`}
        label={t('ops.incidents.comms.draftLabel')}
        hint={t('ops.incidents.comms.draftHint')}
        {...(error ? { error } : {})}
      >
        <Textarea
          id={`${base}-body`}
          rows={4}
          maxLength={5000}
          value={body}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${base}-body-hint${error ? ` ${base}-body-error` : ''}`}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
      </FormField>
      <div>
        <Button type="submit" disabled={draft.isPending}>
          {draft.isPending ? t('ops.common.saving') : t('ops.incidents.comms.saveDraft')}
        </Button>
      </div>
    </form>
  );
}

function SendDialog({
  incidentId,
  comm,
  onClose,
}: {
  incidentId: string;
  comm: IncidentComm;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const preview = useCommPreview(incidentId, true);
  // The count the person ticked. A different number later (the audience moved) is not confirmed.
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SendCommResult | null>(null);
  const recipients = preview.data?.recipients ?? null;
  const confirmed = recipients !== null && confirmedCount === recipients;

  const send = useMutation({
    mutationFn: (count: number) =>
      api.sendIncidentComm(incidentId, comm.id, { confirmRecipients: count }),
    onSuccess: async (sent) => {
      setResult(sent);
      await queryClient.invalidateQueries({ queryKey: opsKeys(userId).incident(incidentId) });
    },
    onError: (error) => {
      setConfirmedCount(null);
      if (isApiError(error) && error.status === 409) {
        // The audience moved (or somebody sent it first): read the number again and ask again.
        setMessage(t('ops.incidents.comms.audienceChanged'));
        void preview.refetch();
        void queryClient.invalidateQueries({ queryKey: opsKeys(userId).comms(incidentId) });
        return;
      }
      setMessage(describeOpsError(error, t).message);
    },
  });

  const ready = recipients !== null && recipients > 0 && confirmed && !send.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !send.isPending) {
          void queryClient.invalidateQueries({ queryKey: opsKeys(userId).comms(incidentId) });
          onClose();
        }
      }}
    >
      <DialogContent
        title={t('ops.incidents.comms.sendTitle')}
        description={t('ops.incidents.comms.sendDescription')}
        closeLabel={t('ops.common.close')}
        footer={
          result ? (
            <Button variant="primary" onClick={onClose}>
              {t('ops.common.close')}
            </Button>
          ) : (
            <>
              <Button onClick={onClose} disabled={send.isPending}>
                {t('ops.common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!ready}
                onClick={() => {
                  if (recipients !== null) send.mutate(recipients);
                }}
              >
                {send.isPending
                  ? t('ops.incidents.comms.sending')
                  : recipients !== null
                    ? t('ops.incidents.comms.sendTo', { count: recipients })
                    : t('ops.incidents.comms.send')}
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-3 px-5 py-3 text-sm">
          <blockquote className="max-h-40 overflow-y-auto rounded-md bg-surface-muted px-3 py-2 whitespace-pre-wrap break-words">
            {comm.body}
          </blockquote>
          {result ? (
            <p role="status" className="font-medium">
              {t('ops.incidents.comms.result', {
                sent: result.sent,
                recipients: result.recipients,
                failed: result.failed,
              })}
            </p>
          ) : preview.isPending || preview.isFetching ? (
            <p role="status">{t('ops.incidents.comms.countLoading')}</p>
          ) : preview.isError ? (
            <LoadError onRetry={() => void preview.refetch()} />
          ) : (
            <>
              <p className="text-base font-semibold" data-testid="recipient-count">
                {t('ops.incidents.comms.count', { count: preview.data.recipients })}
              </p>
              <p className="text-muted-foreground">
                {t('ops.incidents.comms.skipped', {
                  channel: preview.data.skippedChannel,
                  closed: preview.data.skippedClosed,
                })}
              </p>
              {preview.data.recipients === 0 ? (
                <p>{t('ops.incidents.comms.nobody')}</p>
              ) : (
                <label className="flex items-start gap-2" htmlFor={`${base}-confirm`}>
                  <input
                    id={`${base}-confirm`}
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={confirmed}
                    onChange={(event) => {
                      setConfirmedCount(event.target.checked ? preview.data.recipients : null);
                    }}
                  />
                  <span>
                    {t('ops.incidents.comms.confirm', { count: preview.data.recipients })}
                  </span>
                </label>
              )}
            </>
          )}
          {message ? (
            <p role="alert" className="font-medium text-danger">
              {message}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
