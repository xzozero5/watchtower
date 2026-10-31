import { describe, expect, it } from 'vitest';

import { FAKE_USAGE, parseFakeInbound } from './fake-args.js';

describe('parseFakeInbound', () => {
  it('reads a Gmail message with threading headers', () => {
    expect(
      parseFakeInbound([
        'gmail',
        '--from',
        'a@customer.example.test',
        '--subject',
        'ระบบล่ม',
        '--body',
        'ช่วยด้วยครับ',
        '--thread',
        't1',
        '--in-reply-to',
        'parent@x.example.test',
        '--references',
        'root@x.example.test,parent@x.example.test',
        '--kind',
        'auto_reply',
      ]),
    ).toEqual({
      channel: 'gmail',
      from: 'a@customer.example.test',
      subject: 'ระบบล่ม',
      body: 'ช่วยด้วยครับ',
      kind: 'auto_reply',
      threadId: 't1',
      inReplyTo: 'parent@x.example.test',
      references: ['root@x.example.test', 'parent@x.example.test'],
    });
  });

  it('reads a LINE text message', () => {
    expect(parseFakeInbound(['line', '--user', 'U1', '--text', 'สวัสดี'])).toEqual({
      channel: 'line',
      userId: 'U1',
      text: 'สวัสดี',
    });
  });

  it.each([
    [[]],
    [['sms', '--from', 'x']],
    [['gmail', '--from', 'a@x.example.test', '--subject', 's']],
    [['gmail', '--from', 'a@x.example.test', '--subject', 's', '--body', 'b', '--kind', 'spam']],
    [['line', '--user', 'U1']],
    [['line', '--user', 'U1', '--text', 't', '--unknown-flag', 'x']],
  ])('answers usage for %j', (argv) => {
    expect(parseFakeInbound(argv)).toBe(FAKE_USAGE);
  });
});
