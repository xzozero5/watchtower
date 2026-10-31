import { ChannelError } from '../common/errors.js';
import { parseHeaderBlock, parseMessageIds, type HeaderBag } from './mime.js';
import { normalizeMessageId } from './threads.js';
import {
  gmailHistoryPageSchema,
  gmailMessageListSchema,
  gmailMessageSchema,
  gmailSendResponseSchema,
  gmailWatchResponseSchema,
  type GetMessageRequest,
  type GmailHistoryPage,
  type GmailHistoryRecord,
  type GmailMessage,
  type GmailMessageList,
  type GmailSendResponse,
  type GmailTransport,
  type GmailWatchResponse,
  type ListHistoryRequest,
  type ListMessagesRequest,
  type SendMessageRequest,
  type WatchRequest,
} from './transport.js';

/**
 * In-memory Gmail mailbox. Behaves like the parts of the API the adapter relies on:
 * monotonically increasing history ids, `history.list` returning records after the start id and
 * 404 once the start id has been "expired", `messages.send` honouring `threadId`, `watch`
 * returning a seven-day expiry. It never touches the network.
 */

export interface FakeGmailOptions {
  readonly now?: () => Date;
  /** First history id of an empty mailbox. Default 1000. */
  readonly initialHistoryId?: number;
  /** Mailbox address, only used to label sent mail. */
  readonly emailAddress?: string;
}

export interface DeliverOptions {
  readonly labelIds?: readonly string[];
  /** Force a thread (used to simulate Gmail's own threading). */
  readonly threadId?: string;
  readonly internalDate?: Date;
}

interface StoredMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly historyId: string;
  readonly internalDate: string;
  readonly raw: Uint8Array;
  readonly messageIdKey: string | null;
}

export type FakeGmailCall =
  | { readonly op: 'listHistory'; readonly request: ListHistoryRequest }
  | { readonly op: 'listMessages'; readonly request: ListMessagesRequest }
  | { readonly op: 'getMessage'; readonly request: GetMessageRequest }
  | { readonly op: 'sendMessage'; readonly threadId: string | undefined }
  | { readonly op: 'watch'; readonly request: WatchRequest }
  | { readonly op: 'stopWatch' };

const WATCH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

function fail(
  operation: string,
  kind: 'not_found' | 'client',
  status: number,
  code: string,
): never {
  throw new ChannelError({ provider: 'gmail', operation, kind, status, code });
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    fail('users.messages.send', 'client', 400, 'invalidArgument');
  }
  return Uint8Array.from(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function headersOf(raw: Uint8Array): HeaderBag {
  const text = Buffer.from(raw).toString('latin1');
  const end = /\r?\n\r?\n/.exec(text);
  return parseHeaderBlock(end === null ? text : text.slice(0, end.index));
}

export class FakeGmailTransport implements GmailTransport {
  readonly calls: FakeGmailCall[] = [];
  readonly #now: () => Date;
  readonly #messages: StoredMessage[] = [];
  readonly #history: { readonly record: GmailHistoryRecord; readonly numericId: number }[] = [];
  #historyCounter: number;
  #oldestValidHistoryId: number;
  #messageCounter = 0;
  #threadCounter = 0;
  #watch: { topicName: string; expiration: string } | null = null;
  readonly #failures: { operation: string; error: ChannelError }[] = [];

  constructor(options: FakeGmailOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#historyCounter = options.initialHistoryId ?? 1000;
    this.#oldestValidHistoryId = this.#historyCounter;
  }

  // -- test controls --------------------------------------------------------------------------

  /** Simulates a message arriving in the mailbox. Returns the ids Gmail would assign. */
  deliver(raw: string | Uint8Array, options: DeliverOptions = {}): GmailMessage {
    const bytes = typeof raw === 'string' ? Uint8Array.from(Buffer.from(raw, 'utf8')) : raw;
    return this.#store(bytes, options.labelIds ?? ['INBOX', 'UNREAD'], options);
  }

  /** After this, `listHistory` with a start id below `historyId` rejects with 404. */
  expireHistoryBefore(historyId: string): void {
    this.#oldestValidHistoryId = Number(historyId);
  }

  /** Makes the next call to `operation` (for example `users.history.list`) throw `error`. */
  failNext(operation: string, error: ChannelError): void {
    this.#failures.push({ operation, error });
  }

  get currentHistoryId(): string {
    return String(this.#historyCounter);
  }

  get watchState(): { readonly topicName: string; readonly expiration: string } | null {
    return this.#watch;
  }

  /** Messages sent through `sendMessage`, oldest first. */
  get sent(): readonly GmailMessage[] {
    return this.#messages
      .filter((m) => m.labelIds.includes('SENT'))
      .map((m) => this.#view(m, 'raw'));
  }

  // -- GmailTransport -------------------------------------------------------------------------

  listHistory(request: ListHistoryRequest): Promise<GmailHistoryPage> {
    this.calls.push({ op: 'listHistory', request });
    return this.#run('users.history.list', () => {
      const start = Number(request.startHistoryId);
      if (!Number.isInteger(start) || start < 0)
        fail('users.history.list', 'client', 400, 'invalidArgument');
      if (start < this.#oldestValidHistoryId)
        fail('users.history.list', 'not_found', 404, 'notFound');

      const wanted = new Set(request.historyTypes ?? []);
      let records = this.#history
        .filter((entry) => entry.numericId > start)
        .map((entry) => entry.record);
      if (wanted.size > 0) {
        records = records.filter(
          (record) =>
            (wanted.has('messageAdded') && record.messagesAdded !== undefined) ||
            (wanted.has('messageDeleted') && record.messagesDeleted !== undefined) ||
            (wanted.has('labelAdded') && record.labelsAdded !== undefined) ||
            (wanted.has('labelRemoved') && record.labelsRemoved !== undefined),
        );
      }
      if (request.labelId !== undefined) {
        const labelId = request.labelId;
        records = records.filter((record) =>
          (record.messagesAdded ?? []).some((added) => added.message.labelIds.includes(labelId)),
        );
      }
      const size = Math.min(request.maxResults ?? PAGE_DEFAULT, PAGE_MAX);
      const offset = request.pageToken === undefined ? 0 : Number(request.pageToken);
      const page = records.slice(offset, offset + size);
      const next = offset + size < records.length ? String(offset + size) : undefined;
      return gmailHistoryPageSchema.parse({
        history: page,
        ...(next === undefined ? {} : { nextPageToken: next }),
        historyId: String(this.#historyCounter),
      });
    });
  }

  listMessages(request: ListMessagesRequest): Promise<GmailMessageList> {
    this.calls.push({ op: 'listMessages', request });
    return this.#run('users.messages.list', () => {
      let items = [...this.#messages].reverse(); // newest first, like Gmail
      const labelIds = request.labelIds ?? [];
      if (labelIds.length > 0)
        items = items.filter((m) => labelIds.every((l) => m.labelIds.includes(l)));
      if (request.includeSpamTrash !== true) {
        items = items.filter((m) => !m.labelIds.includes('SPAM') && !m.labelIds.includes('TRASH'));
      }
      const size = Math.min(request.maxResults ?? PAGE_DEFAULT, PAGE_MAX);
      const offset = request.pageToken === undefined ? 0 : Number(request.pageToken);
      const page = items.slice(offset, offset + size);
      const next = offset + size < items.length ? String(offset + size) : undefined;
      return gmailMessageListSchema.parse({
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(next === undefined ? {} : { nextPageToken: next }),
        resultSizeEstimate: items.length,
      });
    });
  }

  getMessage(request: GetMessageRequest): Promise<GmailMessage> {
    this.calls.push({ op: 'getMessage', request });
    return this.#run('users.messages.get', () => {
      const found = this.#messages.find((m) => m.id === request.id);
      if (found === undefined) fail('users.messages.get', 'not_found', 404, 'notFound');
      return this.#view(found, request.format);
    });
  }

  sendMessage(request: SendMessageRequest): Promise<GmailSendResponse> {
    this.calls.push({ op: 'sendMessage', threadId: request.threadId });
    return this.#run('users.messages.send', () => {
      const bytes = base64UrlDecode(request.raw);
      if (bytes.length === 0) fail('users.messages.send', 'client', 400, 'invalidArgument');
      if (
        request.threadId !== undefined &&
        !this.#messages.some((m) => m.threadId === request.threadId)
      ) {
        fail('users.messages.send', 'not_found', 404, 'notFound');
      }
      const stored = this.#store(bytes, ['SENT'], {
        ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      });
      return gmailSendResponseSchema.parse({
        id: stored.id,
        threadId: stored.threadId,
        labelIds: stored.labelIds,
      });
    });
  }

  watch(request: WatchRequest): Promise<GmailWatchResponse> {
    this.calls.push({ op: 'watch', request });
    return this.#run('users.watch', () => {
      if (!/^projects\/[^/]+\/topics\/[^/]+$/.test(request.topicName)) {
        fail('users.watch', 'client', 400, 'invalidArgument');
      }
      const expiration = String(this.#now().getTime() + WATCH_LIFETIME_MS);
      this.#watch = { topicName: request.topicName, expiration };
      return gmailWatchResponseSchema.parse({
        historyId: String(this.#historyCounter),
        expiration,
      });
    });
  }

  stopWatch(): Promise<void> {
    this.calls.push({ op: 'stopWatch' });
    return this.#run('users.stop', () => {
      this.#watch = null;
    });
  }

  // -- internals ------------------------------------------------------------------------------

  #run<T>(operation: string, work: () => T): Promise<T> {
    const index = this.#failures.findIndex((failure) => failure.operation === operation);
    if (index >= 0) {
      const [failure] = this.#failures.splice(index, 1);
      if (failure !== undefined) return Promise.reject(failure.error);
    }
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('unknown'));
    }
  }

  #store(raw: Uint8Array, labelIds: readonly string[], options: DeliverOptions): GmailMessage {
    const headers = headersOf(raw);
    const ownId = parseMessageIds(headers.get('message-id'))[0];
    const related = [
      ...parseMessageIds(headers.get('in-reply-to')),
      ...parseMessageIds(headers.get('references')),
    ].map(normalizeMessageId);

    let threadId = options.threadId;
    if (threadId === undefined) {
      const parent = this.#messages.find(
        (m) => m.messageIdKey !== null && related.includes(m.messageIdKey),
      );
      threadId = parent?.threadId;
    }
    if (threadId === undefined) {
      this.#threadCounter += 1;
      threadId = `t${this.#threadCounter.toString(16).padStart(6, '0')}`;
    }

    this.#messageCounter += 1;
    this.#historyCounter += 1;
    const stored: StoredMessage = {
      id: `m${this.#messageCounter.toString(16).padStart(6, '0')}`,
      threadId,
      labelIds,
      historyId: String(this.#historyCounter),
      internalDate: String((options.internalDate ?? this.#now()).getTime()),
      raw,
      messageIdKey: ownId === undefined ? null : normalizeMessageId(ownId),
    };
    this.#messages.push(stored);
    this.#history.push({
      numericId: this.#historyCounter,
      record: {
        id: stored.historyId,
        messagesAdded: [{ message: { id: stored.id, threadId, labelIds: [...labelIds] } }],
      },
    });
    return this.#view(stored, 'minimal');
  }

  #view(message: StoredMessage, format: GetMessageRequest['format']): GmailMessage {
    return gmailMessageSchema.parse({
      id: message.id,
      threadId: message.threadId,
      labelIds: [...message.labelIds],
      historyId: message.historyId,
      internalDate: message.internalDate,
      sizeEstimate: message.raw.length,
      ...(format === 'raw' ? { raw: base64UrlEncode(message.raw) } : {}),
    });
  }
}
