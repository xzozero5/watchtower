import type { ChannelType, InboundClassification, InboundDisposition } from '@watchtower/shared';

/**
 * What the domain needs to know about a received message, whatever the channel. The worker builds
 * it from the output of a channel adapter (`packages/channels`, which the domain must not import),
 * so every field is plain data.
 */

/** Where a conversation can be recognised from, in priority order (PRD R-2.3). */
export const THREAD_CANDIDATE_KINDS = [
  'gmail_thread_id',
  'in_reply_to',
  'references',
  'subject_token',
  'line_conversation',
] as const;
export type ThreadCandidateKind = (typeof THREAD_CANDIDATE_KINDS)[number];

export interface ThreadCandidate {
  readonly kind: ThreadCandidateKind;
  /** `gmail_thread_id`: the id. `in_reply_to` / `references`: normalised Message-ID. `subject_token`: `OPS-12`. `line_conversation`: user, group or room id. */
  readonly value: string;
}

/** An attachment already stored in object storage (`objectKey`), or only described (null). */
export interface InboundAttachment {
  readonly partId: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly objectKey: string | null;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId: string | null;
  readonly referencedByHtml: boolean;
}

/** What the adapter's header rules concluded (Gmail `classifyAutomated`; LINE: stickers are noise). */
export interface AutomatedVerdict {
  readonly disposition: 'human' | 'auto_reply' | 'noise';
  readonly subtype: string;
  readonly signals: readonly string[];
}

export interface NormalisedInboundMessage {
  readonly channelAccountId: string;
  /** Gmail message id, LINE message id: with the account it is the dedupe key (R-2.2). */
  readonly providerMessageId: string;
  /** Normalised RFC 5322 Message-ID: the secondary dedupe key and the target of In-Reply-To. */
  readonly rfc822MessageId: string | null;
  /** Conversation key stored on the ticket's message: `gmail:<threadId>`, `msgid:<root>`, `line:<id>`. */
  readonly threadKey: string | null;
  readonly threadCandidates: readonly ThreadCandidate[];
  readonly from: {
    readonly address: string | null;
    readonly name: string | null;
    readonly lineUserId: string | null;
  };
  /** Empty for channels without subjects (LINE); the ticket then gets `subjectFallback`. */
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  /** Email only: the header block (From / To / Cc / Subject) for the timeline. */
  readonly emailMeta?: Record<string, unknown> | null | undefined;
  readonly attachments: readonly InboundAttachment[];
  readonly receivedAt: Date;
  readonly rawObjectKey: string | null;
  readonly automated: AutomatedVerdict;
  /**
   * LINE only: the single-use token that lets the dispatcher answer for free (ADR-010 section 6).
   * The domain seals it before it is stored; it is never logged or put in an audit row.
   */
  readonly replyToken?: string | null | undefined;
}

export interface IngestInboundInput {
  readonly message: NormalisedInboundMessage;
  /** The `inbound_event` that brought it, when there is one. */
  readonly inboundEventId?: string | null;
  /** From the classifier (or the rule fallback). Absent means rules only, `triage`. */
  readonly classification?: InboundClassification | undefined;
}

export type ThreadMatchKind = ThreadCandidateKind | 'subject_heuristic';

export interface IngestOutcome {
  readonly inboundMessageId: string;
  readonly disposition: Exclude<InboundDisposition, 'pending'>;
  readonly ticketId: string | null;
  readonly ticketKey: string | null;
  /** The `message` row the text was saved as (ticket and appended only). */
  readonly messageId: string | null;
  /** How the ticket was found when the message joined one. */
  readonly matchedBy: ThreadMatchKind | null;
  /** The message was already handled by an earlier run (a redelivery or a job retry): nothing was written. */
  readonly alreadyIngested: boolean;
  /** Same mail under a second provider id: it follows the first and writes nothing new. */
  readonly duplicateOf: string | null;
  /** A resolved ticket was reopened by this message. */
  readonly reopened: boolean;
  /** The channel type of the account (`gmail`, `line`). */
  readonly channel: ChannelType;
}
