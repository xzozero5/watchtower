import { Inject, Injectable } from '@nestjs/common';
import { KEY_LABELS, deriveSubkey, keyedTag } from '@watchtower/shared/secret-box';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';

/**
 * A short, non-reversible tag of an email address for the audit log and warnings, so the same
 * address can be followed across rows without the address itself (PII) being stored.
 *
 * It is an HMAC-SHA-256 under a subkey derived from APP_ENCRYPTION_KEY, not a plain hash: email
 * addresses are guessable, so with a bare `sha256(email)` anyone who can read the audit log could
 * confirm "was alice@example.com here?" by hashing candidates offline. Without the key they cannot.
 * The address is trimmed and lower-cased first. Changing APP_ENCRYPTION_KEY changes every tag
 * (old rows stay as they are and stop matching new ones).
 */
@Injectable()
export class EmailTagService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: Pick<ApiConfig, 'APP_ENCRYPTION_KEY'>) {
    this.key = deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.emailTag);
  }

  tag(email: string): string {
    return keyedTag(this.key, email.trim().toLowerCase());
  }
}
