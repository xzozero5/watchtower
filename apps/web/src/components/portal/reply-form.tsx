'use client';

import {
  PORTAL_MAX_DESCRIPTION,
  type PortalReplyResult,
  type PortalTicketView,
} from '@watchtower/shared';
import { Alert, Button, Textarea } from '@watchtower/ui';
import { type SyntheticEvent, useId, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { classifyPortalError } from '@/lib/portal/portal-client';
import { formatWait } from '@/lib/portal/portal-format';
import { usePortalApi } from '@/lib/portal/use-portal';

import { AttachmentPicker, useAttachments } from './attachment-picker';
import { describedBy, FormField } from './form-field';

/** Appends a freshly sent reply to the view the page already has, without waiting for a refetch. */
export function withReply(view: PortalTicketView, result: PortalReplyResult): PortalTicketView {
  return {
    ...view,
    status: result.status,
    statusLabel: result.statusLabel,
    timeline: [
      ...view.timeline,
      {
        kind: 'message',
        id: result.message.id,
        from: 'customer',
        authorName: null,
        body: result.message.body,
        ...(result.message.attachments ? { attachments: result.message.attachments } : {}),
        createdAt: result.message.createdAt,
      },
    ],
  };
}

/**
 * Reply box of the tracking page. A 401 means the link stopped working (`onInvalidLink`), a 409
 * means the ticket was closed or merged meanwhile (`onNotOpen` refreshes the page state).
 */
export function ReplyForm({
  ticketKey,
  token,
  onSent,
  onInvalidLink,
  onNotOpen,
}: {
  ticketKey: string;
  token: string;
  onSent: (result: PortalReplyResult) => void;
  onInvalidLink: () => void;
  onNotOpen: () => void;
}) {
  const { t, locale } = useI18n();
  const api = usePortalApi();
  const id = useId();
  const attachments = useAttachments();
  const [body, setBody] = useState('');
  const [fieldError, setFieldError] = useState<MessageKey | null>(null);
  const [failure, setFailure] = useState<{ key: MessageKey; wait: number | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (sending) return;
    setSent(false);
    setFailure(null);
    const text = body.trim();
    if (text === '') {
      setFieldError('portal.tracking.replyEmpty');
      document.getElementById(id)?.focus();
      return;
    }
    if (text.length > PORTAL_MAX_DESCRIPTION) {
      setFieldError('portal.tracking.replyTooLong');
      document.getElementById(id)?.focus();
      return;
    }
    setFieldError(null);
    setSending(true);
    try {
      const result =
        attachments.files.length === 0
          ? await api.reply(ticketKey, token, { body: text })
          : await api.reply(ticketKey, token, { body: text }, attachments.files);
      setBody('');
      attachments.clear();
      setSent(true);
      onSent(result);
    } catch (error) {
      const classified = classifyPortalError(error);
      if (classified.kind === 'invalidLink') {
        onInvalidLink();
        return;
      }
      if (classified.kind === 'notOpen') onNotOpen();
      setFailure({
        key:
          classified.kind === 'notOpen'
            ? 'portal.tracking.errors.notOpen'
            : classified.kind === 'rateLimited'
              ? 'portal.tracking.errors.rateLimited'
              : classified.kind === 'attachment'
                ? 'portal.tracking.errors.attachment'
                : classified.kind === 'network'
                  ? 'portal.tracking.errors.network'
                  : 'portal.tracking.errors.server',
        wait: classified.retryAfterSeconds,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <FormField
        id={id}
        label={t('portal.tracking.replyLabel')}
        hint={t('portal.tracking.replyHint')}
        error={fieldError ? t(fieldError) : undefined}
      >
        <Textarea
          id={id}
          name="body"
          rows={5}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={describedBy(id, true, fieldError !== null)}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
      </FormField>
      <AttachmentPicker state={attachments} disabled={sending} />
      {failure ? (
        <Alert
          tone="error"
          title={t(failure.key, { time: formatWait(failure.wait ?? 60, locale) })}
        />
      ) : null}
      {sent ? <Alert tone="success" title={t('portal.tracking.replySent')} /> : null}
      <Button
        type="submit"
        variant="primary"
        className="w-full sm:w-auto sm:self-start"
        disabled={sending}
        aria-busy={sending}
      >
        {sending ? t('portal.tracking.replySending') : t('portal.tracking.replySend')}
      </Button>
    </form>
  );
}
