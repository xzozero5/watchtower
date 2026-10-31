import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default; a unit test pins the `$argon2id$` prefix) with the OWASP minimum
// profile: 19 MiB, 2 passes, 1 lane. The `algorithm` option is an ambient const enum that
// isolatedModules cannot import by value, so it is left at its default instead.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Password hashing for the break-glass admin: argon2id, a random salt per hash. */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  /** False for a wrong password and for a hash that cannot be parsed; never throws. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real verification, for a login attempt on an account that does not
   * exist, so response time does not reveal which emails have an account.
   */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(await this.dummyHash, password);
  }
}
