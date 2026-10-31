import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EmailTagService } from './email-tag.service.js';

const key = 'a-root-key-of-more-than-thirty-two-characters';

describe('EmailTagService (C-10)', () => {
  it('is a stable 16-hex-character tag that ignores case and surrounding space', () => {
    const tags = new EmailTagService({ APP_ENCRYPTION_KEY: key });
    const tag = tags.tag('Someone@Example.com');
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(tags.tag('  someone@example.com ')).toBe(tag);
    expect(tags.tag('other@example.com')).not.toBe(tag);
  });

  it('is keyed: it is not the plain SHA-256 an attacker could compute from a guessed address', () => {
    const tags = new EmailTagService({ APP_ENCRYPTION_KEY: key });
    const plain = createHash('sha256').update('someone@example.com').digest('hex').slice(0, 16);
    expect(tags.tag('someone@example.com')).not.toBe(plain);
  });

  it('changes with the encryption key, so a leaked audit log cannot be matched without it', () => {
    const one = new EmailTagService({ APP_ENCRYPTION_KEY: key });
    const two = new EmailTagService({ APP_ENCRYPTION_KEY: `${key}-rotated` });
    expect(one.tag('someone@example.com')).not.toBe(two.tag('someone@example.com'));
  });
});
