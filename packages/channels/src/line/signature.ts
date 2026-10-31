import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * LINE webhook signature (R-2.9).
 *
 * `x-line-signature` is the base64 of HMAC-SHA256 over the exact bytes of the request body, keyed
 * with the channel secret (https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/,
 * read 2026-10-31). The body must be the raw bytes as received: parsing and re-serialising it
 * changes them. Compare in constant time. Never log the secret, the signature or the body.
 */

export const LINE_SIGNATURE_HEADER = 'x-line-signature';

export type RawBody = string | Uint8Array;

export function computeLineSignature(rawBody: RawBody, channelSecret: string): string {
  return createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

/**
 * True only for a well-formed signature that matches. Any malformed, missing or wrong-length input
 * returns false instead of throwing, so the caller can answer 401 without a try/catch.
 */
export function verifyLineSignature(input: {
  readonly rawBody: RawBody;
  readonly signature: string | null | undefined;
  readonly channelSecret: string;
}): boolean {
  const { rawBody, signature, channelSecret } = input;
  if (channelSecret === '' || signature === null || signature === undefined) return false;
  const given = signature.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(given)) return false; // base64 of 32 bytes
  const expected = Buffer.from(computeLineSignature(rawBody, channelSecret), 'base64');
  const received = Buffer.from(given, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
