/**
 * Envelope encryption for the integration credential store (ADR-012).
 *
 * A value is sealed with a fresh data key (DEK, 256-bit, one per stored row); the DEK is wrapped by
 * a key-encryption key (KEK) that a `KmsPort` holds. The database keeps the sealed value, the wrapped
 * DEK and the KEK version. Rotating the KEK re-wraps the DEKs and never touches the sealed values.
 *
 * `LocalKms` derives its KEKs from `APP_ENCRYPTION_KEY` with HKDF (`KEY_LABELS.credentialKek`). A
 * cloud KMS implements the same `KmsPort`; nothing else changes. No cloud SDK is imported here.
 *
 * Imports `node:crypto`, so it is not re-exported from the package index (apps/web bundles that
 * index). Import it by subpath: `@watchtower/shared/credential-box`.
 *
 * Nothing in this file prints, logs or puts a key or a plaintext into an error message.
 */
import { randomBytes } from 'node:crypto';

import { KEY_LABELS, SecretBoxError, deriveSubkey, openSecret, sealSecret } from './secret-box.js';

const FORMAT = 'watchtower/credential/v1';
const DEK_BYTES = 32;

/** What a stored credential row holds. */
export interface SealedCredential {
  /** The value, AES-256-GCM under the DEK (`v1.<iv>.<ciphertext>.<tag>`). */
  readonly valueSealed: string;
  /** The DEK, AES-256-GCM under the KEK of `keyVersion`. */
  readonly dekWrapped: string;
  readonly keyVersion: number;
}

/**
 * Wraps and unwraps data keys. `context` is a string the caller binds the wrapped key to (which
 * integration and field it belongs to); an implementation must make it part of what is authenticated,
 * so a wrapped key copied onto another row cannot be opened.
 */
export interface KmsPort {
  /** The KEK version `wrap` uses. */
  readonly currentKeyVersion: number;
  wrap(dek: Buffer, context: string): Promise<{ wrapped: string; keyVersion: number }>;
  /** Throws `SecretBoxError` when the version is unknown, the context is wrong or the value was changed. */
  unwrap(wrapped: string, keyVersion: number, context: string): Promise<Buffer>;
  /** True when this port can open keys wrapped under `keyVersion`. */
  canUnwrap(keyVersion: number): boolean;
}

export interface LocalKmsKey {
  /** The root key text, as `APP_ENCRYPTION_KEY` is used elsewhere (HKDF input, taken as given). */
  readonly rootKey: string;
  readonly version: number;
}

export interface LocalKmsOptions {
  readonly current: LocalKmsKey;
  /** The key being retired: only for opening and re-wrapping rows that still use it. Never used to wrap. */
  readonly previous?: LocalKmsKey;
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new SecretBoxError('key version must be a positive integer');
  }
}

function wrapAad(context: string, keyVersion: number): string {
  return `${FORMAT}|dek|${context}|kv${String(keyVersion)}`;
}

/** KmsPort over keys derived from the application's root key (`APP_ENCRYPTION_KEY`). */
export class LocalKms implements KmsPort {
  readonly currentKeyVersion: number;
  private readonly keks = new Map<number, Buffer>();

  constructor(options: LocalKmsOptions) {
    assertVersion(options.current.version);
    this.currentKeyVersion = options.current.version;
    this.keks.set(
      options.current.version,
      deriveSubkey(options.current.rootKey, KEY_LABELS.credentialKek),
    );
    if (options.previous !== undefined) {
      assertVersion(options.previous.version);
      if (options.previous.version === options.current.version) {
        throw new SecretBoxError('previous and current key versions must differ');
      }
      this.keks.set(
        options.previous.version,
        deriveSubkey(options.previous.rootKey, KEY_LABELS.credentialKek),
      );
    }
  }

  canUnwrap(keyVersion: number): boolean {
    return this.keks.has(keyVersion);
  }

  wrap(dek: Buffer, context: string): Promise<{ wrapped: string; keyVersion: number }> {
    const kek = this.keks.get(this.currentKeyVersion);
    if (kek === undefined) return Promise.reject(new SecretBoxError('no current key'));
    return Promise.resolve({
      wrapped: sealSecret(kek, dek.toString('base64url'), wrapAad(context, this.currentKeyVersion)),
      keyVersion: this.currentKeyVersion,
    });
  }

  unwrap(wrapped: string, keyVersion: number, context: string): Promise<Buffer> {
    const kek = this.keks.get(keyVersion);
    if (kek === undefined) {
      return Promise.reject(new SecretBoxError(`no key for version ${String(keyVersion)}`));
    }
    try {
      const dek = Buffer.from(openSecret(kek, wrapped, wrapAad(context, keyVersion)), 'base64url');
      if (dek.length !== DEK_BYTES) throw new SecretBoxError('data key has the wrong length');
      return Promise.resolve(dek);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new SecretBoxError('cannot unwrap'));
    }
  }
}

/** The fields of the validated configuration that select the keys. */
export interface CredentialKeyConfig {
  readonly APP_ENCRYPTION_KEY: string;
  readonly APP_ENCRYPTION_KEY_VERSION: number;
  readonly APP_ENCRYPTION_KEY_PREVIOUS?: string | undefined;
  readonly APP_ENCRYPTION_KEY_PREVIOUS_VERSION?: number | undefined;
}

/** Builds the local KMS from the service configuration (api, worker and the CLI use the same). */
export function localKmsFromConfig(config: CredentialKeyConfig): LocalKms {
  const previousKey = config.APP_ENCRYPTION_KEY_PREVIOUS;
  const previousVersion = config.APP_ENCRYPTION_KEY_PREVIOUS_VERSION;
  return new LocalKms({
    current: { rootKey: config.APP_ENCRYPTION_KEY, version: config.APP_ENCRYPTION_KEY_VERSION },
    ...(previousKey === undefined || previousVersion === undefined
      ? {}
      : { previous: { rootKey: previousKey, version: previousVersion } }),
  });
}

/** What a sealed value is bound to: which integration and field it belongs to. */
export function credentialContext(integration: string, field: string): string {
  return `${integration}|${field}`;
}

function valueAad(context: string): string {
  return `${FORMAT}|value|${context}`;
}

/** Seals `value` under a fresh DEK and wraps the DEK with the KMS. */
export async function sealCredential(
  kms: KmsPort,
  context: string,
  value: string,
): Promise<SealedCredential> {
  const dek = randomBytes(DEK_BYTES);
  try {
    const valueSealed = sealSecret(dek, value, valueAad(context));
    const { wrapped, keyVersion } = await kms.wrap(dek, context);
    return { valueSealed, dekWrapped: wrapped, keyVersion };
  } finally {
    dek.fill(0);
  }
}

/** Opens a sealed credential. Throws `SecretBoxError` (never containing the value) when it cannot. */
export async function openCredential(
  kms: KmsPort,
  context: string,
  sealed: SealedCredential,
): Promise<string> {
  const dek = await kms.unwrap(sealed.dekWrapped, sealed.keyVersion, context);
  try {
    return openSecret(dek, sealed.valueSealed, valueAad(context));
  } finally {
    dek.fill(0);
  }
}

/** Wraps the same DEK under the current KEK. The sealed value is unchanged. */
export async function rewrapCredential(
  kms: KmsPort,
  context: string,
  sealed: Pick<SealedCredential, 'dekWrapped' | 'keyVersion'>,
): Promise<Pick<SealedCredential, 'dekWrapped' | 'keyVersion'>> {
  const dek = await kms.unwrap(sealed.dekWrapped, sealed.keyVersion, context);
  try {
    const { wrapped, keyVersion } = await kms.wrap(dek, context);
    return { dekWrapped: wrapped, keyVersion };
  } finally {
    dek.fill(0);
  }
}
