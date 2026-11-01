import {
  ruleClassification,
  type AutomatedVerdict,
  type NormalisedInboundMessage,
} from '@watchtower/domain';
import {
  inboundClassificationSchema,
  type ChannelType,
  type InboundClassification,
} from '@watchtower/shared';

import type { RedactedText } from '@watchtower/ai';

import type { WorkerLogger } from '../logger.js';

/**
 * The optional AI classifier of ingestion (ADR-009 step 4, PRD section 5.1 step 3). It runs outside
 * any database transaction, with a timeout, and anything but a valid answer in time falls back to
 * header rules: ingestion never waits for an LLM and never fails because of one.
 *
 * N4: personal data is redacted before text reaches a model. The input type below carries only
 * `RedactedText`, and the only producer of it is `redact` on the hook, so a classifier cannot be
 * handed the raw subject or body by this code.
 *
 * `RedactedText` is the branded type of `@watchtower/ai` (T-106): a hook implements `redact` with a
 * redaction session (`createRedactor().session({ scope }).redact`). The worker registers
 * `createAiClassifierFactory` (`../ai/classifier-hook.ts`, T-106e), which calls the `classifyTicket`
 * agent; with `AI_PROVIDER=mock` that is the offline dev mock.
 */

export type { RedactedText };

export interface InboundClassifierInput {
  readonly channel: ChannelType;
  readonly subject: RedactedText;
  readonly body: RedactedText;
  /** What the header rules already concluded, so the model can agree or add context. */
  readonly rules: AutomatedVerdict;
}

/**
 * Builds the hook for one message. The scope names the message (`inbound:<account>:<provider id>`):
 * a hook owns one redaction session, so the redaction counts in the `ai_run` row are the session's
 * own and one message's placeholders never mix with another's (SR106-R9).
 */
export type InboundClassifierFactory = (
  scope: string,
  /** Names of the people in the message (the sender), for the session's name dictionary. */
  participants: readonly string[],
) => InboundClassifierHook;

export interface InboundClassifierHook {
  /** Applies PII redaction (Thai ID numbers, phone numbers, emails, names). */
  redact(text: string): RedactedText;
  /** Must honour `signal` where it can; the caller stops waiting at the timeout either way. */
  classify(input: InboundClassifierInput, signal: AbortSignal): Promise<InboundClassification>;
}

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 3000;

/** Longest text handed to a classifier, in characters; the first part of a mail says what it is about. */
const MAX_CLASSIFIER_CHARS = 4000;

export interface ClassifyOptions {
  readonly hook: InboundClassifierHook | undefined;
  readonly timeoutMs: number;
  readonly logger: WorkerLogger;
}

/**
 * The classification for one message: from the hook when it answers in time, else the rules.
 * Returns undefined when there is no hook (the domain then applies the rules itself).
 */
export async function classifyMessage(
  message: NormalisedInboundMessage,
  channel: ChannelType,
  options: ClassifyOptions,
): Promise<InboundClassification | undefined> {
  const { hook } = options;
  if (hook === undefined) return undefined;
  // Header rules already decided "automatic reply": no model call, nothing to spend.
  if (message.automated.disposition === 'auto_reply') return ruleClassification(message.automated);

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const input: InboundClassifierInput = {
      channel,
      subject: hook.redact(message.subject.slice(0, 500)),
      body: hook.redact(message.bodyText.slice(0, MAX_CLASSIFIER_CHARS)),
      rules: message.automated,
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('classifier timeout'));
      }, options.timeoutMs);
    });
    const answer = await Promise.race([hook.classify(input, controller.signal), timeout]);
    return inboundClassificationSchema.parse({ ...answer, source: 'ai' });
  } catch (error) {
    // No message text in the log (N4): the reason is enough to see the fallback happening.
    const reason =
      error instanceof Error && error.message === 'classifier timeout'
        ? 'timeout'
        : error instanceof Error
          ? error.name
          : 'unknown';
    options.logger.warn({ reason }, 'classifier unavailable, using rules');
    return ruleClassification(message.automated);
  } finally {
    clearTimeout(timer);
  }
}
