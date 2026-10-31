import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Synthetic messages (example.com only). Stored with LF; most tests read them as CRLF like SMTP. */
export function loadFixture(name: string, options: { crlf?: boolean } = {}): Uint8Array {
  const path = fileURLToPath(new URL(name, import.meta.url));
  const bytes = readFileSync(path);
  if (options.crlf === false) return Uint8Array.from(bytes);
  const asCrlf = bytes.toString('latin1').replace(/\r?\n/g, '\r\n');
  return Uint8Array.from(Buffer.from(asCrlf, 'latin1'));
}

export function fixtureText(name: string): string {
  return Buffer.from(loadFixture(name)).toString('utf8');
}
