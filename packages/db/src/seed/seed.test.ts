import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_WEEKLY_HOURS, type SlaTargets } from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_EXAMPLES_DIR, SeedError } from './common.js';
import {
  DEMO_ORGS,
  DEMO_QUEUES,
  DEMO_STAFF,
  DEMO_TICKETS,
  ORG_KEYS,
  QUEUE_KEYS,
  STAFF_KEYS,
} from './demo-data.js';
import { assertSeedAllowed } from './index.js';
import { loadHolidayFiles, loadSlaPolicyFiles } from './reference.js';
import { mergeTime, planTicket, type PlanContext } from './tickets.js';

const calendarsDir = join(DEFAULT_EXAMPLES_DIR, 'calendars');
const slaDir = join(DEFAULT_EXAMPLES_DIR, 'sla');
const holidayFileName = 'th-public-holidays-2026-2027.json';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wt-seed-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${String(index)}`);
  return item;
}

interface HolidayDoc {
  _meta: Record<string, unknown>;
  calendar: Record<string, unknown>;
  holidays: Record<string, unknown>[];
}
interface SlaDoc {
  _meta: Record<string, unknown>;
  policies: { targets: { P1: Record<string, unknown> } }[];
}

async function holidayVariant(change: (file: HolidayDoc) => void): Promise<string> {
  const target = await mkdtemp(join(dir, 'cal-'));
  const file = JSON.parse(
    await readFile(join(calendarsDir, holidayFileName), 'utf8'),
  ) as HolidayDoc;
  change(file);
  await writeFile(join(target, 'h.json'), JSON.stringify(file));
  return target;
}

describe('the example holiday file', () => {
  it('is valid, covers 2026 and 2027 and is marked [VERIFY] and [UNVERIFIED]', async () => {
    const [file] = await loadHolidayFiles(calendarsDir);
    expect(file?.calendar).toEqual({ name: 'Bangkok office hours', timezone: 'Asia/Bangkok' });
    expect(file?._meta.status).toContain('[VERIFY]');
    expect(file?._meta.unverified).toContain('[UNVERIFIED]');
    const years = new Set(file?.holidays.map((holiday) => holiday.date.slice(0, 4)));
    expect([...years].toSorted()).toEqual(['2026', '2027']);
    // Lunar-calendar holidays and substitution days are the ones that must not look certain.
    const unverified = file?.holidays.filter((holiday) => holiday.status === 'unverified') ?? [];
    expect(unverified.some((holiday) => /Bucha|Khao Phansa/.test(holiday.name))).toBe(true);
    expect(unverified.some((holiday) => /^Substitution/.test(holiday.name))).toBe(true);
  });

  it('refuses a file that does not say [VERIFY]', async () => {
    const target = await holidayVariant((file) => {
      file._meta.status = 'Official list';
    });
    await expect(loadHolidayFiles(target)).rejects.toThrow(/\[VERIFY\]/);
  });

  it('refuses a missing [UNVERIFIED] note, an impossible date and a repeated date', async () => {
    await expect(
      loadHolidayFiles(
        await holidayVariant((file) => {
          file._meta.unverified = 'none';
        }),
      ),
    ).rejects.toThrow(/UNVERIFIED/);
    await expect(
      loadHolidayFiles(
        await holidayVariant((file) => {
          at(file.holidays, 0).date = '2026-02-30';
        }),
      ),
    ).rejects.toThrow(/not a real calendar date/);
    await expect(
      loadHolidayFiles(
        await holidayVariant((file) => {
          at(file.holidays, 1).date = at(file.holidays, 0).date;
        }),
      ),
    ).rejects.toThrow(/appears twice/);
  });

  it('refuses a date outside the declared years and an unknown entry status', async () => {
    await expect(
      loadHolidayFiles(
        await holidayVariant((file) => {
          at(file.holidays, 0).date = '2030-01-01';
        }),
      ),
    ).rejects.toThrow(/outside _meta.years/);
    await expect(
      loadHolidayFiles(
        await holidayVariant((file) => {
          at(file.holidays, 0).status = 'official';
        }),
      ),
    ).rejects.toThrow(SeedError);
  });

  it('refuses an unknown time zone, invalid JSON and two files for one calendar', async () => {
    await expect(
      loadHolidayFiles(
        await holidayVariant((file) => {
          file.calendar.timezone = 'Mars/Olympus';
        }),
      ),
    ).rejects.toThrow(/timezone/);
    const broken = await mkdtemp(join(dir, 'broken-'));
    await writeFile(join(broken, 'x.json'), '{ not json');
    await expect(loadHolidayFiles(broken)).rejects.toThrow(/cannot be read as JSON/);
    const twice = await mkdtemp(join(dir, 'twice-'));
    const raw = await readFile(join(calendarsDir, holidayFileName), 'utf8');
    await writeFile(join(twice, 'a.json'), raw);
    await writeFile(join(twice, 'b.json'), raw);
    await expect(loadHolidayFiles(twice)).rejects.toThrow(/repeats the calendar/);
  });
});

describe('the example SLA policies', () => {
  it('carry the three tiers with the decided numbers and the [ASSUMED] tag', async () => {
    const files = await loadSlaPolicyFiles(slaDir);
    expect(files[0]?._meta.status).toContain('[ASSUMED]');
    const policies = new Map(files.flatMap((file) => file.policies).map((p) => [p.tier, p]));
    expect([...policies.keys()].toSorted()).toEqual(['gold', 'silver', 'standard']);
    // PO decision 8: Gold P1 15 min / 4 h on a 24x7 clock, Silver P1 30 min / 8 h.
    expect(policies.get('gold')?.targets.P1).toEqual({
      first_response_min: 15,
      resolution_min: 240,
      calendar: '24x7',
    });
    expect(policies.get('silver')?.targets.P1).toMatchObject({
      first_response_min: 30,
      resolution_min: 480,
    });
    // Standard counts business hours for every priority.
    for (const priority of ['P1', 'P2', 'P3', 'P4'] as const) {
      expect(policies.get('standard')?.targets[priority]?.calendar).toBe('business');
    }
  });

  it('refuses two policies for one tier', async () => {
    const target = await mkdtemp(join(dir, 'sla-'));
    const raw = await readFile(join(slaDir, 'sla-policies.json'), 'utf8');
    await writeFile(join(target, 'a.json'), raw);
    await writeFile(join(target, 'b.json'), raw);
    await expect(loadSlaPolicyFiles(target)).rejects.toThrow(/share the/);
  });

  it('refuses a file without the [ASSUMED] tag and a first response longer than the resolution', async () => {
    const raw = JSON.parse(await readFile(join(slaDir, 'sla-policies.json'), 'utf8')) as SlaDoc;
    const untagged = await mkdtemp(join(dir, 'sla-'));
    raw._meta.status = 'final';
    await writeFile(join(untagged, 'x.json'), JSON.stringify(raw));
    await expect(loadSlaPolicyFiles(untagged)).rejects.toThrow(/ASSUMED/);

    const inverted = await mkdtemp(join(dir, 'sla-'));
    const again = JSON.parse(await readFile(join(slaDir, 'sla-policies.json'), 'utf8')) as SlaDoc;
    at(again.policies, 0).targets.P1.first_response_min = 9999;
    await writeFile(join(inverted, 'x.json'), JSON.stringify(again));
    await expect(loadSlaPolicyFiles(inverted)).rejects.toThrow(/cannot be longer/);
  });
});

describe('the production guard', () => {
  it('refuses NODE_ENV=production unless the flag is given', () => {
    const run = (options: Parameters<typeof assertSeedAllowed>[0]) => () => {
      assertSeedAllowed(options);
    };
    expect(run({ nodeEnv: 'production' })).toThrow(/refusing to seed/);
    expect(run({ nodeEnv: 'production', allowProduction: false })).toThrow(SeedError);
    expect(run({ nodeEnv: 'production', allowProduction: true })).not.toThrow();
  });

  it('allows development, test and an unset environment', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(() => {
        assertSeedAllowed({ nodeEnv });
      }).not.toThrow();
    }
  });
});

describe('the demo content', () => {
  it('is neutral: reserved example domains, invented names, no real contact data', () => {
    const reserved = /@([a-z0-9-]+\.)*example\.(com|org|net)$/;
    for (const person of DEMO_STAFF) expect(person.email).toMatch(reserved);
    for (const org of DEMO_ORGS) {
      expect(org.clientUser.email).toMatch(reserved);
      for (const domain of org.domains) expect(domain).toMatch(/(^|\.)example\.(com|org|net)$/);
      for (const person of org.contacts) {
        expect(person.email).toMatch(reserved);
        expect(person.name).toMatch(/Demo$/);
      }
    }
    expect(DEMO_ORGS.map((org) => org.tier)).toEqual(['gold', 'silver', 'standard']);
  });

  it('has two staff per staff role, queues of existing staff and a default queue', () => {
    for (const role of ['head', 'lead', 'agent'] as const) {
      expect(DEMO_STAFF.filter((person) => person.role === role).length).toBeGreaterThanOrEqual(2);
    }
    expect(DEMO_STAFF.filter((person) => person.role === 'agent')).toHaveLength(4);
    expect(DEMO_QUEUES.filter((queue) => queue.isDefault)).toHaveLength(1);
    for (const queue of DEMO_QUEUES) {
      for (const member of queue.members) expect(STAFF_KEYS).toContain(member);
    }
    expect(new Set(DEMO_TICKETS.map((spec) => spec.queue))).toEqual(new Set(QUEUE_KEYS));
  });

  it('has 30 uniquely keyed tickets spread over the three organizations, in Thai and English', () => {
    expect(DEMO_TICKETS).toHaveLength(30);
    expect(new Set(DEMO_TICKETS.map((spec) => spec.key)).size).toBe(30);
    expect(new Set(DEMO_TICKETS.map((spec) => spec.org))).toEqual(new Set(ORG_KEYS));
    const thai = DEMO_TICKETS.filter((spec) => /[฀-๿]/.test(spec.subject));
    expect(thai.length).toBeGreaterThanOrEqual(8);
    expect(DEMO_TICKETS.length - thai.length).toBeGreaterThanOrEqual(8);
  });
});

// --- the planner, with an in-memory context ---

const NOW = new Date('2026-11-04T10:00:00Z'); // a Wednesday
const targets: SlaTargets = {
  P1: { first_response_min: 15, resolution_min: 240, calendar: '24x7' },
  P2: { first_response_min: 60, resolution_min: 480, calendar: 'business' },
  P3: { first_response_min: 240, resolution_min: 1440, calendar: 'business' },
  P4: { first_response_min: 480, resolution_min: 2880, calendar: 'business' },
};
const policy = {
  id: 'policy-1',
  targets,
  calendar: { timezone: 'Asia/Bangkok', hours: DEFAULT_WEEKLY_HOURS, holidays: ['2026-10-23'] },
};
const priorityOf: Record<string, string> = {
  account_access: 'P3',
  api_error: 'P2',
  billing_report: 'P3',
  feature_question: 'P4',
  incident_inquiry: 'P1',
  other: 'P4',
  processing_failure: 'P2',
  result_dispute: 'P2',
  upstream_timeout: 'P2',
  webhook_not_received: 'P2',
  workspace_config: 'P4',
};

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    now: NOW,
    floor: new Date(0),
    channelAccountId: 'portal',
    orgs: {
      acme: { id: 'org-acme', policy, clientUserId: 'client-acme' },
      borealis: { id: 'org-borealis', policy, clientUserId: 'client-borealis' },
      cedar: { id: 'org-cedar', policy, clientUserId: 'client-cedar' },
    },
    contactId: (org, index) => `contact-${org}-${String(index)}`,
    staff: Object.fromEntries(
      STAFF_KEYS.map((key) => [key, `user-${key}`]),
    ) as PlanContext['staff'],
    queues: Object.fromEntries(
      QUEUE_KEYS.map((key) => [key, `queue-${key}`]),
    ) as PlanContext['queues'],
    intents: new Map(
      Object.entries(priorityOf).map(([key, defaultPriority]) => [
        key,
        { id: `intent-${key}`, key, defaultPriority, autonomyStage: 2 },
      ]),
    ),
    ...overrides,
  };
}

describe('planTicket', () => {
  const plans = DEMO_TICKETS.map((spec) => planTicket(spec, context()));

  it('plays every script without running past the moment the seed started', () => {
    expect(plans).toHaveLength(30);
    for (const plan of plans) {
      expect(plan.ticket.updatedAt?.getTime()).toBeLessThanOrEqual(NOW.getTime());
      if (plan.spec.mergeInto) expect(() => mergeTime(plan, NOW)).not.toThrow();
    }
  });

  it('ends in every status the workflow has, with the planned distribution', () => {
    const final = (plan: (typeof plans)[number]) => (plan.spec.mergeInto ? 'merged' : plan.status);
    const counts = new Map<string, number>();
    for (const plan of plans) counts.set(final(plan), (counts.get(final(plan)) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      new: 4,
      triage: 3,
      open: 6,
      waiting_on_customer: 4,
      waiting_on_dev: 3,
      resolved: 4,
      closed: 3,
      merged: 3,
    });
  });

  it('pauses the SLA clock exactly while a ticket waits on the customer', () => {
    for (const plan of plans) {
      const waiting = plan.status === 'waiting_on_customer';
      expect(plan.ticket.slaPausedAt !== null, plan.spec.key).toBe(waiting);
    }
    const paused = plans.filter((plan) => plan.status === 'waiting_on_customer');
    expect(paused).toHaveLength(4);
  });

  it('writes a resumed event with the dates for every pause that ended', () => {
    // demo-14 waited on the customer, got an answer, and waits again.
    const plan = plans.find((entry) => entry.spec.key === 'demo-14');
    const types = plan?.events.map((event) => event.type);
    expect(types?.filter((type) => type === 'sla.paused')).toHaveLength(2);
    expect(types?.filter((type) => type === 'sla.resumed')).toHaveLength(1);
    expect(plan?.ticket.slaPausedAt).not.toBeNull();
  });

  it('counts a reopen when a customer answers a resolved ticket', () => {
    const plan = plans.find((entry) => entry.spec.key === 'demo-10');
    expect(plan?.ticket.reopenCount).toBe(1);
    expect(plan?.status).toBe('open');
    expect(plan?.events.map((event) => event.type)).toContain('ticket.reopened');
  });

  it('records the first staff reply as the first response and a customer message as none', () => {
    const answered = plans.find((entry) => entry.spec.key === 'demo-01');
    expect(answered?.ticket.firstRespondedAt).not.toBeNull();
    const untouched = plans.find((entry) => entry.spec.key === 'demo-05');
    expect(untouched?.ticket.firstRespondedAt).toBeNull();
    expect(untouched?.messages).toHaveLength(1);
  });

  it('keeps the first message of every ticket idempotent: one provider id per ticket, public', () => {
    const ids = plans.map((plan) => plan.messages[0]?.externalId);
    expect(new Set(ids).size).toBe(30);
    for (const plan of plans) {
      expect(plan.messages[0]).toMatchObject({ direction: 'inbound', visibility: 'public' });
    }
  });

  it('has public replies and internal notes, in both languages', () => {
    const all = plans.flatMap((plan) => plan.messages);
    expect(all.some((m) => m.visibility === 'internal' && m.direction === 'internal')).toBe(true);
    expect(all.some((m) => m.direction === 'outbound' && /[฀-๿]/.test(m.bodyText))).toBe(true);
    expect(all.some((m) => m.direction === 'outbound' && !/[฀-๿]/.test(m.bodyText))).toBe(true);
    // Notes are never marked as delivered to a customer.
    for (const note of all.filter((m) => m.direction === 'internal')) {
      expect(note.deliveryStatus).toBe('not_applicable');
    }
  });

  it('writes an audit row for the creation and for every status change, none with message text', () => {
    for (const plan of plans) {
      const actions = plan.audits.map((row) => row.action);
      expect(
        actions.filter((action) => action === 'ticket.create'),
        plan.spec.key,
      ).toHaveLength(1);
      const changes = plan.events.filter((event) => event.type === 'ticket.status_changed').length;
      expect(actions.filter((action) => action === 'ticket.status_change')).toHaveLength(changes);
    }
    const everything = JSON.stringify(plans.flatMap((plan) => plan.audits));
    expect(everything).not.toContain('502 intermittently');
  });

  it('starts every ticket at the intent autonomy stage 2 and never marks it AI-handled (N3)', () => {
    for (const plan of plans) {
      expect(plan.ticket.autonomyStageAtCreation).toBe(2);
      expect(plan.ticket.aiHandled).toBe(false);
    }
  });

  it('never dates anything before the floor, and keeps events in order', () => {
    const floor = new Date(NOW.getTime() - 2 * 24 * 3600 * 1000);
    for (const spec of DEMO_TICKETS) {
      const plan = planTicket(spec, context({ floor }));
      expect(plan.ticket.createdAt?.getTime()).toBeGreaterThanOrEqual(floor.getTime());
      const times = plan.events.map((event) => event.createdAt?.getTime() ?? 0);
      expect(times).toEqual(times.toSorted((a, b) => a - b));
    }
  });

  it('gives no due dates to an organization without an SLA policy, and says so in the ticket', () => {
    const plan = planTicket(
      DEMO_TICKETS[0] as (typeof DEMO_TICKETS)[number],
      context({
        orgs: {
          ...context().orgs,
          acme: { id: 'org-acme', policy: null, clientUserId: 'client-acme' },
        },
      }),
    );
    expect(plan.ticket.slaPolicyId).toBeNull();
    expect(plan.ticket.firstResponseDueAt).toBeNull();
  });

  it('compresses a script that no longer fits after the floor moved its start, keeping the order', () => {
    const spec = DEMO_TICKETS.find(
      (entry) => entry.key === 'demo-08',
    ) as (typeof DEMO_TICKETS)[number];
    const floor = new Date(NOW.getTime() - 24 * 3600 * 1000);
    const plan = planTicket(spec, context({ floor }));
    expect(plan.scale).toBeLessThan(1);
    expect(plan.ticket.createdAt).toEqual(floor);
    expect(plan.lastAt.getTime()).toBeLessThan(NOW.getTime());
    const times = plan.events.map((event) => event.createdAt?.getTime() ?? 0);
    expect(times).toEqual(times.toSorted((a, b) => a - b));
  });

  it('refuses a script with no room at all between creation and the start of the seed', () => {
    const spec = { ...(DEMO_TICKETS[0] as (typeof DEMO_TICKETS)[number]), ageHours: 0 };
    expect(() => planTicket(spec, context())).toThrow(/raise ageHours/);
  });

  it('refuses an unknown intent', () => {
    const spec = { ...(DEMO_TICKETS[0] as (typeof DEMO_TICKETS)[number]), intent: 'nope' };
    expect(() => planTicket(spec, context())).toThrow(/unknown intent/);
  });
});
