import { DAY, type Rng } from './prng.js';

/**
 * The cast of the one-year scenario: a fictional B2B SaaS Tech Ops team and its customer
 * organizations. Everything is invented (N1): made-up company names under reserved example
 * domains, made-up people, no phone numbers or national ids.
 */

export type Lang = 'th' | 'en';
export type StaffRole = 'head' | 'lead' | 'agent' | 'dev';

export interface WorldStaff {
  readonly key: string;
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: StaffRole;
  /** Title shown in signatures. */
  readonly title: string;
  readonly createdAt: Date;
  /** Queue names the person belongs to. */
  readonly queues: readonly string[];
}

export interface WorldContact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly roleInOrg: string;
  readonly lang: Lang;
  /** LINE user id when the person writes to the LINE official account. */
  readonly lineUserId: string | null;
  readonly createdAt: Date;
}

export interface WorldOrg {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly tier: 'gold' | 'silver' | 'standard';
  readonly domain: string;
  readonly lang: Lang;
  readonly industry: string;
  /** Relative ticket volume. */
  readonly weight: number;
  readonly createdAt: Date;
  readonly contacts: readonly WorldContact[];
  readonly clientUser: { readonly id: string; readonly email: string; readonly name: string };
  readonly lineGroupId: string | null;
}

export interface World {
  readonly staff: readonly WorldStaff[];
  readonly orgs: readonly WorldOrg[];
}

/** Staff addresses use a reserved example domain. */
export const STAFF_DOMAIN = 'ops.example.com';

interface StaffStem {
  readonly key: string;
  readonly local: string;
  readonly name: string;
  readonly role: StaffRole;
  readonly title: string;
  readonly queues: readonly string[];
  readonly sinceDay: number;
}

const STAFF: readonly StaffStem[] = [
  {
    key: 'head-owner',
    local: 'nattaya.w',
    name: 'Nattaya Wongsawat',
    role: 'head',
    title: 'Head of Tech Operations',
    queues: [],
    sinceDay: 420,
  },
  {
    key: 'head-admin',
    local: 'daniel.h',
    name: 'Daniel Hartmann',
    role: 'head',
    title: 'Operations Administrator',
    queues: [],
    sinceDay: 420,
  },
  {
    key: 'lead-1',
    local: 'somchai.r',
    name: 'Somchai Rattanakul',
    role: 'lead',
    title: 'Support Team Lead',
    queues: ['Support', 'Billing'],
    sinceDay: 400,
  },
  {
    key: 'lead-2',
    local: 'priya.n',
    name: 'Priya Nair',
    role: 'lead',
    title: 'Integrations Team Lead',
    queues: ['Integrations', 'Support'],
    sinceDay: 400,
  },
  {
    key: 'agent-1',
    local: 'kanya.s',
    name: 'Kanya Suwan',
    role: 'agent',
    title: 'Support Engineer',
    queues: ['Support', 'Billing'],
    sinceDay: 395,
  },
  {
    key: 'agent-2',
    local: 'arthit.b',
    name: 'Arthit Boonmee',
    role: 'agent',
    title: 'Support Engineer',
    queues: ['Support'],
    sinceDay: 395,
  },
  {
    key: 'agent-3',
    local: 'mei.t',
    name: 'Mei Tanaka',
    role: 'agent',
    title: 'Integration Engineer',
    queues: ['Integrations', 'Support'],
    sinceDay: 380,
  },
  {
    key: 'agent-4',
    local: 'tom.b',
    name: 'Tom Becker',
    role: 'agent',
    title: 'Support Engineer',
    queues: ['Support', 'Integrations'],
    sinceDay: 300,
  },
  {
    key: 'agent-5',
    local: 'waraporn.c',
    name: 'Waraporn Chaiyo',
    role: 'agent',
    title: 'Billing Specialist',
    queues: ['Billing', 'Support'],
    sinceDay: 230,
  },
  {
    key: 'dev-1',
    local: 'anan.p',
    name: 'Anan Prasert',
    role: 'dev',
    title: 'Backend Developer',
    queues: [],
    sinceDay: 410,
  },
  {
    key: 'dev-2',
    local: 'ivan.p',
    name: 'Ivan Petrov',
    role: 'dev',
    title: 'Platform Engineer',
    queues: [],
    sinceDay: 410,
  },
  {
    key: 'dev-3',
    local: 'sarah.c',
    name: 'Sarah Collins',
    role: 'dev',
    title: 'Integrations Developer',
    queues: [],
    sinceDay: 330,
  },
];

interface OrgStem {
  readonly name: string;
  readonly slug: string;
  readonly tier: 'gold' | 'silver' | 'standard';
  readonly lang: Lang;
  readonly industry: string;
  readonly weight: number;
  /** Days before the end of the scenario that the organization was onboarded. */
  readonly ageDays: number;
}

const ORG_STEMS: readonly OrgStem[] = [
  {
    name: 'Kestrel Freight',
    slug: 'kestrel-freight',
    tier: 'gold',
    lang: 'en',
    industry: 'logistics',
    weight: 5,
    ageDays: 400,
  },
  {
    name: 'Marigold Foods',
    slug: 'marigold-foods',
    tier: 'gold',
    lang: 'th',
    industry: 'food',
    weight: 4,
    ageDays: 400,
  },
  {
    name: 'Tidewater Retail',
    slug: 'tidewater-retail',
    tier: 'gold',
    lang: 'en',
    industry: 'retail',
    weight: 5,
    ageDays: 395,
  },
  {
    name: 'Baan Suan Hotels',
    slug: 'baansuan-hotels',
    tier: 'gold',
    lang: 'th',
    industry: 'hospitality',
    weight: 3.5,
    ageDays: 390,
  },
  {
    name: 'Orchid Pay',
    slug: 'orchid-pay',
    tier: 'gold',
    lang: 'th',
    industry: 'fintech',
    weight: 5.5,
    ageDays: 380,
  },
  {
    name: 'Granite Mobility',
    slug: 'granite-mobility',
    tier: 'gold',
    lang: 'en',
    industry: 'mobility',
    weight: 3,
    ageDays: 360,
  },
  {
    name: 'Bluefern Clinics',
    slug: 'bluefern-clinics',
    tier: 'silver',
    lang: 'th',
    industry: 'healthcare',
    weight: 2.5,
    ageDays: 400,
  },
  {
    name: 'Copperline Energy',
    slug: 'copperline-energy',
    tier: 'silver',
    lang: 'en',
    industry: 'energy',
    weight: 2,
    ageDays: 370,
  },
  {
    name: 'Sawasdee Fresh Market',
    slug: 'sawasdee-fresh',
    tier: 'silver',
    lang: 'th',
    industry: 'retail',
    weight: 3,
    ageDays: 350,
  },
  {
    name: 'Lumen Harbor Logistics',
    slug: 'lumenharbor',
    tier: 'silver',
    lang: 'en',
    industry: 'logistics',
    weight: 2.5,
    ageDays: 340,
  },
  {
    name: 'Praew Textile Group',
    slug: 'praew-textile',
    tier: 'silver',
    lang: 'th',
    industry: 'manufacturing',
    weight: 2,
    ageDays: 330,
  },
  {
    name: 'Northgate Insurance Brokers',
    slug: 'northgate-brokers',
    tier: 'silver',
    lang: 'en',
    industry: 'insurance',
    weight: 2,
    ageDays: 300,
  },
  {
    name: 'Mango Tree Education',
    slug: 'mangotree-edu',
    tier: 'silver',
    lang: 'th',
    industry: 'education',
    weight: 1.8,
    ageDays: 280,
  },
  {
    name: 'Alder Grove Pharmacy',
    slug: 'aldergrove-pharmacy',
    tier: 'silver',
    lang: 'en',
    industry: 'healthcare',
    weight: 1.5,
    ageDays: 260,
  },
  {
    name: 'Thanya Auto Parts',
    slug: 'thanya-autoparts',
    tier: 'silver',
    lang: 'th',
    industry: 'automotive',
    weight: 2.2,
    ageDays: 240,
  },
  {
    name: 'Summit Ridge Outdoor',
    slug: 'summitridge',
    tier: 'silver',
    lang: 'en',
    industry: 'retail',
    weight: 1.4,
    ageDays: 200,
  },
  {
    name: 'Ruean Thai Catering',
    slug: 'ruean-catering',
    tier: 'silver',
    lang: 'th',
    industry: 'food',
    weight: 1.2,
    ageDays: 170,
  },
  {
    name: 'Quartz Bay Properties',
    slug: 'quartzbay',
    tier: 'standard',
    lang: 'en',
    industry: 'real estate',
    weight: 1.2,
    ageDays: 390,
  },
  {
    name: 'Lotus Print Studio',
    slug: 'lotus-print',
    tier: 'standard',
    lang: 'th',
    industry: 'media',
    weight: 0.9,
    ageDays: 380,
  },
  {
    name: 'Fernwood Tutoring',
    slug: 'fernwood-tutoring',
    tier: 'standard',
    lang: 'en',
    industry: 'education',
    weight: 0.8,
    ageDays: 360,
  },
  {
    name: 'Siam Orchard Farms',
    slug: 'siam-orchard',
    tier: 'standard',
    lang: 'th',
    industry: 'agriculture',
    weight: 1,
    ageDays: 350,
  },
  {
    name: 'Pebble Street Cafe Group',
    slug: 'pebblestreet',
    tier: 'standard',
    lang: 'en',
    industry: 'food',
    weight: 0.9,
    ageDays: 330,
  },
  {
    name: 'Chomphu Electronics',
    slug: 'chomphu-electronics',
    tier: 'standard',
    lang: 'th',
    industry: 'retail',
    weight: 1.1,
    ageDays: 310,
  },
  {
    name: 'Willow Creek Logistics',
    slug: 'willowcreek',
    tier: 'standard',
    lang: 'en',
    industry: 'logistics',
    weight: 1,
    ageDays: 290,
  },
  {
    name: 'Kaew Jewelry',
    slug: 'kaew-jewelry',
    tier: 'standard',
    lang: 'th',
    industry: 'retail',
    weight: 0.7,
    ageDays: 270,
  },
  {
    name: 'Harbor Light Dental',
    slug: 'harborlight-dental',
    tier: 'standard',
    lang: 'en',
    industry: 'healthcare',
    weight: 0.6,
    ageDays: 250,
  },
  {
    name: 'Phuket Sunrise Tours',
    slug: 'sunrise-tours',
    tier: 'standard',
    lang: 'th',
    industry: 'travel',
    weight: 1.2,
    ageDays: 220,
  },
  {
    name: 'Ironbark Engineering',
    slug: 'ironbark-eng',
    tier: 'standard',
    lang: 'en',
    industry: 'manufacturing',
    weight: 0.9,
    ageDays: 190,
  },
  {
    name: 'Nimman Coworking',
    slug: 'nimman-cowork',
    tier: 'standard',
    lang: 'th',
    industry: 'real estate',
    weight: 0.7,
    ageDays: 150,
  },
  {
    name: 'Aster Wellness',
    slug: 'aster-wellness',
    tier: 'standard',
    lang: 'en',
    industry: 'healthcare',
    weight: 0.8,
    ageDays: 120,
  },
  {
    name: 'Rimnam Fisheries',
    slug: 'rimnam-fisheries',
    tier: 'standard',
    lang: 'th',
    industry: 'agriculture',
    weight: 0.8,
    ageDays: 90,
  },
  {
    name: 'Cobalt Peak Games',
    slug: 'cobaltpeak',
    tier: 'standard',
    lang: 'en',
    industry: 'media',
    weight: 1,
    ageDays: 60,
  },
];

const TH_FIRST = [
  'Somying',
  'Preecha',
  'Malee',
  'Narong',
  'Supaporn',
  'Wichai',
  'Orathai',
  'Chaiwat',
  'Jiraporn',
  'Kittisak',
  'Ratana',
  'Thanakorn',
  'Siriwan',
  'Pongsakorn',
  'Duangjai',
  'Apichart',
  'Nipa',
  'Surachai',
  'Benjawan',
  'Teerapong',
  'Lalita',
  'Montri',
];
const TH_LAST = [
  'Sukjai',
  'Charoen',
  'Thongdee',
  'Rungrueang',
  'Saetang',
  'Phromma',
  'Kaewmanee',
  'Boonyarit',
  'Srisai',
  'Wattana',
  'Intharat',
  'Promsri',
  'Yodsuk',
  'Meechai',
  'Laohakul',
];
const EN_FIRST = [
  'Emma',
  'Oliver',
  'Grace',
  'Lucas',
  'Hannah',
  'Noah',
  'Chloe',
  'Ethan',
  'Isla',
  'Mateo',
  'Freya',
  'Jonas',
  'Amara',
  'Felix',
  'Nora',
  'Owen',
  'Leila',
  'Ravi',
];
const EN_LAST = [
  'Whitmore',
  'Alvarez',
  'Lindqvist',
  'Okafor',
  'Brennan',
  'Kowalski',
  'Nakamura',
  'Fischer',
  'Duarte',
  'Hargreaves',
  'Mercer',
  'Santoro',
  'Voss',
  'Pereira',
  'Calloway',
];
const ROLES_IN_ORG = [
  'IT officer',
  'Developer',
  'Finance',
  'Product owner',
  'Store operations',
  'Data analyst',
  'Owner',
  'Integration lead',
  'Customer service lead',
];

export function buildWorld(rng: Rng, endOfScenario: Date): World {
  const ago = (days: number): Date => new Date(endOfScenario.getTime() - days * DAY);
  const staff: WorldStaff[] = STAFF.map(({ sinceDay, local, ...rest }) => ({
    ...rest,
    email: `${local}@${STAFF_DOMAIN}`,
    id: rng.uuid(),
    createdAt: ago(sinceDay),
  }));

  const usedEmails = new Set<string>();
  const orgs: WorldOrg[] = ORG_STEMS.map((stem, index) => {
    const tld = ['com', 'org', 'net'][index % 3] as string;
    const domain = `${stem.slug}.example.${tld}`;
    const createdAt = ago(stem.ageDays);
    const contactCount = stem.tier === 'gold' ? rng.int(3, 4) : rng.int(2, 3);
    const contacts: WorldContact[] = [];
    for (let c = 0; c < contactCount; c += 1) {
      const lang: Lang = rng.chance(stem.lang === 'th' ? 0.85 : 0.1) ? 'th' : 'en';
      const first = lang === 'th' ? rng.pick(TH_FIRST) : rng.pick(EN_FIRST);
      const last = lang === 'th' ? rng.pick(TH_LAST) : rng.pick(EN_LAST);
      let local = `${first}.${last.slice(0, 1)}`.toLowerCase();
      while (usedEmails.has(`${local}@${domain}`)) local = `${local}${String(rng.int(2, 9))}`;
      const email = `${local}@${domain}`;
      usedEmails.add(email);
      contacts.push({
        id: rng.uuid(),
        name: `${first} ${last}`,
        email,
        roleInOrg: c === 0 ? 'Operations manager' : rng.pick(ROLES_IN_ORG),
        lang,
        lineUserId: rng.chance(stem.lang === 'th' ? 0.85 : 0.12) ? `U${rng.hex(32)}` : null,
        createdAt: new Date(createdAt.getTime() + c * 2 * DAY),
      });
    }
    return {
      index,
      id: rng.uuid(),
      name: stem.name,
      tier: stem.tier,
      domain,
      lang: stem.lang,
      industry: stem.industry,
      weight: stem.weight,
      createdAt,
      contacts,
      clientUser: {
        id: rng.uuid(),
        email: `portal@${domain}`,
        name: `${stem.name} Portal`,
      },
      lineGroupId: stem.lang === 'th' && stem.tier !== 'standard' ? `Cyr${rng.hex(30)}` : null,
    };
  });
  return { staff, orgs };
}
