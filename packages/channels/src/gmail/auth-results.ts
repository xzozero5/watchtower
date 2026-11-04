import type { HeaderBag } from './mime.js';

/**
 * Did the receiving server authenticate the sender (T-114a C-3, security review of T-114)?
 * `From` is typed by the sender; only the `Authentication-Results` header the receiving mail
 * server (Gmail) wrote says whether DMARC or DKIM passed for the domain in `From`.
 *
 * Only the topmost header counts: a server adds its own on top, so a copy further down was
 * written by somebody earlier in the path (possibly the sender). `pass` needs `dmarc=pass`, or
 * `dkim=pass` signed by the `From` domain (the same domain or a subdomain of it, or the reverse).
 * No header, or anything else, is `none`; an explicit failure is `fail`.
 */
export type SenderAuth = 'pass' | 'fail' | 'none';

const MAX_HEADER_CHARS = 4000;

function domainOf(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const at = value.lastIndexOf('@');
  const domain = (at >= 0 ? value.slice(at + 1) : value).trim().toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : null;
}

function aligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

interface Clause {
  readonly method: string;
  readonly result: string;
  readonly props: Map<string, string>;
}

function parseClauses(value: string): Clause[] {
  const text = value.slice(0, MAX_HEADER_CHARS).replace(/\([^)]*\)/g, ' ');
  const clauses: Clause[] = [];
  // The first element is the authserv-id, not a result.
  for (const raw of text.split(';').slice(1)) {
    const tokens = raw.trim().split(/\s+/);
    const head = /^([a-z0-9-]+)=([a-z]+)$/i.exec(tokens[0] ?? '');
    if (!head) continue;
    const props = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const prop = /^([a-z0-9]+\.[a-z0-9-]+)=(.+)$/i.exec(token);
      if (prop?.[1] !== undefined && prop[2] !== undefined) {
        props.set(prop[1].toLowerCase(), prop[2].replace(/^"|"$/g, ''));
      }
    }
    clauses.push({
      method: (head[1] ?? '').toLowerCase(),
      result: (head[2] ?? '').toLowerCase(),
      props,
    });
  }
  return clauses;
}

export function senderAuthFrom(headers: HeaderBag, fromAddress: string | null): SenderAuth {
  const value = headers.getAll('authentication-results')[0];
  const fromDomain = fromAddress?.includes('@') === true ? domainOf(fromAddress) : null;
  if (value === undefined || fromDomain === null) return 'none';
  let failed = false;
  for (const clause of parseClauses(value)) {
    if (clause.method === 'dmarc') {
      const headerFrom = domainOf(clause.props.get('header.from'));
      if (clause.result === 'pass' && (headerFrom === null || aligned(headerFrom, fromDomain))) {
        return 'pass';
      }
      if (clause.result === 'fail') failed = true;
    } else if (clause.method === 'dkim') {
      const signer = domainOf(clause.props.get('header.d') ?? clause.props.get('header.i'));
      if (clause.result === 'pass' && signer !== null && aligned(signer, fromDomain)) return 'pass';
      if (clause.result === 'fail') failed = true;
    }
  }
  return failed ? 'fail' : 'none';
}
