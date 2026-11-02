import { describe, expect, it } from 'vitest';

import {
  FREE_MAIL_DOMAINS,
  createOrganizationSchema,
  emailDomain,
  intentDefinitionSchema,
  isFreeMailDomain,
  orgDomainSchema,
} from './directory.js';
import {
  DEFAULT_STATUS_TRANSITIONS,
  TICKET_STATUSES,
  assignTicketSchema,
  createTicketSchema,
  defaultTransitionList,
  formatTicketKey,
  MIN_SEARCH_LENGTH,
  parseTicketKey,
  parseTicketSearchNumber,
  setWorkflowSchema,
  ticketListQuerySchema,
  ticketKeyPrefixSchema,
  ticketRefSchema,
} from './ticketing.js';

describe('ticket numbers', () => {
  it('formats and parses OPS-1234', () => {
    expect(formatTicketKey(1234)).toBe('OPS-1234');
    expect(parseTicketKey('OPS-1234')).toBe(1234);
    expect(parseTicketKey('ops-7')).toBe(7);
    expect(parseTicketKey(' OPS-7 ')).toBe(7);
  });

  it.each(['OPS-', 'OPS-0', 'OPS-12a', 'XYZ-1', '1234', 'OPS-99999999999999999'])(
    'does not parse %s',
    (value) => {
      expect(parseTicketKey(value)).toBeNull();
    },
  );

  it('formats and parses with the prefix an instance configures', () => {
    expect(formatTicketKey(7, 'SUP')).toBe('SUP-7');
    expect(parseTicketKey('sup-7', 'SUP')).toBe(7);
    expect(parseTicketKey('OPS-7', 'SUP')).toBeNull();
    expect(parseTicketKey('SUP-7')).toBeNull();
    expect(ticketKeyPrefixSchema.parse(' sup2 ')).toBe('SUP2');
    for (const bad of ['', 'A', '2UP', 'TOO-LONG', 'ABCDEFGHIJK', 'ไทย']) {
      expect(ticketKeyPrefixSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts a uuid or a key as a ticket reference and nothing else', () => {
    expect(ticketRefSchema.safeParse('OPS-12').success).toBe(true);
    expect(ticketRefSchema.safeParse('0b3f7a9c-1e0d-4c53-9a5e-6f2f3f4c9d10').success).toBe(true);
    expect(ticketRefSchema.safeParse("OPS-12'; drop table ticket;--").success).toBe(false);
    expect(ticketRefSchema.safeParse('not-a-ticket').success).toBe(false);
  });
});

describe('default workflow', () => {
  it('only mentions known statuses and never leads out of closed or merged', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of DEFAULT_STATUS_TRANSITIONS[from]) {
        expect(TICKET_STATUSES).toContain(to);
        expect(to).not.toBe(from);
        expect(to).not.toBe('merged');
      }
    }
    expect(DEFAULT_STATUS_TRANSITIONS.closed).toEqual([]);
    expect(DEFAULT_STATUS_TRANSITIONS.merged).toEqual([]);
  });

  it('follows the PRD order and lets a resolved ticket be reopened', () => {
    expect(DEFAULT_STATUS_TRANSITIONS.new).toContain('triage');
    expect(DEFAULT_STATUS_TRANSITIONS.triage).toContain('open');
    expect(DEFAULT_STATUS_TRANSITIONS.open).toContain('waiting_on_customer');
    expect(DEFAULT_STATUS_TRANSITIONS.open).toContain('waiting_on_dev');
    expect(DEFAULT_STATUS_TRANSITIONS.resolved).toEqual(['open', 'closed']);
    expect(DEFAULT_STATUS_TRANSITIONS.new).not.toContain('waiting_on_dev');
  });

  it('is a valid workflow to save', () => {
    expect(setWorkflowSchema.safeParse({ transitions: defaultTransitionList() }).success).toBe(
      true,
    );
  });

  it('refuses transitions into or out of merged, loops and duplicates', () => {
    const bad = (transitions: { from: string; to: string }[]) =>
      setWorkflowSchema.safeParse({ transitions }).success;
    expect(bad([{ from: 'open', to: 'merged' }])).toBe(false);
    expect(bad([{ from: 'merged', to: 'open' }])).toBe(false);
    expect(bad([{ from: 'open', to: 'open' }])).toBe(false);
    expect(
      bad([
        { from: 'open', to: 'closed' },
        { from: 'open', to: 'closed' },
      ]),
    ).toBe(false);
    expect(bad([{ from: 'open', to: 'nowhere' }])).toBe(false);
  });
});

describe('request schemas', () => {
  it('requires exactly one of assigneeId and strategy', () => {
    expect(assignTicketSchema.safeParse({}).success).toBe(false);
    expect(assignTicketSchema.safeParse({ assigneeId: null }).success).toBe(true);
    expect(assignTicketSchema.safeParse({ strategy: 'round_robin' }).success).toBe(true);
    expect(
      assignTicketSchema.safeParse({
        assigneeId: '0b3f7a9c-1e0d-4c53-9a5e-6f2f3f4c9d10',
        strategy: 'round_robin',
      }).success,
    ).toBe(false);
  });

  it('reads list filters from a query string, one value or several', () => {
    const parsed = ticketListQuerySchema.parse({
      status: 'open,new',
      priority: ['P1', 'P2'],
      overdue: 'true',
      limit: '25',
    });
    expect(parsed.status).toEqual(['open', 'new']);
    expect(parsed.priority).toEqual(['P1', 'P2']);
    expect(parsed.overdue).toBe(true);
    expect(parsed.limit).toBe(25);
    expect(parsed.sort).toBe('created_desc');
    expect(ticketListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(ticketListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(ticketListQuerySchema.parse({ status: '' }).status).toBeUndefined();
  });

  it('accepts a two-character search (a Thai word) and refuses one character', () => {
    expect(ticketListQuerySchema.parse({ q: ' ไฟ ' }).q).toBe('ไฟ');
    expect(ticketListQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });

  it('normalizes the requester address and trims the subject', () => {
    const parsed = createTicketSchema.parse({
      subject: '  Cannot log in  ',
      body: 'Help',
      requester: { email: ' Ana@Example.COM ', name: 'Ana' },
    });
    expect(parsed.subject).toBe('Cannot log in');
    expect(parsed.requester?.email).toBe('ana@example.com');
  });
});

describe('organization domains', () => {
  it('normalizes a domain', () => {
    expect(orgDomainSchema.parse('  Acme.Example.COM ')).toBe('acme.example.com');
  });

  it('refuses a public mailbox provider, with any casing', () => {
    for (const domain of ['gmail.com', 'GMAIL.com', 'outlook.com', 'yahoo.co.th']) {
      expect(orgDomainSchema.safeParse(domain).success, domain).toBe(false);
    }
    expect(FREE_MAIL_DOMAINS.every((domain) => isFreeMailDomain(domain))).toBe(true);
  });

  it.each(['example', 'exa mple.com', 'example..com', '-a.com', 'a.com/path', '@example.com'])(
    'refuses %s',
    (value) => {
      expect(orgDomainSchema.safeParse(value).success).toBe(false);
    },
  );

  it('takes the part after the last @', () => {
    expect(emailDomain('ana@Example.com')).toBe('example.com');
    expect(emailDomain('weird@name@example.com')).toBe('example.com');
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('trailing@')).toBeNull();
  });

  it('defaults a new organization to the standard tier', () => {
    expect(createOrganizationSchema.parse({ name: 'Acme' })).toMatchObject({
      tier: 'standard',
      domains: [],
    });
  });
});

describe('intent definitions', () => {
  it('has no autonomy stage: it can only be set by the autonomy endpoints (N3)', () => {
    const parsed = intentDefinitionSchema.parse({
      key: 'api_error',
      name: 'API error',
      description: 'd',
      typicalEvidence: 'e',
      defaultPriority: 'P2',
      autonomyStage: 4,
    });
    expect('autonomyStage' in parsed).toBe(false);
  });
});

describe('parseTicketSearchNumber', () => {
  it('reads a number however it is typed', () => {
    for (const typed of [
      '1003',
      'OPS-1003',
      'ops-1003',
      'OPS1003',
      'ops 1003',
      '#1003',
      ' Ops-1003 ',
    ]) {
      expect(parseTicketSearchNumber(typed, 'OPS'), typed).toBe(1003);
    }
  });

  it('uses the prefix of the instance, not a fixed one', () => {
    expect(parseTicketSearchNumber('sup7', 'SUP')).toBe(7);
    expect(parseTicketSearchNumber('OPS-7', 'SUP')).toBeNull();
  });

  it('rejects text that is not a number', () => {
    for (const typed of [
      'OPS',
      'OPS-',
      'abc',
      'a@b.co',
      '0',
      'OPS-0',
      '12ab',
      '1003 login',
      '-5x',
    ]) {
      expect(parseTicketSearchNumber(typed, 'OPS'), typed).toBeNull();
    }
    expect(parseTicketSearchNumber('9'.repeat(16), 'OPS')).toBeNull();
  });
});
