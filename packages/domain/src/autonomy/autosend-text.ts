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

/**
 * Who the customer is for the automatic send (T-306e C-3, ADR-007 C-4). A portal submitter is never verified by
 * the address they typed: anyone can file with the email of a verified contact. A portal ticket counts as
 * verified only when the portal itself says so (`customFields.portal.requesterVerified === true`); the contact's
 * `verifiedAt` is not read for it. Other channels follow `disclosureFor`.
 */
export function autosendContactVerified(
  channel: string,
  contact: { verifiedAt: Date | null; lineVerifiedAt: Date | null } | undefined,
  portalRequesterVerified: unknown,
): boolean {
  if (channel === 'portal') return portalRequesterVerified === true;
  return disclosureFor(channel, contact) === 'verified';
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

// --- normalization ------------------------------------------------------------------------------------------

const SARA_AM = String.fromCodePoint(0x0e33);
const SARA_AM_SPLIT = String.fromCodePoint(0x0e4d, 0x0e32);
/** The ideographic full stop (U+3002) and its halfwidth form (U+FF61), as a dot in a host name. */
const IDEOGRAPHIC_STOPS = new RegExp(`[${String.fromCodePoint(0x3002, 0xff61)}]`, 'g');
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/**
 * The text as a checker should read it (T-306e C-2): Unicode NFKC (fullwidth letters, digits and punctuation
 * become ASCII), invisible characters removed, Thai digits as ASCII, the ideographic full stop and the common
 * "defanged" spellings (`evil[.]com`, `evil(dot)com`, `name[at]host`, `hxxp://`) put back as `.` / `@` / `http`.
 * Used for contact and host detection, never for what is sent.
 */
export function normalizeText(text: string): string {
  return (
    text
      .normalize('NFKC')
      // Format characters: zero-width space and joiners, bidi marks, soft hyphen, BOM.
      .replaceAll(/\p{Cf}/gu, '')
      .replaceAll(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)))
      // NFKC splits the Thai sara am (U+0E33) into U+0E4D U+0E32; put it back so Thai words still match.
      .replaceAll(SARA_AM_SPLIT, SARA_AM)
      .replaceAll(IDEOGRAPHIC_STOPS, '.')
      .replaceAll(/[[({<]\s*(?:\.|dot)\s*[\])}>]/gi, '.')
      .replaceAll(/[[({<]\s*(?:@|at)\s*[\])}>]/gi, '@')
      // T-306k C-2: a dot spelled out between spaces: `evil dot com`, `evil . com`, Thai `evil จุด com`.
      .replaceAll(/(?<=[\p{L}\p{N}-])\s+(?:dot|จุด|\.)\s+(?=[\p{L}\p{N}])/giu, '.')
      .replaceAll(/\bhxxp(s?)(?=:\/\/)/gi, 'http$1')
  );
}

// --- contacts and hosts ------------------------------------------------------------------------------------

const URL_SHAPE = /https?:\/\/[^\s<>"'`]+/gi;
const EMAIL_SHAPE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
const IPV4_SHAPE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d])/g;
/** Needs `::` or at least seven colons, so a clock time `10:30:45` is not an address. */
const IPV6_SHAPE = /(?<![\p{L}\p{N}:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\p{L}\p{N}:])/giu;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** Seven digits or more in a run that spaces, dashes, dots and brackets may break up: a phone number (TH or international). */
const PHONE_SHAPE = /\+?\d(?:[\s().-]?\d){6,}/g;
/** `line id x`, `ไอดีไลน์ x`, or `line: x` (a bare word "line" or "online" is not an id). */
const LINE_ID_SHAPE =
  /(?<![\p{L}\p{N}])(?:(?:line\s*id|lineid|ไอดีไลน์|ไลน์ไอดี)\s*[:=]?\s*@?([\p{L}\p{N}._-]{3,})|(?:line|ไลน์)\s*[:=]\s*@?([\p{L}\p{N}._-]{3,}))/giu;
const HANDLE_SHAPE = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_.]{2,})/gu;
const HOST_SHAPE = /(?:www\.|(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,})(?![\p{L}\p{N}])/giu;

/** The host as the address bar would send it (IDN as punycode, lower case), or null when it is not a valid host. */
function asciiHost(host: string): string | null {
  try {
    const name = new URL(`http://${host.replace(/\.+$/, '')}`).hostname;
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

interface Found {
  /** `kind:value` of everything that is not a link, comparable between the reply and the passages it cites. */
  readonly keys: Set<string>;
  /** A URL the reply holds that cannot be checked at all (other scheme, credentials, unparseable). */
  readonly hostile: boolean;
  /** The `http(s)` links: their origin and host. */
  readonly urls: { readonly origin: string; readonly host: string }[];
}

/**
 * Everything in a text that reaches a person or a machine outside the instance: URLs, email addresses, IP
 * addresses, phone numbers, LINE ids, `@handles` and bare host names. The text is normalized first.
 */
function findContacts(raw: string): Found {
  let rest = normalizeText(raw);
  const keys = new Set<string>();
  const urls: { origin: string; host: string }[] = [];
  let hostile = false;
  const take = (shape: RegExp, handle: (match: RegExpMatchArray) => void): void => {
    for (const match of rest.matchAll(shape)) handle(match);
    rest = rest.replaceAll(shape, ' ');
  };

  take(URL_SHAPE, (match) => {
    try {
      const url = new URL(match[0].replace(/[.,;:!?)\]}]+$/, ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') hostile = true;
      if (url.username !== '' || url.password !== '') hostile = true;
      urls.push({ origin: url.origin.toLowerCase(), host: url.hostname.toLowerCase() });
    } catch {
      hostile = true;
    }
  });
  take(EMAIL_SHAPE, (match) => keys.add(`email:${match[0].toLowerCase()}`));
  rest = rest.replaceAll(ISO_DATE, ' ');
  take(IPV4_SHAPE, (match) => keys.add(`ip:${match[0]}`));
  take(IPV6_SHAPE, (match) => {
    // `::` or seven colons: a clock time like 10:30:45 has neither.
    const colons = match[0].split(':').length - 1;
    if (match[0].includes('::') || colons >= 7) keys.add(`ip:${match[0].toLowerCase()}`);
  });
  take(PHONE_SHAPE, (match) => keys.add(`phone:${match[0].replaceAll(/\D/g, '')}`));
  take(LINE_ID_SHAPE, (match) =>
    keys.add(`line:${(match[1] ?? match[2] ?? '').toLowerCase().replace(/[.-]+$/, '')}`),
  );
  take(HANDLE_SHAPE, (match) =>
    keys.add(`handle:${(match[1] ?? '').toLowerCase().replace(/\.+$/, '')}`),
  );
  take(HOST_SHAPE, (match) => {
    const host = asciiHost(match[0].toLowerCase());
    if (host === null) hostile = true;
    else keys.add(`host:${host}`);
  });
  return { keys, hostile, urls };
}

/**
 * True when the text sends the customer nowhere the instance did not vouch for (ADR-025 condition 9, T-306e C-2).
 * The text is normalized (NFKC, fullwidth, `[.]`, `(dot)`, `。`, IDN as punycode) and then every link, email
 * address, phone number, `@handle`, LINE id, IP address and host name in it must either be a link to an origin
 * of this instance (`allowedOrigins`: the portal and the knowledge base), or appear exactly (after the same
 * normalization) in one of the customer-facing passages the reply cites (`citedSnippets`). No contact at all is
 * fine. A bare host with no scheme is never an instance address: it passes only as a quote of a cited passage.
 */
export function linksAllowed(
  text: string,
  allowedOrigins: readonly string[],
  citedSnippets: readonly string[] = [],
): boolean {
  const allowed = new Set(allowedOrigins.map((origin) => origin.toLowerCase()));
  const found = findContacts(text);
  if (found.hostile) return false;
  const cited = findContacts(citedSnippets.join('\n'));
  const known = new Set(cited.keys);
  for (const url of cited.urls) known.add(`host:${url.host}`);
  // A link: an origin of this instance, or a host the cited passages name.
  for (const url of found.urls) {
    if (!allowed.has(url.origin) && !known.has(`host:${url.host}`)) return false;
  }
  for (const key of found.keys) {
    if (!known.has(key)) return false;
  }
  return true;
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

// --- "I want a person" -------------------------------------------------------------------------------------

const PERSON_EN =
  'human|real person|live person|living person|actual person|real human|real agent|live agent|human agent|person|people|manager|supervisor|representative|rep|operator|someone|somebody|employee|staff|team member|colleague|engineer|agent|(?:a|an|the|your)\\s+agent';
const BOT_EN = 'bot|chatbot|robot|ai|a\\.i\\.|automated|auto[- ]?repl\\w*';
const WANTS_HUMAN_EN: readonly RegExp[] = [
  new RegExp(
    `\\b(?:speak|talk|chat|connect|transfer|escalat\\w*|forward|hand|pass|put|get|give|let|want|need|like|call|contact|reach|see|ask for|switch)\\b[^.?!\\n]{0,30}?\\b(?:${PERSON_EN})\\b`,
    'i',
  ),
  /\b(?:real|live|actual)\s+(?:person|human|agent|people)\b/i,
  /\bhuman\s+(?:agent|being|support|help|assistance|touch|reply|response)\b/i,
  /\bescalat(?:e|ion|ed)\b/i,
  new RegExp(
    `\\b(?:no|not|stop|don'?t|do not|without|never|instead of|rather than|tired of)\\b[^.?!\\n]{0,25}\\b(?:${BOT_EN})s?(?![\\p{L}])`,
    'iu',
  ),
  /\b(?:are you|is this|r u|am i (?:talking|speaking|chatting) (?:to|with))\s+(?:a\s+|an\s+|the\s+)?(?:bot|ai|robot|human|real|machine|automated|person)\b/i,
];
const WANTS_HUMAN_TH: readonly RegExp[] = [
  /(?:คุย|พูด|ติดต่อ|ขอ|โทร|อยากได้|อยากคุย|อยากพูด|ต้องการ|เชื่อม|โอน|ส่งต่อ|ให้|เรียก)\s*(?:กับ|หา|สาย|ที่|เป็น|มา)?\s*(?:คน(?:จริง)?|เจ้าหน้าที่|พนักงาน|ผู้จัดการ|หัวหน้า|แอดมิน|admin|ทีมงาน|วิศวกร|มนุษย์|ซัพพอร์ต|ฝ่ายบริการ|ผู้ดูแล|operator|คนที่เป็นคน)/i,
  /คนจริง|มนุษย์|เจ้าหน้าที่/,
  /ไม่(?:เอา|ต้องการ|อยาก|อยากคุย|คุย|ชอบ|ใช่)\s*(?:กับ)?\s*(?:บอท|bot|ai|เอไอ|แชทบอท|ระบบอัตโนมัติ|หุ่นยนต์|โรบอท|ออโต้)/i,
  /(?:อย่า|ห้าม|หยุด|เลิก)\s*(?:ให้)?\s*(?:บอท|bot|ai|เอไอ|ระบบอัตโนมัติ|แชทบอท|หุ่นยนต์)/i,
  /(?:บอท|bot|ai|เอไอ|แชทบอท|ระบบอัตโนมัติ).{0,8}(?:ไม่เอา|ไม่ต้อง|เลิก|หยุด)/i,
  /(?:เป็น|คือ)?\s*(?:บอท|ai|เอไอ|หุ่นยนต์)\s*(?:หรือ|เหรอ|ไหม|รึ|หรอ)/i,
];

/**
 * The customer asked for a person. Deterministic and deliberately wide (a false positive only costs an
 * automatic reply; a miss costs a customer who asked for a person getting a bot) `[ASSUMED]`. The text is
 * normalized first (fullwidth, invisible characters). T-306e C-2: manager, supervisor, real person, "no bot",
 * "stop the bot", Thai "ขอคุยกับคน / เจ้าหน้าที่ / คนจริง / พนักงาน", "ไม่เอาบอท", "อย่าให้บอทตอบ".
 */
export function customerWantsHuman(texts: readonly string[]): boolean {
  return texts.some((raw) => {
    const text = normalizeText(raw);
    return (
      WANTS_HUMAN_EN.some((shape) => shape.test(text)) ||
      WANTS_HUMAN_TH.some((shape) => shape.test(text))
    );
  });
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
