import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { loadFixture } from './__fixtures__/load.js';
import { classifyAutomated, type AutomatedVerdict } from './classify.js';
import { parseHeaderBlock } from './mime.js';
import { normalizeMime } from './normalize.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

function classifyFixture(name: string, labelIds?: readonly string[]): AutomatedVerdict {
  const result = normalizeMime(loadFixture(name));
  return classifyAutomated({
    headers: result.headers,
    rootContentType: result.rootContentType,
    rootContentTypeParams: result.rootContentTypeParams,
    subject: result.email.subject,
    deliveryStatusParts: result.deliveryStatusParts,
    ...(labelIds === undefined ? {} : { labelIds }),
  });
}

function classifyHeaders(
  block: string,
  subject = 'hello',
  labelIds?: readonly string[],
): AutomatedVerdict {
  return classifyAutomated({
    headers: parseHeaderBlock(block),
    rootContentType: 'text/plain',
    rootContentTypeParams: {},
    subject,
    ...(labelIds === undefined ? {} : { labelIds }),
  });
}

describe('classifyAutomated: fixtures', () => {
  it('a person writing is human and may get an auto-ack', () => {
    const verdict = classifyFixture('plain-ascii.eml');
    expect(verdict).toMatchObject({
      disposition: 'human',
      subtype: 'none',
      suppressAutoAck: false,
      suspect: false,
    });
  });

  it('a customer reply in a thread is human', () => {
    expect(classifyFixture('reply-in-thread.eml').disposition).toBe('human');
  });

  it('a DSN (multipart/report) is a bounce and carries the failed recipient', () => {
    const verdict = classifyFixture('bounce-dsn.eml');
    expect(verdict).toMatchObject({
      disposition: 'auto_reply',
      subtype: 'bounce',
      suppressAutoAck: true,
      dsn: { action: 'failed', status: '5.1.1', finalRecipient: 'nobody@gone.example.com' },
    });
    expect(verdict.signals).toContain('content_type:multipart/report');
  });

  it('Auto-Submitted: auto-replied is an out-of-office style reply', () => {
    const verdict = classifyFixture('out-of-office.eml');
    expect(verdict).toMatchObject({ disposition: 'auto_reply', subtype: 'out_of_office' });
    expect(verdict.signals).toContain('header:auto-submitted=auto-replied');
  });

  it('a newsletter with List-Unsubscribe is noise, not an auto-reply', () => {
    const verdict = classifyFixture('newsletter.eml');
    expect(verdict).toMatchObject({
      disposition: 'noise',
      subtype: 'mailing_list',
      suppressAutoAck: true,
    });
  });

  it('Precedence: bulk alone is an auto-reply per R-2.6', () => {
    expect(classifyFixture('precedence-bulk.eml')).toMatchObject({
      disposition: 'auto_reply',
      subtype: 'precedence_bulk',
    });
  });

  it('a customer talking about automatic replies is a plain human message', () => {
    expect(classifyFixture('subject-only-ooo.eml')).toMatchObject({
      disposition: 'human',
      suspect: false,
      suppressAutoAck: false,
    });
  });
});

describe('classifyAutomated: headers', () => {
  it('Auto-Submitted: no is a normal message', () => {
    expect(classifyHeaders('From: a@example.com\r\nAuto-Submitted: no').disposition).toBe('human');
  });

  it.each([
    ['Auto-Submitted: auto-generated', 'auto_submitted'],
    ['Auto-Submitted: auto-notified', 'auto_submitted'],
    ['Auto-Submitted: auto-replied; comment=x', 'out_of_office'],
    ['X-Autoreply: yes', 'out_of_office'],
    ['X-Autorespond: yes', 'out_of_office'],
    ['X-Auto-Response: vacation', 'out_of_office'],
    ['Precedence: auto_reply', 'out_of_office'],
    ['Precedence: bulk', 'precedence_bulk'],
    ['Precedence: junk', 'precedence_bulk'],
    ['X-Failed-Recipients: gone@example.com', 'bounce'],
    ['Return-Path: <>', 'bounce'],
  ])('%s -> auto_reply/%s', (header, subtype) => {
    const verdict = classifyHeaders(`From: a@example.com\r\n${header}`);
    expect(verdict.disposition).toBe('auto_reply');
    expect(verdict.subtype).toBe(subtype);
    expect(verdict.suppressAutoAck).toBe(true);
  });

  it('classifies mailer-daemon and postmaster senders as bounces', () => {
    expect(classifyHeaders('From: MAILER-DAEMON@mx.example.com').subtype).toBe('bounce');
    expect(classifyHeaders('From: Postmaster <postmaster@mx.example.com>').subtype).toBe('bounce');
  });

  it('classifies a read receipt (multipart/report, other report-type) as automatic', () => {
    const verdict = classifyAutomated({
      headers: parseHeaderBlock('From: a@example.com'),
      rootContentType: 'multipart/report',
      rootContentTypeParams: { 'report-type': 'disposition-notification' },
      subject: 'Read: hi',
    });
    expect(verdict).toMatchObject({ disposition: 'auto_reply', subtype: 'auto_submitted' });
  });

  it.each([
    'List-Id: <x.example.com>',
    'List-Unsubscribe: <mailto:u@example.com>',
    'List-Post: NO',
  ])('%s -> noise/mailing_list', (header) => {
    expect(classifyHeaders(`From: a@example.com\r\n${header}`)).toMatchObject({
      disposition: 'noise',
      subtype: 'mailing_list',
    });
  });

  it.each(['no-reply', 'noreply', 'do-not-reply', 'donotreply', 'no_reply'])(
    'sender %s@ is noise/no_reply_sender',
    (local) => {
      expect(classifyHeaders(`From: ${local}@vendor.example.com`)).toMatchObject({
        disposition: 'noise',
        subtype: 'no_reply_sender',
      });
    },
  );

  it('does not treat a normal sender containing "reply" as a no-reply address', () => {
    expect(classifyHeaders('From: replyto@vendor.example.com').disposition).toBe('human');
  });

  it.each([
    'SPAM',
    'CATEGORY_PROMOTIONS',
    'CATEGORY_SOCIAL',
    'CATEGORY_UPDATES',
    'CATEGORY_FORUMS',
  ])('Gmail label %s is noise', (label) => {
    expect(classifyHeaders('From: a@example.com', 'hi', ['INBOX', label])).toMatchObject({
      disposition: 'noise',
      subtype: 'gmail_category',
    });
  });

  it('CATEGORY_PERSONAL and INBOX alone are human', () => {
    expect(
      classifyHeaders('From: a@example.com', 'hi', ['INBOX', 'CATEGORY_PERSONAL']).disposition,
    ).toBe('human');
  });

  it('a bounce wins over an auto-reply header', () => {
    expect(
      classifyHeaders('From: mailer-daemon@mx.example.com\r\nAuto-Submitted: auto-replied').subtype,
    ).toBe('bounce');
  });

  it.each([
    'Out of Office: back Monday',
    'Automatic reply: Re: ticket',
    'Auto: away',
    'Undeliverable: Re: ticket',
    'ตอบกลับอัตโนมัติ: ไม่อยู่ที่ออฟฟิศ',
  ])('subject "%s" alone only sets suspect', (subject) => {
    expect(classifyHeaders('From: a@example.com', subject)).toMatchObject({
      disposition: 'human',
      suspect: true,
    });
  });
});
