import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Message encryption for Web Push, RFC 8291 with the `aes128gcm` content coding of RFC 8188, one record.
 * Written against node:crypto on purpose (docs/09-SECURITY.md): the `web-push` library does its own
 * networking, which would bypass the pinned-address egress guard, and the scheme is small.
 */

/** RFC 8291 section 4: a push service must accept 4096 bytes; one record leaves 3993 for the plaintext. */
export const MAX_PLAINTEXT_BYTES = 3993;
const RECORD_SIZE = 4096;

export class PayloadTooLargeError extends Error {
  constructor() {
    super(`push payload is larger than ${MAX_PLAINTEXT_BYTES.toString()} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

export interface EncryptInput {
  readonly plaintext: Uint8Array;
  /** The browser's public key `p256dh`: 65 bytes, uncompressed P-256 point. */
  readonly uaPublic: Uint8Array;
  /** The browser's `auth` secret: 16 bytes. */
  readonly authSecret: Uint8Array;
  /** Tests pass the RFC's values; production leaves these out and gets a fresh key pair and salt per message. */
  readonly senderPrivate?: Uint8Array;
  readonly salt?: Uint8Array;
}

export interface EncryptedMessage {
  /** The request body: header (salt, record size, sender key) followed by the encrypted record. */
  readonly body: Buffer;
  /** Intermediate values, for the RFC test vector only. */
  readonly debug: { readonly senderPublic: Buffer; readonly cek: Buffer; readonly nonce: Buffer };
}

export function encryptMessage(input: EncryptInput): EncryptedMessage {
  if (input.plaintext.length > MAX_PLAINTEXT_BYTES) throw new PayloadTooLargeError();
  if (input.uaPublic.length !== 65 || input.uaPublic[0] !== 4) {
    throw new Error('p256dh is not an uncompressed P-256 point');
  }
  if (input.authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  const salt = Buffer.from(input.salt ?? randomBytes(16));
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');

  const sender = createECDH('prime256v1');
  if (input.senderPrivate === undefined) sender.generateKeys();
  else sender.setPrivateKey(Buffer.from(input.senderPrivate));
  const senderPublic = sender.getPublicKey();
  // Throws for a point that is not on the curve: a hostile subscription cannot make us compute with it.
  const shared = sender.computeSecret(Buffer.from(input.uaPublic));

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    Buffer.from(input.uaPublic),
    senderPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(input.authSecret), keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12),
  );

  // 0x02 marks the last (here: the only) record.
  const padded = Buffer.concat([Buffer.from(input.plaintext), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return {
    body: Buffer.concat([header, senderPublic, record]),
    debug: { senderPublic, cek, nonce },
  };
}
