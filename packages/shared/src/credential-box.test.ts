import { describe, expect, it } from 'vitest';

import {
  LocalKms,
  credentialContext,
  localKmsFromConfig,
  openCredential,
  rewrapCredential,
  sealCredential,
} from './credential-box.js';
import { SecretBoxError } from './secret-box.js';

const ROOT_A = 'root-key-a-for-tests-only-0123456789';
const ROOT_B = 'root-key-b-for-tests-only-0123456789';
const PLAINTEXT = 'sk-test-PLAINTEXT-0f3a9c';
const context = credentialContext('line', 'channelSecret');

const kmsA = new LocalKms({ current: { rootKey: ROOT_A, version: 1 } });

describe('sealCredential / openCredential', () => {
  it('round-trips, and nothing stored contains the value', async () => {
    const sealed = await sealCredential(kmsA, context, PLAINTEXT);
    expect(await openCredential(kmsA, context, sealed)).toBe(PLAINTEXT);
    expect(sealed.keyVersion).toBe(1);
    for (const stored of [sealed.valueSealed, sealed.dekWrapped]) {
      expect(stored).not.toContain(PLAINTEXT);
      expect(Buffer.from(stored.split('.')[2] ?? '', 'base64url').toString('utf8')).not.toContain(
        PLAINTEXT,
      );
    }
  });

  it('uses a new data key (and so a new ciphertext) each time', async () => {
    const first = await sealCredential(kmsA, context, PLAINTEXT);
    const second = await sealCredential(kmsA, context, PLAINTEXT);
    expect(first.valueSealed).not.toBe(second.valueSealed);
    expect(first.dekWrapped).not.toBe(second.dekWrapped);
  });

  it('does not open under another field, another integration or another key', async () => {
    const sealed = await sealCredential(kmsA, context, PLAINTEXT);
    await expect(
      openCredential(kmsA, credentialContext('line', 'channelAccessToken'), sealed),
    ).rejects.toBeInstanceOf(SecretBoxError);
    await expect(
      openCredential(kmsA, credentialContext('discord', 'channelSecret'), sealed),
    ).rejects.toBeInstanceOf(SecretBoxError);
    const other = new LocalKms({ current: { rootKey: ROOT_B, version: 1 } });
    await expect(openCredential(other, context, sealed)).rejects.toBeInstanceOf(SecretBoxError);
  });

  it('rejects a wrapped key presented under another version, and a tampered value', async () => {
    const sealed = await sealCredential(kmsA, context, PLAINTEXT);
    const both = new LocalKms({
      current: { rootKey: ROOT_B, version: 2 },
      previous: { rootKey: ROOT_A, version: 1 },
    });
    await expect(
      openCredential(both, context, { ...sealed, keyVersion: 2 }),
    ).rejects.toBeInstanceOf(SecretBoxError);
    const parts = sealed.valueSealed.split('.');
    parts[2] = Buffer.from('x'.repeat(10)).toString('base64url');
    await expect(
      openCredential(kmsA, context, { ...sealed, valueSealed: parts.join('.') }),
    ).rejects.toBeInstanceOf(SecretBoxError);
  });

  it('error messages never contain the value or a key', async () => {
    const sealed = await sealCredential(kmsA, context, PLAINTEXT);
    const other = new LocalKms({ current: { rootKey: ROOT_B, version: 1 } });
    const error = await openCredential(other, context, sealed).catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(PLAINTEXT);
    expect((error as Error).message).not.toContain(ROOT_A);
    expect((error as Error).message).not.toContain(ROOT_B);
  });
});

describe('LocalKms and rewrapCredential', () => {
  it('re-wraps a data key under the new version and leaves the sealed value alone', async () => {
    const sealed = await sealCredential(kmsA, context, PLAINTEXT);
    const rotating = new LocalKms({
      current: { rootKey: ROOT_B, version: 2 },
      previous: { rootKey: ROOT_A, version: 1 },
    });
    const next = await rewrapCredential(rotating, context, sealed);
    expect(next.keyVersion).toBe(2);
    expect(next.dekWrapped).not.toBe(sealed.dekWrapped);

    // The new KMS alone (old key gone) opens the re-wrapped row.
    const afterRetirement = new LocalKms({ current: { rootKey: ROOT_B, version: 2 } });
    expect(
      await openCredential(afterRetirement, context, { valueSealed: sealed.valueSealed, ...next }),
    ).toBe(PLAINTEXT);
    // And without the previous key the old row cannot be opened.
    await expect(openCredential(afterRetirement, context, sealed)).rejects.toBeInstanceOf(
      SecretBoxError,
    );
    expect(afterRetirement.canUnwrap(1)).toBe(false);
    expect(rotating.canUnwrap(1)).toBe(true);
  });

  it('refuses the same version twice and a version below 1', () => {
    expect(
      () =>
        new LocalKms({
          current: { rootKey: ROOT_B, version: 1 },
          previous: { rootKey: ROOT_A, version: 1 },
        }),
    ).toThrow(SecretBoxError);
    expect(() => new LocalKms({ current: { rootKey: ROOT_A, version: 0 } })).toThrow(
      SecretBoxError,
    );
  });

  it('is built from the service configuration', () => {
    const kms = localKmsFromConfig({
      APP_ENCRYPTION_KEY: ROOT_B,
      APP_ENCRYPTION_KEY_VERSION: 3,
      APP_ENCRYPTION_KEY_PREVIOUS: ROOT_A,
      APP_ENCRYPTION_KEY_PREVIOUS_VERSION: 2,
    });
    expect(kms.currentKeyVersion).toBe(3);
    expect(kms.canUnwrap(2)).toBe(true);
    expect(kms.canUnwrap(1)).toBe(false);
  });
});
