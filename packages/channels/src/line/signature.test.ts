import { randomBytes } from 'node:crypto';

import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { LINE_SIGNATURE_HEADER, computeLineSignature, verifyLineSignature } from './signature.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

// Generated per run, so nothing in the repository resembles a real channel secret.
const channelSecret = randomBytes(16).toString('hex');
const body = JSON.stringify({
  destination: 'Uexample',
  events: [{ type: 'message', message: { type: 'text', text: 'สวัสดีครับ é "quoted" \\ slash' } }],
});

describe('computeLineSignature', () => {
  it('is base64 HMAC-SHA256 (RFC 4231 test case 2)', () => {
    // Public test vector: key "Jefe", data "what do ya want for nothing?".
    const expectedHex = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    expect(computeLineSignature('what do ya want for nothing?', 'Jefe')).toBe(
      Buffer.from(expectedHex, 'hex').toString('base64'),
    );
  });

  it('is the same for a string and its UTF-8 bytes', () => {
    expect(computeLineSignature(body, channelSecret)).toBe(
      computeLineSignature(Uint8Array.from(Buffer.from(body, 'utf8')), channelSecret),
    );
  });

  it('names the documented header in lower case', () => {
    expect(LINE_SIGNATURE_HEADER).toBe('x-line-signature');
  });
});

describe('verifyLineSignature', () => {
  const signature = computeLineSignature(body, channelSecret);

  it('accepts the signature of the exact body, as a string or as bytes', () => {
    expect(verifyLineSignature({ rawBody: body, signature, channelSecret })).toBe(true);
    expect(
      verifyLineSignature({
        rawBody: Uint8Array.from(Buffer.from(body)),
        signature,
        channelSecret,
      }),
    ).toBe(true);
  });

  it('tolerates surrounding whitespace in the header value', () => {
    expect(
      verifyLineSignature({ rawBody: body, signature: ` ${signature}\n`, channelSecret }),
    ).toBe(true);
  });

  it('rejects a body changed by one byte', () => {
    expect(
      verifyLineSignature({
        rawBody: body.replace('message', 'messagf'),
        signature,
        channelSecret,
      }),
    ).toBe(false);
  });

  it('rejects a re-serialised body (the raw bytes are what is signed)', () => {
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyLineSignature({ rawBody: reformatted, signature, channelSecret })).toBe(false);
  });

  it('rejects another secret', () => {
    const other = randomBytes(16).toString('hex');
    expect(verifyLineSignature({ rawBody: body, signature, channelSecret: other })).toBe(false);
  });

  it('rejects a missing, empty, short, long or non-base64 signature without throwing', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'abc',
      `${signature}AA`,
      signature.slice(0, -4),
      '!'.repeat(44),
      signature.replace(/=$/, 'A'),
    ]) {
      expect(verifyLineSignature({ rawBody: body, signature: bad, channelSecret })).toBe(false);
    }
  });

  it('rejects everything when no secret is configured', () => {
    const emptySecretSignature = computeLineSignature(body, '');
    expect(
      verifyLineSignature({ rawBody: body, signature: emptySecretSignature, channelSecret: '' }),
    ).toBe(false);
  });

  it('is not fooled by a signature computed with SHA-1 style lengths', () => {
    const sha1ish = Buffer.alloc(20, 1).toString('base64');
    expect(verifyLineSignature({ rawBody: body, signature: sha1ish, channelSecret })).toBe(false);
  });
});
