import { AUTOSEND_DISCLOSURE_DEFAULT, type AutosendDisclosure } from '@watchtower/shared';

/**
 * Pure helpers for the automatic reply (ADR-025): who the customer is for the disclosure policy, the
 * checks of the allow-list that work on the text, and the footer that says the reply is automatic.
 * No database, so the worker, the gate and the tests all use the same code.
 */

/** Every inbound email message came from a sender the receiving server authenticated (`pass`). */
export function senderAuthenticated(
  messages: readonly { direction: string; emailMeta: unknown }[],
): boolean {
  return messages
    .filter((message) => message.direction === 'inbound')
    .every((message) => {
      const meta = message.emailMeta;
      return (
        typeof meta === 'object' &&
        meta !== null &&
        (meta as { senderAuth?: unknown }).senderAuth === 'pass'
      );
    });
}

/** Verified for the disclosure policy (po #26): LINE tickets need the LINE identity verified, others the contact. */
export function disclosureFor(
  channel: string,
  contact: { verifiedAt: Date | null; lineVerifiedAt: Date | null } | undefined,
  /**
   * Email only (T-114a C-3): did the receiving server authenticate every inbound message's sender?
   * `From` is typed by the sender, so a verified contact's address alone proves nothing.
   * Undefined means the question does not apply (not an email ticket).
   */
  senderAuth?: boolean,
): 'verified' | 'restricted' {
  if (contact === undefined) return 'restricted';
  if (channel === 'gmail' && senderAuth === false) return 'restricted';
  const verified = channel === 'line' ? contact.lineVerifiedAt : contact.verifiedAt;
  return verified === null ? 'restricted' : 'verified';
}

/** What a redaction placeholder looks like: `[EMAIL_1]`, `[PHONE_2]`. */
const TOKEN_SHAPE = /\[[A-Z][A-Z_]*_\d+\]/g;
/** A template slot that was never filled: `{{name}}`, `[[x]]`, `<name>`, `[YOUR NAME]`. */
const SLOT_SHAPES = [/\{\{[^}]{0,80}\}\}/g, /\[\[[^\]]{0,80}\]\]/g, /<[A-Za-z][A-Za-z _-]{0,40}>/g];
const FILL_IN = /\[(?:your|customer|name|insert|todo|tbd)[^\]]{0,40}\]/gi;

/** Placeholders left in the text: redaction tokens and unfilled template slots. Zero is the only good number. */
export function countPlaceholders(text: string): number {
  let count = (text.match(TOKEN_SHAPE) ?? []).length;
  for (const shape of SLOT_SHAPES) count += (text.match(shape) ?? []).length;
  count += (text.match(FILL_IN) ?? []).length;
  return count;
}

const URL_SHAPE = /https?:\/\/[^\s<>"'`]+/gi;
/** `www.x`, or a bare `host.tld` (also the host part of an email address: fail closed). */
const BARE_HOST = /\bwww\.|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|\b)/i;

/**
 * True when every link in the text points at an address of this instance (`allowedOrigins`: the portal
 * and the knowledge base, both on the instance's own origin) and the text has no other host-like string.
 * No link at all is fine. A host with no scheme cannot be checked, so it counts as not allowed.
 */
export function linksAllowed(text: string, allowedOrigins: readonly string[]): boolean {
  const allowed = new Set(allowedOrigins.map((origin) => origin.toLowerCase()));
  let rest = text;
  for (const match of text.match(URL_SHAPE) ?? []) {
    rest = rest.replace(match, ' ');
    let origin: string;
    try {
      const url = new URL(match.replace(/[.,;:!?)\]}]+$/, ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      if (url.username !== '' || url.password !== '') return false;
      origin = url.origin.toLowerCase();
    } catch {
      return false;
    }
    if (!allowed.has(origin)) return false;
  }
  return !BARE_HOST.test(rest);
}

/** The instance's own origins from the addresses it knows (`portalUrl`, `APP_URL`); a bad value is left out. */
export function instanceOrigins(...urls: readonly (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const value of urls) {
    if (value === undefined || value === null || value === '') continue;
    try {
      out.add(new URL(value).origin.toLowerCase());
    } catch {
      // not a URL: it allows nothing
    }
  }
  return [...out];
}

const WANTS_HUMAN_EN =
  /\b(?:(?:speak|talk|chat|connect(?:ed)?|escalate)\s+(?:me\s+)?(?:to|with)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:human|person|agent|someone|representative|manager|supervisor|staff|engineer)|(?:real|live)\s+(?:person|human|agent)|human\s+(?:agent|being|support)|not\s+(?:a\s+)?(?:bot|ai|robot))\b/i;
const WANTS_HUMAN_TH =
  /(?:คุย|พูด|ติดต่อ|ขอ|โทร)\s*(?:กับ|หา)?\s*(?:คน(?:จริง)?|เจ้าหน้าที่|พนักงาน|ผู้จัดการ|แอดมิน|วิศวกร)|ไม่ใช่\s*(?:บอท|เอไอ|ai)/i;

/**
 * The customer asked for a person. Deterministic and deliberately wide (a false positive only costs an
 * automatic reply; a miss costs a customer who asked for a person getting a bot) `[ASSUMED]`.
 */
export function customerWantsHuman(texts: readonly string[]): boolean {
  return texts.some((text) => WANTS_HUMAN_EN.test(text) || WANTS_HUMAN_TH.test(text));
}

/**
 * The text that goes to the customer: the draft and, when the head has not turned it off, the notice that
 * it was sent automatically (ADR-025 section 8, owner decision 3). The notice is added on the server, here,
 * before the grader reads the text and before the hash is taken, so the grade covers exactly what is sent.
 */
export function composeAutoSendText(
  body: string,
  disclosure: AutosendDisclosure | undefined,
  language: 'th' | 'en',
): string {
  const setting = disclosure ?? AUTOSEND_DISCLOSURE_DEFAULT;
  const trimmed = body.trim();
  if (!setting.enabled) return trimmed;
  return `${trimmed}\n\n${language === 'th' ? setting.text.th : setting.text.en}`;
}
