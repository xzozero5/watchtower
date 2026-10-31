import { describe, expect, it } from 'vitest';

import {
  KEY_LABELS,
  SecretBoxError,
  deriveSubkey,
  keyedTag,
  openFields,
  openSecret,
  outboxAad,
  sealFields,
  sealSecret,
} from './secret-box.js';

const root = 'a-root-key-of-more-than-thirty-two-characters';
const key = deriveSubkey(root, KEY_LABELS.outboxSecret);
const aad = outboxAad('email', 'magic-link-abc');

describe('deriveSubkey', () => {
  it('is deterministic, 32 bytes, and different per label and per root', () => {
    expect(key).toHaveLength(32);
    expect(deriveSubkey(root, KEY_LABELS.outboxSecret).equals(key)).toBe(true);
    expect(deriveSubkey(root, KEY_LABELS.emailTag).equals(key)).toBe(false);
    expect(deriveSubkey(`${root}x`, KEY_LABELS.outboxSecret).equals(key)).toBe(false);
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips and never contains the plaintext', () => {
    const plain = 'http://localhost:3000/login/magic#abc=PLAIN-VALUE-123';
    const sealed = sealSecret(key, plain, aad);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('PLAIN-VALUE');
    expect(sealed).not.toContain('localhost');
    expect(openSecret(key, sealed, aad)).toBe(plain);
  });

  it('uses a fresh nonce each time', () => {
    expect(sealSecret(key, 'same', aad)).not.toBe(sealSecret(key, 'same', aad));
  });

  it('fails to open with another key, another binding, or after any change', () => {
    const sealed = sealSecret(key, 'payload', aad);
    expect(() => openSecret(deriveSubkey(root, KEY_LABELS.emailTag), sealed, aad)).toThrow(
      SecretBoxError,
    );
    expect(() => openSecret(key, sealed, outboxAad('email', 'another-job'))).toThrow(
      SecretBoxError,
    );
    expect(() => openSecret(key, sealed, outboxAad('other', 'magic-link-abc'))).toThrow(
      SecretBoxError,
    );
    const [version = '', iv = '', body = '', tag = ''] = sealed.split('.');
    const flippedBody = body.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(() => openSecret(key, [version, iv, flippedBody, tag].join('.'), aad)).toThrow(
      SecretBoxError,
    );
  });

  it('rejects malformed input and a key of the wrong size without echoing the value', () => {
    for (const bad of ['', 'v1', 'v2.a.b.c', 'v1.a.b.c', 'not sealed at all']) {
      expect(() => openSecret(key, bad, aad)).toThrow(SecretBoxError);
    }
    expect(() => sealSecret(Buffer.alloc(16), 'x', aad)).toThrow(SecretBoxError);
    expect(() => openSecret(key, 'v1.xxxx.yyyy.zzzz', aad)).toThrow(/malformed/);
  });
});

describe('sealFields / openFields', () => {
  it('round-trips a flat string map', () => {
    const sealed = sealFields(key, { link: 'https://x.example/#abc=1' }, aad);
    expect(openFields(key, sealed, aad)).toEqual({ link: 'https://x.example/#abc=1' });
  });

  it('rejects a sealed value that is not a flat string map', () => {
    for (const plain of ['"text"', '[1]', '{"a":1}', 'not json']) {
      expect(() => openFields(key, sealSecret(key, plain, aad), aad)).toThrow(SecretBoxError);
    }
  });
});

describe('keyedTag', () => {
  it('is stable for one key, differs per key, and is not a plain hash', () => {
    const tagKey = deriveSubkey(root, KEY_LABELS.emailTag);
    const tag = keyedTag(tagKey, 'someone@example.com');
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(keyedTag(tagKey, 'someone@example.com')).toBe(tag);
    expect(keyedTag(deriveSubkey(`${root}2`, KEY_LABELS.emailTag), 'someone@example.com')).not.toBe(
      tag,
    );
  });
});
