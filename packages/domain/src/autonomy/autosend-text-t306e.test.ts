import { describe, expect, it } from 'vitest';

import {
  autosendContactVerified,
  customerWantsHuman,
  linksAllowed,
  normalizeText,
} from './autosend-text.js';

const ORIGINS = ['https://desk.example.test'];
const verified = { verifiedAt: new Date(), lineVerifiedAt: null };

describe('contacts and hosts that are not the instance (T-306e C-2)', () => {
  it('refuses a phone number, @handle, LINE id, IP or email the cited passages do not carry', () => {
    for (const text of [
      'Call us on 02-123-4567.',
      'โทร 081 234 5678 ได้เลย',
      'โทร ๐๘๑-๒๓๔-๕๖๗๘',
      'Call +66 81 234 5678',
      'Call +1 (415) 555-0132',
      'Message @helpdesk_support on the app',
      'LINE ID: helpdesk99',
      'ไอดีไลน์ helpdesk99',
      'line: @helpdesk',
      'Connect to 203.0.113.7 and retry',
      'Connect to 2001:db8::1 and retry',
      'Connect to 203[.]0[.]113[.]7',
      'Mail support@evil.example',
      'Mail support[at]evil[.]example',
    ]) {
      expect(linksAllowed(text, ORIGINS), text).toBe(false);
    }
  });

  it('refuses a defanged, fullwidth, ideographic-dot or IDN host', () => {
    for (const text of [
      'Go to evil[.]com/reset',
      'Go to evil(dot)com',
      'Go to evil[dot]com',
      'Go to ｅｖｉｌ．ｃｏｍ',
      'Go to evil。com',
      'Go to evil​.com',
      'Go to hxxps://evil.example/x',
      'Go to exаmple.com', // Cyrillic a
      'Go to xn--exmple-cua.com',
      'Go to https://exаmple.com/x',
      'Go to ｈｔｔｐｓ：／／ｅｖｉｌ．ｅｘａｍｐｌｅ／ｘ',
    ]) {
      expect(linksAllowed(text, ORIGINS), text).toBe(false);
    }
  });

  it('allows a contact or host that a cited passage carries exactly', () => {
    const snippets = [
      'Support hours: 02-123-4567, https://status.vendor.example/ and help@vendor.example, @vendorhelp, LINE ID: vendor99',
    ];
    for (const text of [
      'Call 02 123 4567 for support.',
      'Call 021234567.',
      'See https://status.vendor.example/ for status.',
      'See status.vendor.example for status.',
      'Write to help@vendor.example.',
      'Ask @vendorhelp.',
      'Add line id vendor99.',
    ]) {
      expect(linksAllowed(text, ORIGINS, snippets), text).toBe(true);
      expect(linksAllowed(text, ORIGINS, []), `${text} (no cited passage)`).toBe(false);
    }
    // One that the passage does not carry is still refused.
    expect(linksAllowed('Call 02-999-9999.', ORIGINS, snippets)).toBe(false);
    expect(linksAllowed('See https://other.example/', ORIGINS, snippets)).toBe(false);
  });

  it('does not take ordinary text for a contact', () => {
    for (const text of [
      'You can reset it in 5 minutes. Version 2.4 fixes this.',
      'Our online support is open from 9.00 to 17.30 on 2026-11-05.',
      'Amount 1,500,000 baht, meeting at 10:30:45.',
      'ลองรีสตาร์ทแล้วลองอีกครั้งครับ',
      'Use the line tool, e.g. the pen.',
    ]) {
      expect(linksAllowed(text, ORIGINS), text).toBe(true);
    }
  });

  it('normalizes text before checking', () => {
    expect(normalizeText('ｅｖｉｌ[.]com')).toBe('evil.com');
    expect(normalizeText('a​b')).toBe('ab');
    expect(normalizeText('๐๑๒')).toBe('012');
    expect(normalizeText('ทำ')).toBe('ทำ');
  });
});

describe('the customer asked for a person: wider phrases (T-306e C-2)', () => {
  it('finds the phrases of the review', () => {
    for (const text of [
      'I want to talk to your manager',
      'Please get me a supervisor',
      'can I speak with a real person',
      'transfer me to an agent',
      'please escalate this',
      'no bots please',
      'stop the bot',
      "I don't want an AI reply",
      'Is this a human or an AI?',
      'ขอคุยกับคน',
      'ขอเจ้าหน้าที่ครับ',
      'อยากได้พนักงานจริงๆ',
      'ขอคนจริงมาตอบหน่อย',
      'ไม่เอาบอท',
      'อย่าให้บอทตอบ',
      'หยุดบอทได้ไหม',
      'ｓｐｅａｋ ｔｏ ａ ｈｕｍａｎ',
      'speak​ to a human',
    ]) {
      expect(customerWantsHuman([text]), text).toBe(true);
    }
  });

  it('still leaves an ordinary question alone', () => {
    for (const text of [
      'How do I reset my sign-in?',
      'The human resources module shows an error',
      'My virtual machine does not start',
      'Where do I download the installer?',
      'รีเซ็ตรหัสผ่านยังไงครับ',
      'ทำไมเข้าระบบไม่ได้',
    ]) {
      expect(customerWantsHuman([text]), text).toBe(false);
    }
  });
});

describe('spelled-out dots and "talk to agent" (T-306k C-2)', () => {
  it('refuses a host whose dot is written as a word or a spaced dot', () => {
    for (const text of [
      'Go to evil dot com',
      'Go to evil . com',
      'Go to EVIL DOT COM now',
      'Go to evil จุด com',
    ]) {
      expect(linksAllowed(text, ORIGINS), text).toBe(false);
    }
  });

  it('does not refuse plain prose', () => {
    expect(linksAllowed('Thanks. Please try again later.', ORIGINS)).toBe(true);
    expect(linksAllowed('ขอบคุณที่จุดประสงค์ชัดเจน', ORIGINS)).toBe(true);
  });

  it('reads "talk to agent" and "talk to a person" as a request for a person', () => {
    expect(customerWantsHuman(['I want to talk to agent'])).toBe(true);
    expect(customerWantsHuman(['Let me talk to a person'])).toBe(true);
    expect(customerWantsHuman(['The password reset worked, thanks'])).toBe(false);
  });
});

describe('who the customer is for the automatic send (T-306e C-3)', () => {
  it('a portal ticket is verified only when the portal says so, never from the contact', () => {
    expect(autosendContactVerified('portal', verified, undefined)).toBe(false);
    expect(autosendContactVerified('portal', verified, false)).toBe(false);
    expect(autosendContactVerified('portal', verified, 'true')).toBe(false);
    expect(autosendContactVerified('portal', undefined, true)).toBe(true);
    expect(autosendContactVerified('portal', verified, true)).toBe(true);
    expect(autosendContactVerified('gmail', verified, undefined)).toBe(true);
    expect(autosendContactVerified('gmail', { verifiedAt: null, lineVerifiedAt: null }, true)).toBe(
      false,
    );
  });
});
