/**
 * Server-side crypto helpers shared by apps/api and apps/worker: subkey derivation and
 * authenticated encryption for values that wait in Postgres or Redis until they are used (the
 * secret part of an outbox job, ADR-006).
 *
 * This module imports `node:crypto`, so it is NOT re-exported from the package index (apps/web
 * imports that index into browser bundles). Import it by subpath:
 * `import { ... } from '@watchtower/shared/secret-box'`.
 *
 * Keys: every purpose gets its own 256-bit subkey, derived with HKDF-SHA-256 from the root secret
 * (`APP_ENCRYPTION_KEY`, ADR-004) and a label, so a key made for one use can never open or forge
 * something made for another. Nothing derived here is stored.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** One label per purpose. Add a new label for a new use; never reuse one. */
export const KEY_LABELS = {
  /** AES-256-GCM key for the secret part of outbox jobs. */
  outboxSecret: 'watchtower/outbox/secret/v1',
  /** HMAC key for the non-reversible address tag written to the audit log. */
  emailTag: 'watchtower/audit/email-tag/v1',
  /** Key-encryption key that wraps the per-row data keys of the integration credential store (ADR-012). */
  credentialKek: 'watchtower/credentials/kek/v1',
  /** HMAC key that signs CSAT survey links (T-110): the same subkey in the api and the worker. */
  csatLink: 'watchtower/csat/link/v1',
  /** HMAC key that signs status page subscription links (T-204c): the same subkey in the api and the worker. */
  statusLink: 'watchtower/status/link/v1',
  /** HMAC key for `ai_run.input_hash`: an audit row can prove an input without storing it (ADR-008). */
  aiInputHash: 'watchtower/ai/input-hash/v1',
  /** HMAC key for the subject part of rate-limit and upload-quota counter keys (T-125): Redis holds no guessable hash of an address. */
  rateLimit: 'watchtower/rate-limit/subject/v1',
} as const;

const SALT = 'watchtower-subkeys';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/** A 256-bit subkey for one purpose (HKDF-SHA-256). The root key is used as text, as given. */
export function deriveSubkey(rootKey: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', rootKey, SALT, label, KEY_BYTES));
}

/** Thrown when a sealed value cannot be opened. The message never contains the value or the key. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * Encrypts `plaintext` with AES-256-GCM. `aad` (additional authenticated data) is not stored but
 * must be presented again to open the value: bind it to where the value belongs (queue and job id),
 * so a sealed value copied onto another job fails to open. Output: `v1.<iv>.<ciphertext>.<tag>`,
 * each part base64url.
 */
export function sealSecret(key: Buffer, plaintext: string, aad: string): string {
  if (key.length !== KEY_BYTES) throw new SecretBoxError('key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/** Opens a value made by `sealSecret`. Throws SecretBoxError for any malformed, forged or misbound input. */
export function openSecret(key: Buffer, sealed: string, aad: string): string {
  if (key.length !== KEY_BYTES) throw new SecretBoxError('key must be 32 bytes');
  const parts = sealed.split('.');
  const [version, ivText, ciphertextText, tagText] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    ivText === undefined ||
    ciphertextText === undefined ||
    tagText === undefined
  ) {
    throw new SecretBoxError('sealed value is malformed');
  }
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('sealed value is malformed');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretBoxError(
      'sealed value could not be opened (wrong key, wrong binding or tampered)',
    );
  }
}

/** HMAC-SHA-256 of `value`, hex, shortened to `length` characters. Keyed, so it cannot be brute-forced offline. */
export function keyedTag(key: Buffer, value: string, length = 16): string {
  return createHmac('sha256', key).update(value).digest('hex').slice(0, length);
}

/**
 * What a sealed value is bound to: the queue and the job id of the outbox row. A sealed value
 * copied onto another job (or another queue) fails to open.
 */
export function outboxAad(queue: string, jobId: string): string {
  return `watchtower/outbox/v1|${queue}|${jobId}`;
}

/**
 * What a sealed LINE reply token is bound to: the `inbound_message` it came with (ADR-010 section 6).
 * It shares the outbox subkey, so the binding is what keeps a value sealed for one purpose from
 * opening as another (`[ASSUMED]` a separate label is a later hardening).
 */
export function replyTokenAad(inboundMessageId: string): string {
  return `watchtower/line-reply-token/v1|${inboundMessageId}`;
}

/** Seals a flat set of named string fields (for example `{ link }`) into one value. */
export function sealFields(
  key: Buffer,
  fields: Readonly<Record<string, string>>,
  aad: string,
): string {
  return sealSecret(key, JSON.stringify(fields), aad);
}

/** Opens a value made by `sealFields`. Throws SecretBoxError when it is not a flat string map. */
export function openFields(key: Buffer, sealed: string, aad: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(openSecret(key, sealed, aad));
  } catch (error) {
    if (error instanceof SecretBoxError) throw error;
    throw new SecretBoxError('sealed value does not hold fields');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SecretBoxError('sealed value does not hold fields');
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new SecretBoxError('sealed value does not hold fields');
    fields[name] = value;
  }
  return fields;
}
