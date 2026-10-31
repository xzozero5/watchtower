/**
 * Maps Thai digits (U+0E50-U+0E59) and full-width digits (U+FF10-U+FF19) to ASCII. Each is one
 * UTF-16 code unit, so the result has the same length and the same offsets as the input.
 */
export function toAsciiDigits(text: string): string {
  return text.replace(/[๐-๙０-９]/g, (char) => {
    const code = char.charCodeAt(0);
    return String(code >= 0xff10 ? code - 0xff10 : code - 0x0e50);
  });
}

/** Digits of `value` only (drops spaces, dashes and anything else). */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Thai national ID: 13 digits, the first is 1-8, and the last is a check digit:
 * `(11 - (sum(d[i] * (13 - i)) mod 11)) mod 10` for i in 0..11.
 */
export function isValidThaiNationalId(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 13 || !/^[1-8]/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(digits[index]) * (13 - index);
  }
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

/** Luhn check. Callers decide the length range. */
export function isLuhnValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length === 0) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
