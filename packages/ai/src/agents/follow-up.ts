import type { RedactedText } from '../redaction/redacted-text.js';

/**
 * What a customer message that came after the answer says about the problem (T-301f). Deterministic
 * rules on normalized Thai and English text, the same style as `customerWantsHuman` in the domain
 * package (which this package may not import, ADR-002), so the grade does not depend on the grader
 * model's reading. The input is redacted text only (N4): this runs on what the model would see.
 *
 *  - `deny`: the problem is not solved ("still not working", "ยังไม่หาย", a reopen request). Wins over
 *    every other signal in the same message, because a false `deny` only lowers a class.
 *  - `confirm`: the message says it works or is fixed. A question never confirms.
 *  - `ambiguous`: anything else, including bare thanks. It is not evidence of resolution.
 *
 * The phrase lists are `[ASSUMED]` starting points; they are widened from real tickets, not from guesses.
 */
export type FollowUp = 'confirm' | 'deny' | 'ambiguous';

const SARA_AM = String.fromCodePoint(0x0e33);
const SARA_AM_SPLIT = String.fromCodePoint(0x0e4d, 0x0e32);

function normalize(raw: string): string {
  return raw
    .normalize('NFKC')
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(SARA_AM_SPLIT, SARA_AM)
    .replaceAll(/[‘’´`]/g, "'")
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const DENY_EN: readonly RegExp[] = [
  /\b(?:not|never|no longer|isn't|aren't|wasn't|hasn't|haven't|yet to)\b[^.?!\n]{0,25}\b(?:work(?:s|ing|ed)?|fix(?:ed)?|resolv(?:ed|e)|solv(?:ed|e)|help(?:ed|s)?|better|loading|load|open(?:ing)?|log ?in|access\w*|ok|okay|fine|gone|changed)\b/,
  /\b(?:doesn't|does not|didn't|did not|won't|will not|can't|cannot|can not|couldn't|could not|unable to|still can't)\b[^.?!\n]{0,25}\b(?:work|fix|help|load|open|log ?in|access|connect|see|get)\b/,
  /\bstill\b[^.?!\n]{0,20}\b(?:not|no|broken|fail\w*|error\w*|down|slow|stuck|same|happening|having|there|an? (?:issue|problem)|can't|cannot|unable|persist\w*|occurring)\b/,
  /\b(?:same|identical) (?:error|issue|problem|result|thing)\b/,
  /\b(?:issue|problem|error) (?:persists|remains|continues|is back|came back|again)\b/,
  /\b(?:no luck|didn't help|did not help|not solved|not fixed|not resolved)\b/,
  /\bre-?open\w*\b/,
  /\bnot (?:yet|working)\b/,
];
const DENY_TH: readonly RegExp[] = [
  /ยัง(?!ไง)/,
  /ไม่(?:ได้|หาย|ทำงาน|work|เวิร์ค|ขึ้น|ผ่าน|เปลี่ยน|ดีขึ้น|สำเร็จ|เสร็จ)/,
  /(?:ใช้|เข้า|เปิด|ล็อกอิน|login|แก้|ส่ง|โหลด)\s*(?:งาน)?\s*ไม่/,
  /เปิด\s*(?:เรื่อง|เคส|ticket)?\s*(?:ใหม่|อีก)/,
  /(?:ปัญหา|อาการ|error|เออเร่อ)\s*(?:เดิม|เหมือนเดิม|กลับมา|ซ้ำ|อีก)/,
  /เหมือนเดิม|ยังมีปัญหา|กลับมาเป็น/,
];

const CONFIRM_EN: readonly RegExp[] = [
  /\b(?:works|working|worked|is fixed|are fixed|got fixed|fixed|resolved|solved|sorted)\b[^.?!\n]{0,12}\b(?:now|again|fine|well|perfectly|great|thanks?)\b/,
  /\b(?:now|it|that|this|everything)\b[^.?!\n]{0,10}\b(?:works|working|worked|fixed|resolved|solved|sorted)\b/,
  /\b(?:all good|all set|good now|ok now|okay now|fine now|back to normal|back online|back up|did the trick|problem(?: is)? gone|issue(?: is)? gone|no more (?:error|issue|problem)s?)\b/,
  /\bcan (?:now )?(?:log ?in|access|open|see|use|connect)\b/,
  /\b(?:issue|problem|ticket) (?:is )?(?:fixed|resolved|solved)\b/,
];
const CONFIRM_TH: readonly RegExp[] = [
  /หาย(?:แล้ว|ละ|เรียบร้อย|เป็นปกติ)/,
  /(?:ใช้(?:งาน)?|เข้า(?:ใช้งาน)?|เปิด|ล็อกอิน|login|ส่ง|โหลด)\s*(?:ได้)?\s*(?:ได้)\s*(?:แล้ว|ละ|ปกติ|เลย)/,
  /(?:เรียบร้อย|ปกติ|โอเค|ok)\s*(?:แล้ว|ละ|ดี)/,
  /แก้(?:ไข)?\s*(?:ได้|เสร็จ|เรียบร้อย)\s*(?:แล้ว|ละ)/,
  /ไม่มี(?:ปัญหา|error|เออเร่อ)\s*(?:แล้ว|ละ)/,
  /(?:ได้|ใช้ได้|ทำงาน(?:ได้)?)\s*(?:แล้ว|ละ)\s*(?:ครับ|ค่ะ|คะ|จ้า|นะ)?\s*(?:ขอบคุณ|$)/,
];
const QUESTION =
  /\?|？|(?:ไหม|มั้ย|หรือเปล่า|หรือยัง|รึยัง|เหรอ|หรอ)(?:\s|$|ครับ|คะ|ค่ะ)|\b(?:is it|can you|could you|will it|how (?:do|can))\b/;

/** Reads one customer message that came after the answer. Pass the redacted text, never the raw text (N4). */
export function classifyFollowUp(redacted: RedactedText): FollowUp {
  const text = normalize(redacted);
  if (text === '') return 'ambiguous';
  if (DENY_EN.some((shape) => shape.test(text)) || DENY_TH.some((shape) => shape.test(text))) {
    return 'deny';
  }
  if (QUESTION.test(text)) return 'ambiguous';
  if (
    CONFIRM_EN.some((shape) => shape.test(text)) ||
    CONFIRM_TH.some((shape) => shape.test(text))
  ) {
    return 'confirm';
  }
  return 'ambiguous';
}
