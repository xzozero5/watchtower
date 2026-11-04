import { describe, expect, it } from 'vitest';

import {
  composeAutoSendText,
  countPlaceholders,
  customerWantsHuman,
  disclosureFor,
  instanceOrigins,
  linksAllowed,
  senderAuthenticated,
} from './autosend-text.js';

const ORIGINS = ['https://desk.example.test'];
const verified = { verifiedAt: new Date(), lineVerifiedAt: null };

describe('links in an automatic reply (ADR-025 condition 9)', () => {
  it('allows no link, and links to this instance only', () => {
    expect(linksAllowed('Please reset your password on the sign in page.', ORIGINS)).toBe(true);
    expect(linksAllowed('See https://desk.example.test/portal/kb/12 for the steps.', ORIGINS)).toBe(
      true,
    );
    expect(linksAllowed('See https://desk.example.test/portal.', ORIGINS)).toBe(true);
  });

  it('refuses any other host, scheme, credential, lookalike or bare domain', () => {
    for (const text of [
      'See https://evil.example/reset',
      'See http://desk.example.test.evil.example/x',
      'See https://user:pass@desk.example.test/x',
      'See ftp://desk.example.test/x',
      'See javascript:alert(1)//desk.example.test',
      'Go to evil.example/reset',
      'Go to www.example.com',
      'Write to attacker@evil.example',
      'See https://desk.example.test:8443/x',
      'See http://desk.example.test/x',
    ]) {
      expect(linksAllowed(text, ORIGINS), text).toBe(false);
    }
  });

  it('allows nothing when the instance has no known origin', () => {
    expect(linksAllowed('See https://desk.example.test/x', [])).toBe(false);
    expect(linksAllowed('No link at all.', [])).toBe(true);
  });

  it('reads origins from the addresses the instance knows and ignores bad ones', () => {
    expect(instanceOrigins('https://Desk.Example.test/portal', undefined, '', 'not a url')).toEqual(
      ['https://desk.example.test'],
    );
  });
});

describe('placeholders', () => {
  it('counts redaction tokens and unfilled template slots', () => {
    expect(countPlaceholders('Hello, this is a plain reply.')).toBe(0);
    expect(countPlaceholders('Mail [EMAIL_1] and call [PHONE_2].')).toBe(2);
    expect(countPlaceholders('Dear {{name}}, [[x]] and <customer name> and [YOUR NAME]')).toBe(4);
    expect(countPlaceholders('Use the [Reset] button.')).toBe(0);
  });
});

describe('the customer asked for a person', () => {
  it('is found in English and Thai', () => {
    for (const text of [
      'I want to speak to a human please',
      'Can I talk to someone?',
      'get me a real person',
      'are you a bot? I am not talking to a bot',
      'ขอคุยกับเจ้าหน้าที่หน่อย',
      'ขอคุยกับคนจริงๆ',
      'ไม่ใช่บอท ขอพนักงาน',
    ]) {
      expect(customerWantsHuman([text]), text).toBe(true);
    }
  });

  it('is not triggered by an ordinary question', () => {
    for (const text of [
      'How do I reset my password?',
      'The human resources module shows an error',
      'รีเซ็ตรหัสผ่านยังไงครับ',
    ]) {
      expect(customerWantsHuman([text]), text).toBe(false);
    }
    expect(customerWantsHuman([])).toBe(false);
  });
});

describe('the notice that the reply is automatic (owner decision 3)', () => {
  it('is added by default, in the language of the reply', () => {
    expect(composeAutoSendText('You can reset it.', undefined, 'en')).toMatch(
      /^You can reset it\.\n\nThis reply was sent automatically/,
    );
    expect(composeAutoSendText('รีเซ็ตได้เลย', undefined, 'th')).toMatch(
      /^รีเซ็ตได้เลย\n\nข้อความนี้ส่งโดยระบบอัตโนมัติ/,
    );
  });

  it('uses the head text, or nothing when the head turned it off', () => {
    const setting = { enabled: true, text: { th: 'ตอบโดย AI', en: 'Sent by AI.' } };
    expect(composeAutoSendText(' Body ', setting, 'en')).toBe('Body\n\nSent by AI.');
    expect(composeAutoSendText(' Body ', { ...setting, enabled: false }, 'en')).toBe('Body');
  });
});

describe('who the customer is (po #26, T-114a)', () => {
  it('needs a verified contact, and for email authenticated senders', () => {
    expect(disclosureFor('gmail', verified, true)).toBe('verified');
    expect(disclosureFor('gmail', verified, false)).toBe('restricted');
    expect(disclosureFor('portal', verified)).toBe('verified');
    expect(disclosureFor('gmail', { verifiedAt: null, lineVerifiedAt: null })).toBe('restricted');
    expect(disclosureFor('gmail', undefined)).toBe('restricted');
    expect(disclosureFor('line', { verifiedAt: new Date(), lineVerifiedAt: null })).toBe(
      'restricted',
    );
  });

  it('reads the sender authentication of every inbound mail', () => {
    const pass = { direction: 'inbound', emailMeta: { senderAuth: 'pass' } };
    expect(senderAuthenticated([pass, pass, { direction: 'outbound', emailMeta: null }])).toBe(
      true,
    );
    expect(
      senderAuthenticated([pass, { direction: 'inbound', emailMeta: { senderAuth: 'fail' } }]),
    ).toBe(false);
    expect(senderAuthenticated([{ direction: 'inbound', emailMeta: null }])).toBe(false);
  });
});
