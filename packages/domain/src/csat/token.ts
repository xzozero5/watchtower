import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Survey links (T-110b). A link is
 *
 *   `wtc1.<survey id without dashes>.<expiry, epoch seconds in base 36>.<signature>`
 *
 * The signature is HMAC-SHA-256 over everything before it. It is deterministic on purpose: the
 * reminder email derives the same link again, so nothing secret is stored and a copy of the
 * database cannot answer a survey. The signature lets the server throw away a forged or damaged
 * link before it touches the database; what makes a link work once is the survey row
 * (`status = 'sent'` becomes `answered`), and what makes it expire is both the signed expiry and
 * the row's own `token_expires_at`.
 */

const PREFIX = 'wtc1';
const SHAPE = /^wtc1\.([0-9a-f]{32})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{43})$/;

export interface CsatTokenClaims {
  readonly surveyId: string;
  readonly expiresAt: Date;
}

const undash = (uuid: string): string => uuid.replaceAll('-', '');
const redash = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/** The expiry as stored: whole seconds, so the same instant mints the same link every time. */
export function wholeSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

export function mintCsatToken(key: Buffer, surveyId: string, expiresAt: Date): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  const body = `${PREFIX}.${undash(surveyId)}.${expires.toString(36)}`;
  return `${body}.${sign(key, body)}`;
}

/** The claims of a link whose signature is good and whose expiry has not passed; null otherwise. */
export function verifyCsatToken(key: Buffer, token: string, now: Date): CsatTokenClaims | null {
  const match = SHAPE.exec(token);
  if (!match) return null;
  const [, surveyHex = '', expiresText = '', signature = ''] = match;
  const body = token.slice(0, token.length - signature.length - 1);
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expires = parseInt(expiresText, 36);
  if (!Number.isSafeInteger(expires) || now.getTime() >= expires * 1000) return null;
  return { surveyId: redash(surveyHex), expiresAt: new Date(expires * 1000) };
}
