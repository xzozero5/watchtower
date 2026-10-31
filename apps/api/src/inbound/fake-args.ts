import { parseArgs } from 'node:util';

import type { FakeInbound } from './fake-channel.js';

export const FAKE_USAGE = [
  'usage: inbound-fake.js gmail --from <address> --subject <text> --body <text> [--name <text>]',
  '                              [--thread <id>] [--message-id <id>] [--in-reply-to <id>]',
  '                              [--references <id,id>] [--kind person|auto_reply|newsletter]',
  '       inbound-fake.js line --user <LINE user id> --text <text> [--conversation <id>]',
].join('\n');

const KINDS = ['person', 'auto_reply', 'newsletter'] as const;

export function parseFakeInbound(argv: readonly string[]): FakeInbound | string {
  const [channel, ...rest] = argv;
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        from: { type: 'string' },
        name: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        html: { type: 'string' },
        thread: { type: 'string' },
        'message-id': { type: 'string' },
        'in-reply-to': { type: 'string' },
        references: { type: 'string' },
        kind: { type: 'string' },
        user: { type: 'string' },
        text: { type: 'string' },
        conversation: { type: 'string' },
      },
      strict: true,
    }));
  } catch {
    return FAKE_USAGE;
  }
  const text = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  if (channel === 'gmail') {
    const from = text('from');
    const subject = text('subject');
    const body = text('body');
    const kind = text('kind') ?? 'person';
    if (from === undefined || subject === undefined || body === undefined) return FAKE_USAGE;
    if (!(KINDS as readonly string[]).includes(kind)) return FAKE_USAGE;
    const references = text('references');
    return {
      channel: 'gmail',
      from,
      subject,
      body,
      kind: kind as (typeof KINDS)[number],
      ...(text('name') === undefined ? {} : { fromName: text('name') ?? '' }),
      ...(text('html') === undefined ? {} : { html: text('html') ?? '' }),
      ...(text('thread') === undefined ? {} : { threadId: text('thread') ?? '' }),
      ...(text('message-id') === undefined ? {} : { messageId: text('message-id') ?? '' }),
      ...(text('in-reply-to') === undefined ? {} : { inReplyTo: text('in-reply-to') ?? '' }),
      ...(references === undefined ? {} : { references: references.split(',') }),
    };
  }
  if (channel === 'line') {
    const userId = text('user');
    const message = text('text');
    if (userId === undefined || message === undefined) return FAKE_USAGE;
    return {
      channel: 'line',
      userId,
      text: message,
      ...(text('conversation') === undefined ? {} : { conversationId: text('conversation') ?? '' }),
    };
  }
  return FAKE_USAGE;
}
