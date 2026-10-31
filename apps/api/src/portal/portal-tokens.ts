import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Tracking tokens of the client portal (T-007). Pure functions: the service that stores and looks
 * them up is `PortalTokensService`.
 *
 *   `wtp1.<ticketId without dashes>.<expiresAt, epoch seconds in base 36>.<nonce>.<signature>`
 *
 * The signature is HMAC-SHA-256 over everything before it. It lets the server throw away a forged
 * or damaged token before touching the database, and ties the token to one ticket and one expiry
 * even if the database row were edited. The database row (SHA-256 of the whole token) is what makes
 * a token revocable and what proves the server issued it.
 */

const PREFIX = 'wtp1';
const SHAPE = /^wtp1\.([0-9a-f]{32})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export interface TokenClaims {
  readonly ticketId: string;
  readonly expiresAt: Date;
}

export interface MintedToken extends TokenClaims {
  readonly token: string;
}

const undash = (uuid: string) => uuid.replaceAll('-', '');
const redash = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function mintToken(key: Buffer, ticketId: string, expiresAt: Date): MintedToken {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  const body = `${PREFIX}.${undash(ticketId)}.${expires.toString(36)}.${randomBytes(16).toString('base64url')}`;
  return { token: `${body}.${sign(key, body)}`, ticketId, expiresAt: new Date(expires * 1000) };
}

/** The claims of a token whose signature is good and whose expiry has not passed; null otherwise. */
export function verifyToken(key: Buffer, token: string, now: Date): TokenClaims | null {
  const match = SHAPE.exec(token);
  if (!match) return null;
  const [, ticketHex = '', expiresText = '', , signature = ''] = match;
  const body = token.slice(0, token.length - signature.length - 1);
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expires = parseInt(expiresText, 36);
  if (!Number.isSafeInteger(expires) || now.getTime() >= expires * 1000) return null;
  return { ticketId: redash(ticketHex), expiresAt: new Date(expires * 1000) };
}

/** What the database stores: the token itself never is. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
