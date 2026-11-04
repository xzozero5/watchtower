import { ChannelError, gmail } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import type { EmailJob } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';

import type { WorkerLogger } from '../logger.js';
import type { OutboundChannels } from '../outbound/channels.js';
import type { OutboundMessage } from '../mailer.js';

type CsatJob = Extract<EmailJob, { kind: 'csat_survey' }> & {
  readonly gmail: NonNullable<Extract<EmailJob, { kind: 'csat_survey' }>['gmail']>;
};

export interface CsatGmailDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly channels: OutboundChannels;
  readonly logger: WorkerLogger;
  /** The host of `APP_URL`; the `Message-ID` of the survey is made under it. */
  readonly appHost: string;
}

export type CsatGmailResult =
  | { readonly outcome: 'sent' }
  /** Another attempt already claimed this survey email; nothing was sent now. */
  | { readonly outcome: 'already_claimed' }
  /** The send may have left and may not; it is not repeated (ADR-010 section 6). */
  | { readonly outcome: 'unknown' }
  /** The mailbox is gone; the caller sends the survey over SMTP instead. */
  | { readonly outcome: 'no_mailbox' };

/**
 * Sends a rendered CSAT email from the support mailbox the ticket came in through (T-174). A new
 * thread, not a reply in the ticket's: the survey is its own message with its own subject, and a
 * customer's answer typed into it cannot silently reopen or re-triage a finished ticket. It carries
 * `Auto-Submitted` so an out-of-office reply does not answer it.
 *
 * At most once: the (survey, kind) pair is claimed in `csat_email_dispatch` before the send. A send
 * that certainly did not leave releases the claim and throws, so BullMQ retries; one that may have
 * left keeps the claim and is never repeated (a missing survey beats two).
 */
export async function sendCsatViaGmail(
  deps: CsatGmailDeps,
  job: CsatJob,
  message: OutboundMessage,
): Promise<CsatGmailResult> {
  const { database, domain, logger } = deps;
  const { accountId, surveyId } = job.gmail;
  const kind = job.reminder ? 'reminder' : 'survey';

  const [account] = await database.db
    .select({
      id: schema.channelAccount.id,
      type: schema.channelAccount.type,
      name: schema.channelAccount.name,
    })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, accountId))
    .limit(1);
  if (account?.type !== 'gmail') return { outcome: 'no_mailbox' };

  // Not connected or credentials unreadable: nothing was claimed, so the job simply retries.
  const sender = await deps.channels.gmail(account);
  if (sender === undefined) throw new Error('csat survey: the Gmail mailbox is not connected');

  if (!(await domain.csat.claimEmail(database.db, { surveyId, kind, accountId }))) {
    return { outcome: 'already_claimed' };
  }

  let sent: gmail.GmailSendResult;
  try {
    const input: gmail.GmailSendInput = {
      from: sender.from,
      inReplyTo: {
        messageId: null,
        references: [],
        subject: message.subject,
        from: null,
        replyTo: [],
      },
      to: [{ address: job.to }],
      subject: message.subject,
      textBody: message.text,
      htmlBody: message.html,
      messageId: gmail.makeMessageId(`csat-${surveyId}-${kind}`, deps.appHost),
      subjectMode: 'reuse',
      automatic: true,
    };
    sent = await sender.send(input);
  } catch (error) {
    if (error instanceof gmail.ReplyBuildError) {
      await domain.csat.releaseEmail(database.db, { surveyId, kind, errorCode: 'invalid_message' });
      throw new UnrecoverableError('csat survey: the message could not be built');
    }
    if (
      error instanceof ChannelError &&
      !error.outcomeUnknown &&
      error.kind !== 'invalid_response'
    ) {
      await domain.csat.releaseEmail(database.db, { surveyId, kind, errorCode: error.kind });
      throw error;
    }
    // A timeout, a dropped connection, a 5xx or an unreadable answer may follow a send that worked.
    logger.error(
      { alert: 'csat_email_outcome_unknown', surveyId, kind, accountId },
      'csat survey send may or may not have left; it will not be repeated',
    );
    return { outcome: 'unknown' };
  }
  await domain.csat.finishEmail(database.db, {
    surveyId,
    kind,
    providerMessageId: sent.providerMessageId,
  });
  return { outcome: 'sent' };
}

/** Narrows a parsed email job to a CSAT survey that must go out through Gmail. */
export function isGmailCsatJob(job: EmailJob): job is CsatJob {
  return job.kind === 'csat_survey' && job.gmail !== undefined;
}
