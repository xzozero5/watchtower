/**
 * `personToneCheck` (ADR-029 section 9.9, DoD C-24/C-25): the code side of the rule that a narration about
 * people states facts and never ranks, judges or advises about a person. The prompt asks for it; this is what
 * does not depend on the prompt being obeyed.
 *
 * A claim is rejected when it
 *   - ranks (superlatives, `#1`, `อันดับ`, `ที่สุด`, `หนักสุด`, "most", "lowest", "top", "bottom", "ahead", "behind"),
 *   - judges (good/bad/lazy/แย่/เก่ง/ดีกว่า/ช้ากว่า),
 *   - advises or orders (should, must, recommend, ควร, ต้อง, แนะนำ, ย้ายงาน),
 *   - compares a person with the others or the team ("above the team average", "มากกว่าค่าเฉลี่ยทีม", "3x",
 *     "better than", "worse than"), or
 *   - names two or more people in one sentence (a comparison or a list that ranks by its order).
 * Across claims, per-person claims whose values run strictly up or down in the order written are an implicit
 * ranking (`personOrderCheck`).
 *
 * `[ASSUMED]` A lexicon catches the common phrasings, not every paraphrase: it is the second line behind the
 * prompt, and a person-tone rejection rate above 10% sends the element back to F (section 9.9). It errs towards
 * rejecting: a rejected claim only costs a narration, never a wrong statement about a colleague.
 */

export type PersonToneReason =
  'ranking' | 'judgement' | 'advice' | 'comparison' | 'multi_person' | 'implicit_ranking';

export type PersonToneResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PersonToneReason; readonly matched: string };

/** The placeholder the redactor gives a name (`[NAME_3]`). */
export const PERSON_TOKEN = /\[NAME_\d{1,9}\]/g;
const ANY_TOKEN = /\[[A-Z_]+_\d{1,9}\]/g;

// Thai is matched on text with the spaces removed (Thai has none between words, models add some).
const THAI_RANKING: readonly RegExp[] = [
  // ที่สุด, หนักสุด, สูงสุด, ต่ำสุด, มากสุด ... but not ล่าสุด (latest) and สุดสัปดาห์ (weekend).
  /(?<!ล่า)สุด(?!สัปดาห์)/,
  /อันดับ/,
  /นำหน้า/,
  /ตามหลัง/,
  /ล้าหลัง/,
  /รองลงมา/,
  /ตามมาด้วย/,
  /คนแรก|คนที่สอง|คนที่สาม/,
  /เป็นรอง/,
  /เหนือกว่า/,
  /ที่[1-9๑-๙](?!\d)(?!รายการ|ใบ|ราย|คน|ชั่วโมง|ชม|นาที|วัน|%|ticket)/i,
];
const THAI_JUDGEMENT: readonly RegExp[] = [
  /แย่/,
  /ดีกว่า/,
  /ดีที่/,
  /ดีเยี่ยม|ยอดเยี่ยม|ดีมาก/,
  /ไม่ดี/,
  /เก่ง/,
  /ขี้เกียจ/,
  /ช้ากว่า|เร็วกว่า/,
  /ด้อย/,
  /ล้มเหลว/,
  /ไม่ได้เรื่อง/,
  /ประสิทธิภาพ(?:ต่ำ|สูง)/,
];
const THAI_ADVICE: readonly RegExp[] = [
  /ควร/,
  /แนะนำ/,
  /ต้อง(?!การ)/,
  /ขอให้/,
  /โปรด/,
  /ย้ายงาน|โอนงาน|กระจายงาน|มอบหมายให้/,
  /ถึงเวลา/,
];
/** "than the average", "than the others", "N times", "compared with": a person set against the rest. */
const THAI_COMPARE_STRONG: readonly RegExp[] = [
  /ค่าเฉลี่ย|เฉลี่ยทีม|ค่ากลาง|ค่ามัธยฐาน/,
  /กว่าคนอื่น|กว่าทีม|กว่าเพื่อน|กว่าอีก|กว่าที่อื่น/,
  /เท่าของ|[0-9๐-๙]+เท่า/,
  /เทียบกับ|เมื่อเทียบ/,
];
const THAI_COMPARE_PLAIN = /มากกว่า|น้อยกว่า|สูงกว่า|ต่ำกว่า|เกินกว่า/;

const EN_RANKING: readonly RegExp[] = [
  /\b(?:best|worst|top|bottom|most|least|fewest|lowest|highest|biggest|largest|smallest|slowest|fastest|busiest|laziest)\b/,
  /\b(?:rank\w*|leader\w*|laggard\w*|number one|ahead|behind|lagging|leading|trailing|outperform\w*|underperform\w*|overperform\w*)\b/,
  /#\s?\d/,
  /\b(?:1st|2nd|3rd|first place|second place|last place)\b/,
];
const EN_JUDGEMENT: readonly RegExp[] = [
  /\b(?:better|worse|slower|faster|poor\w*|bad|good|great|excellent|lazy|slow|weak\w*|strong\w*)\b/,
];
const EN_ADVICE: readonly RegExp[] = [
  /\b(?:should|must|ought|recommend\w*|suggest\w*|advis\w*|consider|reassign\w*|rebalanc\w*)\b/,
  /\bneeds? to\b/,
  /\bhas to\b/,
];
const EN_COMPARE_STRONG: readonly RegExp[] = [
  /\b(?:average|mean|median)\b/,
  /\bthan\s+(?:the\s+)?(?:team|others?|anyone|everyone|another|colleagues?|peers?|teammates?)\b/,
  /\b(?:twice|double|triple|\d+\s?x|\d+\s+times)\b|\btimes as\b/,
  /\b(?:compared (?:to|with)|versus|vs\.?)\b/,
];
const EN_COMPARE_PLAIN =
  /\b(?:more|less|fewer|greater|higher|lower|larger|smaller|bigger)\s+than\b/;

function firstMatch(patterns: readonly RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found !== null) return found[0];
  }
  return null;
}

/** What a claim says about people, as far as the caller knows it (the text alone cannot know who is cited). */
export interface PersonToneContext {
  /**
   * The claim is about a person: its element shows only the viewer's own work (`home.my_work`), or the claim
   * names someone or cites a fact about a user. Comparisons against the average or the others count only then.
   */
  readonly personContext: boolean;
  /** Distinct people (`user` refs) the cited facts are about. */
  readonly citedUsers?: number | undefined;
}

export function distinctPersonTokens(text: string): number {
  return new Set(text.match(PERSON_TOKEN) ?? []).size;
}

export function personToneCheck(text: string, context: PersonToneContext): PersonToneResult {
  const folded = text
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(/[\u200B-\u200D\uFEFF]/g, '');
  const withoutTokens = folded.replaceAll(ANY_TOKEN, ' ');
  const thai = withoutTokens.replaceAll(/\s+/g, '');
  const reject = (reason: PersonToneReason, matched: string | null): PersonToneResult =>
    matched === null ? { ok: true } : { ok: false, reason, matched };
  const fail = (
    reason: PersonToneReason,
    ...matches: (string | null)[]
  ): PersonToneResult | null => {
    const hit = matches.find((item): item is string => item !== null);
    return hit === undefined ? null : reject(reason, hit);
  };

  const ranking = fail(
    'ranking',
    firstMatch(THAI_RANKING, thai),
    firstMatch(EN_RANKING, withoutTokens),
  );
  if (ranking !== null) return ranking;
  const judgement = fail(
    'judgement',
    firstMatch(THAI_JUDGEMENT, thai),
    firstMatch(EN_JUDGEMENT, withoutTokens),
  );
  if (judgement !== null) return judgement;
  const advice = fail(
    'advice',
    firstMatch(THAI_ADVICE, thai),
    firstMatch(EN_ADVICE, withoutTokens),
  );
  if (advice !== null) return advice;

  const tokens = distinctPersonTokens(text);
  const users = context.citedUsers ?? 0;
  if (tokens >= 2 || (tokens >= 1 && users >= 2)) {
    return { ok: false, reason: 'multi_person', matched: `${String(tokens)} people` };
  }
  if (context.personContext || tokens >= 1 || users >= 1) {
    const strong = fail(
      'comparison',
      firstMatch(THAI_COMPARE_STRONG, thai),
      firstMatch(EN_COMPARE_STRONG, withoutTokens),
    );
    if (strong !== null) return strong;
    // A plain "more than 5" is a threshold; "more than [NAME_2]" or "more than A's" is a person set against another.
    const afterThai = /(?:มากกว่า|น้อยกว่า|สูงกว่า|ต่ำกว่า)\[name_\d+\]/.exec(
      folded.replaceAll(/\s+/g, ''),
    );
    const afterEn = /\b(?:more|less|fewer|greater|higher|lower)\s+than\s+\[name_\d+\]/.exec(folded);
    if (afterThai !== null || afterEn !== null) {
      return { ok: false, reason: 'comparison', matched: (afterThai ?? afterEn)?.[0] ?? '' };
    }
    if (
      tokens >= 1 &&
      (THAI_COMPARE_PLAIN.test(thai) || EN_COMPARE_PLAIN.test(withoutTokens)) &&
      users >= 2
    ) {
      return { ok: false, reason: 'comparison', matched: 'comparative between people' };
    }
  }
  return { ok: true };
}

/** One per-person claim, as the order check sees it. */
export interface PersonClaimValue {
  /** Whom the claim is about (a placeholder or a user id). */
  readonly person: string;
  /** The figure the claim is about. */
  readonly value: number;
}

/**
 * Claims that each speak of a different single person, with values strictly rising or strictly falling in the
 * order written, are a ranking even if no sentence says so. Returns the indexes to drop (all but the first),
 * or an empty list when there is no such order. Equal values and a single person give no order.
 */
export function implicitRankingDrops(items: readonly (PersonClaimValue | null)[]): number[] {
  const entries = items
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: PersonClaimValue; index: number } => entry.item !== null);
  if (new Set(entries.map((entry) => entry.item.person)).size < 2) return [];
  let up = true;
  let down = true;
  for (let i = 1; i < entries.length; i += 1) {
    const before = entries[i - 1]?.item.value ?? 0;
    const now = entries[i]?.item.value ?? 0;
    if (!(now > before)) up = false;
    if (!(now < before)) down = false;
  }
  if (!up && !down) return [];
  return entries.slice(1).map((entry) => entry.index);
}
