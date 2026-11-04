import { describe, expect, it } from 'vitest';

import { senderAuthFrom } from './auth-results.js';
import { parseHeaderBlock } from './mime.js';

const auth = (value: string[], from = 'ann@customer.example'): ReturnType<typeof senderAuthFrom> =>
  senderAuthFrom(
    parseHeaderBlock(value.map((v) => `Authentication-Results: ${v}`).join('\r\n')),
    from,
  );

describe('senderAuthFrom (T-114a C-3)', () => {
  it('passes on dmarc=pass for the From domain', () => {
    expect(
      auth([
        'mx.google.com; dkim=pass header.i=@customer.example header.s=s1; spf=pass (google.com: domain of ann@customer.example designates 1.2.3.4) smtp.mailfrom=ann@customer.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=customer.example',
      ]),
    ).toBe('pass');
  });

  it('passes on dkim=pass signed by the From domain or its subdomain', () => {
    expect(auth(['mx.google.com; dkim=pass header.d=customer.example'])).toBe('pass');
    expect(auth(['mx.google.com; dkim=pass header.i=@mail.customer.example'])).toBe('pass');
  });

  it('does not pass on a dkim signature of another domain', () => {
    expect(auth(['mx.google.com; dkim=pass header.i=@attacker.example'])).toBe('none');
    expect(auth(['mx.google.com; dkim=pass header.i=@notcustomer.example'])).toBe('none');
  });

  it('does not pass on a dmarc pass for another header.from', () => {
    expect(auth(['mx.google.com; dmarc=pass header.from=attacker.example'])).toBe('none');
  });

  it('fails on dmarc=fail and dkim=fail', () => {
    expect(auth(['mx.google.com; dkim=fail header.d=customer.example; dmarc=fail'])).toBe('fail');
  });

  it('is none without the header, and spf alone is not enough', () => {
    expect(senderAuthFrom(parseHeaderBlock('Subject: hi'), 'ann@customer.example')).toBe('none');
    expect(auth(['mx.google.com; spf=pass smtp.mailfrom=ann@customer.example'])).toBe('none');
  });

  it('reads only the topmost header, so a forged lower copy does not count', () => {
    expect(
      auth([
        'mx.google.com; dmarc=fail header.from=customer.example',
        'forger.example; dmarc=pass header.from=customer.example',
      ]),
    ).toBe('fail');
  });

  it('is none when From has no usable domain', () => {
    expect(auth(['mx.google.com; dmarc=pass'], 'not-an-address')).toBe('none');
  });
});
