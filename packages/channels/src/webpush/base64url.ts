/** base64url without padding (RFC 4648 section 5), the encoding of every Web Push key and header. */
export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Decodes unpadded base64url; throws on any other character (Buffer would silently skip them). */
export function b64urlDecode(text: string): Buffer {
  if (!B64URL.test(text)) throw new Error('not base64url');
  return Buffer.from(text, 'base64url');
}
