/**
 * What is removed from a golden answer besides personal data (T-306a C-8). The PII redactor takes people; it does
 * not know that an organization's name, a contract number or an amount of money identify a customer. A golden
 * answer is stored (and read by a drafter) as an example of tone, never as a fact, so these are replaced by
 * placeholders before it is kept. Pure and total: a regular expression and a list of names, nothing else.
 *
 * It narrows the leak; it does not close it (a sentence can still describe a customer in words), which is why a
 * golden answer is read only by the drafter of the same organization unless a lead says it holds nothing specific.
 */

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `ABC-12345`, `CT/2024/0091`, `INV-000123`: letters, a separator and digits. */
const CODE = /\b[A-Za-z]{1,8}[-/_]?\d{2,}(?:[-/_]\d+)+\b|\b[A-Za-z]{2,8}[-_]\d{3,}\b/g;
/** "contract no. X", "agreement #X", "สัญญาเลขที่ X": the word and the identifier after it. */
const CONTRACT_WORD =
  /(?:contract|agreement|po|purchase order|invoice|สัญญา|ใบสั่งซื้อ|ใบแจ้งหนี้)\s*(?:no\.?|number|id|#|เลขที่|หมายเลข)?\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9\-/_.]{3,}/gi;
/** `฿1,200`, `$5,000.50`, `THB 3000`, `12,000 baht`, `5,000 บาท`. */
const AMOUNT =
  /(?:[฿$€£]|THB|USD|EUR)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:บาท|baht|THB|USD|EUR|ดอลลาร์|[฿$€£])/gi;

export const GOLDEN_SCRUB_PLACEHOLDERS = {
  org: '[ORG]',
  contract: '[CONTRACT_ID]',
  amount: '[AMOUNT]',
} as const;

/** `names`: the names (and aliases) of the organization of the ticket; names shorter than 3 characters are ignored. */
export function scrubGoldenIdentifiers(text: string, names: readonly string[]): string {
  let result = text;
  const usable = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 3))]
    // The longest first, so "Acme Holdings Ltd" goes before "Acme".
    .toSorted((a, b) => b.length - a.length);
  for (const name of usable) {
    result = result.replace(new RegExp(escapeRegExp(name), 'gi'), GOLDEN_SCRUB_PLACEHOLDERS.org);
  }
  result = result.replace(CONTRACT_WORD, GOLDEN_SCRUB_PLACEHOLDERS.contract);
  result = result.replace(CODE, GOLDEN_SCRUB_PLACEHOLDERS.contract);
  result = result.replace(AMOUNT, GOLDEN_SCRUB_PLACEHOLDERS.amount);
  return result;
}
