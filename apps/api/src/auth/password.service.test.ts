import { describe, expect, it } from 'vitest';

import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and a random salt, and never contains the password', async () => {
    const password = 'correct horse battery staple';
    const a = await service.hash(password);
    const b = await service.hash(password);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(password);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(service.verify(hash, 'correct horse battery stapl')).resolves.toBe(false);
    await expect(service.verify(hash, '')).resolves.toBe(false);
  });

  it('treats an unparseable hash as a failed login, not an error', async () => {
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
    await expect(service.verify('', 'x')).resolves.toBe(false);
  });

  it('can burn the time of a verification for an account that does not exist', async () => {
    await expect(service.verifyAgainstDummy('anything')).resolves.toBeUndefined();
    await expect(service.verifyAgainstDummy('anything else')).resolves.toBeUndefined();
  });
});
