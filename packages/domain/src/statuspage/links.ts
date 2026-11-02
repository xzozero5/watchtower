import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Status page subscription links (T-204c). A link is
 *
 *   `wts1.<c|u>.<subscription id without dashes>.<16 hex nonce>.<signature>`
 *
 * `c` confirms a subscription, `u` unsubscribes. The signature is HMAC-SHA-256 over everything before it,
 * deterministic, so the worker derives the same link from the row whenever it sends an email and nothing
 * secret is stored or put on a queue. The nonce lives in the row: a new request rotates the confirmation
 * nonce, so an older confirmation link stops working. There is no expiry in the link: whether a
 * confirmation is still open is decided by the row (`confirm_expires_at`, compared with the database clock).
 */

const PREFIX = 'wts1';
const SHAPE = /^wts1\.([cu])\.([0-9a-f]{32})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

export type StatusLinkPurpose = 'confirm' | 'unsubscribe';

export interface StatusLinkClaims {
  readonly purpose: StatusLinkPurpose;
  readonly subscriptionId: string;
  readonly nonce: string;
}

const undash = (uuid: string): string => uuid.replaceAll('-', '');
const redash = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/** A fresh 64-bit nonce, as stored in `status_subscription`. */
export const newStatusNonce = (): string => randomBytes(8).toString('hex');

export function mintStatusLink(
  key: Buffer,
  purpose: StatusLinkPurpose,
  subscriptionId: string,
  nonce: string,
): string {
  const body = `${PREFIX}.${purpose === 'confirm' ? 'c' : 'u'}.${undash(subscriptionId)}.${nonce}`;
  return `${body}.${sign(key, body)}`;
}

/** The claims of a link whose signature is good; null for anything else (malformed, forged, damaged). */
export function verifyStatusLink(key: Buffer, token: string): StatusLinkClaims | null {
  const match = SHAPE.exec(token);
  if (!match) return null;
  const [, kind = '', idHex = '', nonce = '', signature = ''] = match;
  const body = token.slice(0, token.length - signature.length - 1);
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return {
    purpose: kind === 'c' ? 'confirm' : 'unsubscribe',
    subscriptionId: redash(idHex),
    nonce,
  };
}
