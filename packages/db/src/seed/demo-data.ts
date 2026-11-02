import type { TicketPriority, TicketStatus } from '@watchtower/shared';

/**
 * The demo content of the development seed (T-008): fictional organizations, people and tickets.
 * Everything here is invented (N1): reserved example domains, made-up company names, people named
 * "Demo". Nothing is a real customer, procedure or contract.
 *
 * Tickets are scripts: a first message and a list of steps (assign, status change, reply, note,
 * customer follow-up). `tickets.ts` plays a script the way the API would, so the events, audit rows
 * and SLA dates of a seeded ticket come out as if people had really worked on it.
 */

export const ORG_KEYS = ['acme', 'borealis', 'cedar'] as const;
export type OrgKey = (typeof ORG_KEYS)[number];

export const STAFF_KEYS = [
  'head1',
  'head2',
  'lead1',
  'lead2',
  'agent1',
  'agent2',
  'agent3',
  'agent4',
  'dev1',
  'dev2',
] as const;
export type StaffKey = (typeof STAFF_KEYS)[number];

export const QUEUE_KEYS = ['support', 'integrations', 'billing'] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];

export interface DemoOrg {
  readonly key: OrgKey;
  readonly name: string;
  readonly tier: string;
  readonly domains: readonly string[];
  readonly notes: string;
  readonly contacts: readonly {
    readonly name: string;
    readonly email: string;
    readonly roleInOrg: string;
  }[];
  /** A client user (portal sign-in) of the organization. */
  readonly clientUser: { readonly email: string; readonly name: string };
}

export const DEMO_ORGS: readonly DemoOrg[] = [
  {
    key: 'acme',
    name: 'Acme Logistics',
    tier: 'gold',
    domains: ['acme-logistics.example.com'],
    notes: 'Fictional demo organization (gold tier).',
    contacts: [
      {
        name: 'Pim Demo',
        email: 'pim@acme-logistics.example.com',
        roleInOrg: 'Operations manager',
      },
      { name: 'Chai Demo', email: 'chai@acme-logistics.example.com', roleInOrg: 'Developer' },
      { name: 'Mali Demo', email: 'mali@acme-logistics.example.com', roleInOrg: 'Finance' },
    ],
    clientUser: { email: 'portal@acme-logistics.example.com', name: 'Acme Portal Demo' },
  },
  {
    key: 'borealis',
    name: 'Borealis Foods',
    tier: 'silver',
    domains: ['borealis-foods.example.org'],
    notes: 'Fictional demo organization (silver tier).',
    contacts: [
      {
        name: 'Ploy Demo',
        email: 'ploy@borealis-foods.example.org',
        roleInOrg: 'Quality manager',
      },
      { name: 'Nat Demo', email: 'nat@borealis-foods.example.org', roleInOrg: 'IT officer' },
    ],
    clientUser: { email: 'portal@borealis-foods.example.org', name: 'Borealis Portal Demo' },
  },
  {
    key: 'cedar',
    name: 'Cedar Retail',
    tier: 'standard',
    domains: ['cedar-retail.example.net'],
    notes: 'Fictional demo organization (standard tier).',
    contacts: [
      { name: 'Ben Demo', email: 'ben@cedar-retail.example.net', roleInOrg: 'Store operations' },
      { name: 'Kate Demo', email: 'kate@cedar-retail.example.net', roleInOrg: 'Analyst' },
      { name: 'Lek Demo', email: 'lek@cedar-retail.example.net', roleInOrg: 'Owner' },
    ],
    clientUser: { email: 'portal@cedar-retail.example.net', name: 'Cedar Portal Demo' },
  },
];

/**
 * Two people per human role (PRD section 2.2), four agents; staff addresses use the SSO example domain.
 * The two developers (T-137) are in no queue: a ticket is never assigned to a developer.
 */
export const DEMO_STAFF: readonly {
  readonly key: StaffKey;
  readonly email: string;
  readonly name: string;
  readonly role: 'head' | 'lead' | 'agent' | 'dev';
}[] = [
  { key: 'head1', email: 'head1@example.com', name: 'Demo Head 1', role: 'head' },
  { key: 'head2', email: 'head2@example.com', name: 'Demo Head 2', role: 'head' },
  { key: 'lead1', email: 'lead1@example.com', name: 'Demo Lead 1', role: 'lead' },
  { key: 'lead2', email: 'lead2@example.com', name: 'Demo Lead 2', role: 'lead' },
  { key: 'agent1', email: 'agent1@example.com', name: 'Demo Agent 1', role: 'agent' },
  { key: 'agent2', email: 'agent2@example.com', name: 'Demo Agent 2', role: 'agent' },
  { key: 'agent3', email: 'agent3@example.com', name: 'Demo Agent 3', role: 'agent' },
  { key: 'agent4', email: 'agent4@example.com', name: 'Demo Agent 4', role: 'agent' },
  { key: 'dev1', email: 'dev1@example.com', name: 'Demo Dev 1', role: 'dev' },
  { key: 'dev2', email: 'dev2@example.com', name: 'Demo Dev 2', role: 'dev' },
];

export const DEMO_QUEUES: readonly {
  readonly key: QueueKey;
  readonly name: string;
  readonly isDefault: boolean;
  readonly members: readonly StaffKey[];
}[] = [
  {
    key: 'support',
    name: 'Support',
    isDefault: true,
    members: ['lead1', 'agent1', 'agent2', 'agent3', 'agent4'],
  },
  {
    key: 'integrations',
    name: 'Integrations',
    isDefault: false,
    members: ['lead2', 'agent3', 'agent4'],
  },
  { key: 'billing', name: 'Billing', isDefault: false, members: ['lead1', 'agent2'] },
];

// --- ticket scripts ---

type Timed = { readonly afterMin: number };
export type SettableStatus = Exclude<TicketStatus, 'merged'>;

export type Step = Timed &
  (
    | { readonly do: 'assign'; readonly to: StaffKey | null }
    | { readonly do: 'status'; readonly to: SettableStatus; readonly reason?: string }
    | {
        readonly do: 'reply';
        readonly by: StaffKey;
        readonly body: string;
        readonly setStatus?: SettableStatus;
      }
    | { readonly do: 'client'; readonly body: string }
    | { readonly do: 'note'; readonly by: StaffKey; readonly body: string }
  );

export interface TicketSpec {
  /** Stable key, also the provider message id of the first message: it makes the seed idempotent. */
  readonly key: string;
  readonly org: OrgKey;
  /** Index into the organization's contacts. */
  readonly contact: number;
  readonly subject: string;
  readonly body: string;
  readonly intent: string;
  readonly priority?: TicketPriority;
  readonly queue: QueueKey;
  /** The ticket was created this many hours before the seed ran. */
  readonly ageHours: number;
  readonly steps: readonly Step[];
  /** Merge this ticket into another of the same organization after its steps. */
  readonly mergeInto?: { readonly key: string; readonly afterMin: number; readonly reason: string };
}

const assign = (to: StaffKey | null, afterMin = 10): Step => ({ do: 'assign', to, afterMin });
const status = (to: SettableStatus, afterMin = 10, reason?: string): Step => ({
  do: 'status',
  to,
  afterMin,
  ...(reason === undefined ? {} : { reason }),
});
const reply = (by: StaffKey, body: string, afterMin = 30, setStatus?: SettableStatus): Step => ({
  do: 'reply',
  by,
  body,
  afterMin,
  ...(setStatus === undefined ? {} : { setStatus }),
});
const client = (body: string, afterMin = 60): Step => ({ do: 'client', body, afterMin });
const note = (by: StaffKey, body: string, afterMin = 15): Step => ({
  do: 'note',
  by,
  body,
  afterMin,
});

const DAY = 24 * 60;

export const DEMO_TICKETS: readonly TicketSpec[] = [
  // --- Acme Logistics (gold) ---
  {
    key: 'demo-01',
    org: 'acme',
    contact: 1,
    subject: 'Shipments endpoint returns 502 intermittently',
    body: 'Since about 08:40 this morning roughly one in five calls to the shipments endpoint fails with HTTP 502. It retries fine a few seconds later. Request IDs follow in my next message.',
    intent: 'api_error',
    queue: 'integrations',
    ageHours: 70,
    steps: [
      assign('agent3'),
      status('triage', 5),
      note('agent3', 'Looks tied to the gateway restart window. Pulling logs for the key.', 20),
      status('open', 15),
      reply(
        'agent3',
        'Thank you for the details. We see a short burst of 502 responses from the gateway between 08:35 and 09:10 and are checking the cause. We will update you here.',
        35,
      ),
    ],
  },
  {
    key: 'demo-02',
    org: 'acme',
    contact: 0,
    subject: 'ไม่ได้รับ webhook แจ้งสถานะการจัดส่งตั้งแต่เมื่อวาน',
    body: 'ตั้งแต่เมื่อวานช่วงเย็น ระบบของเราไม่ได้รับ webhook สถานะการจัดส่งเลย ทั้งที่ endpoint ปลายทางยังทำงานปกติ รบกวนช่วยตรวจสอบให้ด้วยครับ',
    intent: 'webhook_not_received',
    queue: 'integrations',
    ageHours: 40,
    steps: [
      assign('agent4'),
      status('open', 5),
      reply(
        'agent4',
        'ขอบคุณที่แจ้งครับ ตรวจพบว่า endpoint ของท่านตอบกลับ 404 ตั้งแต่เมื่อวานเย็น รบกวนยืนยันว่ามีการเปลี่ยน path หรือไม่ครับ',
        40,
        'waiting_on_customer',
      ),
    ],
  },
  {
    key: 'demo-03',
    org: 'acme',
    contact: 1,
    subject: 'Upstream carrier lookups time out after 30 seconds',
    body: 'Rate lookups that depend on the carrier service hang and then fail after 30 seconds. Other endpoints are fast. This started after lunch.',
    intent: 'upstream_timeout',
    queue: 'integrations',
    ageHours: 52,
    steps: [
      assign('agent4'),
      status('triage', 5),
      status('open', 20),
      note('agent4', 'The carrier sandbox is slow for everyone. Asked the platform team.', 25),
      reply(
        'agent4',
        'We confirmed the delay comes from the upstream carrier and have asked our platform team to look at the connection. We will keep you posted.',
        30,
      ),
      status('waiting_on_dev', 20),
    ],
  },
  {
    key: 'demo-04',
    org: 'acme',
    contact: 0,
    subject: 'Is there an outage? Dashboard will not load',
    body: 'None of our dispatchers can open the dashboard. It shows a blank page after login. Is the service down?',
    intent: 'incident_inquiry',
    priority: 'P1',
    queue: 'support',
    ageHours: 30,
    steps: [
      assign('agent1', 4),
      status('open', 3),
      reply(
        'agent1',
        'We are aware of an issue with the dashboard front end and are working on it now. Reloading after a few minutes may help.',
        6,
      ),
      note('agent1', 'Cache of the old bundle. Purged the CDN.', 30),
      reply(
        'agent1',
        'The dashboard is loading again after we purged a cache. Please let us know if you still see a blank page.',
        15,
      ),
      status('resolved', 20, 'cache purged'),
    ],
  },
  {
    key: 'demo-05',
    org: 'acme',
    contact: 2,
    subject: 'ประมวลผลรายงานประจำเดือนไม่สำเร็จ',
    body: 'รายงานค่าขนส่งประจำเดือนค้างที่สถานะ "กำลังประมวลผล" มากกว่า 3 ชั่วโมงแล้ว ไม่มีไฟล์ให้ดาวน์โหลดครับ',
    intent: 'processing_failure',
    queue: 'integrations',
    ageHours: 2,
    steps: [],
  },
  {
    key: 'demo-06',
    org: 'acme',
    contact: 0,
    subject: 'Warehouse system also gets 502 from the shipments API',
    body: 'Our warehouse system calls the same shipments endpoint and sees HTTP 502 errors several times an hour.',
    intent: 'api_error',
    queue: 'integrations',
    ageHours: 66,
    steps: [assign('agent3'), note('agent3', 'Same symptom as demo-01, merging.', 20)],
    mergeInto: { key: 'demo-01', afterMin: 10, reason: 'Same 502 incident' },
  },
  {
    key: 'demo-07',
    org: 'acme',
    contact: 1,
    subject: 'ระบบคลังสินค้าเจอ error 502 เหมือนกัน',
    body: 'ระบบคลังสินค้าของเราเรียก API จัดส่งแล้วได้ error 502 เป็นระยะ เหมือนที่ทีมเราแจ้งไปก่อนหน้านี้',
    intent: 'api_error',
    queue: 'integrations',
    ageHours: 64,
    steps: [assign('agent3')],
    mergeInto: { key: 'demo-01', afterMin: 25, reason: 'Duplicate of the open 502 report' },
  },
  {
    key: 'demo-08',
    org: 'acme',
    contact: 2,
    subject: 'Invoice report totals differ from our records',
    body: 'The October billing report shows a total about 3 percent higher than our own records. Could you check how usage was counted?',
    intent: 'billing_report',
    queue: 'billing',
    ageHours: 12 * 24,
    steps: [
      assign('agent2'),
      status('open', 10),
      reply(
        'agent2',
        'We compared the usage lines and found 14 test requests counted twice. A corrected report is attached to your account.',
        3 * 60,
      ),
      status('resolved', 30),
      status('closed', 2 * DAY),
    ],
  },
  {
    key: 'demo-09',
    org: 'acme',
    contact: 1,
    subject: 'ผลวิเคราะห์ของรอบเมื่อวานไม่ตรงกับที่คาดไว้',
    body: 'ผลลัพธ์ของงานวิเคราะห์เส้นทางรอบเมื่อวานต่างจากรอบก่อนมาก ทั้งที่ข้อมูลนำเข้าเหมือนเดิม ขอให้ช่วยตรวจสอบครับ',
    intent: 'result_dispute',
    queue: 'support',
    ageHours: 20,
    steps: [assign('agent1'), status('triage', 15)],
  },
  {
    key: 'demo-10',
    org: 'acme',
    contact: 0,
    subject: 'Cannot sign in after password reset',
    body: 'I reset my password but the sign in page still says my credentials are invalid.',
    intent: 'account_access',
    queue: 'support',
    ageHours: 6 * 24,
    steps: [
      assign('agent2'),
      status('open', 5),
      reply(
        'agent2',
        'We reset the lock on your account. Please try again and tell us if it still fails.',
        40,
      ),
      status('resolved', 10),
      client('It works for me, but another colleague now sees the same message.', 5 * 60),
      reply(
        'agent2',
        "Could you share your colleague's email address so we can check their account too?",
        30,
      ),
    ],
  },
  {
    key: 'demo-11',
    org: 'acme',
    contact: 1,
    subject: 'Change the default workspace time zone',
    body: 'Please set the default time zone of our workspace to Asia/Bangkok. Reports currently use UTC.',
    intent: 'workspace_config',
    queue: 'support',
    ageHours: 9 * 24,
    steps: [
      assign('agent1'),
      status('open', 10),
      reply(
        'agent1',
        'Done. New reports use Asia/Bangkok; reports already generated keep UTC.',
        120,
      ),
      status('resolved', 15),
      status('closed', 2 * DAY),
    ],
  },
  {
    key: 'demo-12',
    org: 'acme',
    contact: 2,
    subject: 'สอบถามขั้นตอนการขอเอกสารรับรองบริการ',
    body: 'บริษัทต้องการเอกสารรับรองการใช้บริการสำหรับยื่นประกอบงบ ต้องติดต่อใครหรือทำอย่างไรครับ',
    intent: 'other',
    queue: 'support',
    ageHours: 1,
    steps: [],
  },

  // --- Borealis Foods (silver) ---
  {
    key: 'demo-13',
    org: 'borealis',
    contact: 0,
    subject: 'ไฟล์ผลตรวจคุณภาพประมวลผลไม่เสร็จ',
    body: 'อัปโหลดไฟล์ผลตรวจคุณภาพล็อตเมื่อเช้าไปแล้ว แต่สถานะค้างและไม่มีรายงานออกมา ลองอัปโหลดซ้ำก็เหมือนเดิม',
    intent: 'processing_failure',
    queue: 'integrations',
    ageHours: 36,
    steps: [
      assign('agent4'),
      status('triage', 10),
      status('open', 20),
      note('agent4', 'Job stuck on parsing step; file has a BOM at the start.', 30),
      reply(
        'agent4',
        'ขอบคุณครับ พบว่าไฟล์มีอักขระพิเศษตอนต้นไฟล์ ทีมกำลังแก้ให้อ่านไฟล์ลักษณะนี้ได้ จะแจ้งผลอีกครั้งครับ',
        20,
      ),
    ],
  },
  {
    key: 'demo-14',
    org: 'borealis',
    contact: 1,
    subject: 'Billing report is missing one site',
    body: 'The monthly report lists four sites but we operate five. The Rayong site is not in the list.',
    intent: 'billing_report',
    queue: 'billing',
    ageHours: 5 * 24,
    steps: [
      assign('agent2'),
      status('open', 10),
      reply(
        'agent2',
        'Could you confirm the site code of the missing site? We cannot find one under that name.',
        50,
        'waiting_on_customer',
      ),
      client('The code is RY-02.', 6 * 60),
      reply(
        'agent2',
        'Thanks. The site was created in a different account; we are moving it over now.',
        60,
      ),
      status('waiting_on_customer', 20),
    ],
  },
  {
    key: 'demo-15',
    org: 'borealis',
    contact: 0,
    subject: 'เข้าสู่ระบบไม่ได้ หลังจากเปลี่ยนเครื่อง',
    body: 'พนักงานที่เพิ่งเปลี่ยนเครื่องใหม่เข้าสู่ระบบไม่ได้ ขึ้นว่าอุปกรณ์ไม่ได้รับอนุญาต',
    intent: 'account_access',
    queue: 'support',
    ageHours: 4 * 24,
    steps: [
      assign('agent1'),
      status('open', 10),
      reply(
        'agent1',
        'เราได้ล้างรายการอุปกรณ์เดิมของบัญชีนี้แล้ว ลองเข้าสู่ระบบอีกครั้งได้เลยครับ',
        45,
      ),
      status('resolved', 20),
    ],
  },
  {
    key: 'demo-16',
    org: 'borealis',
    contact: 1,
    subject: 'Webhook for batch completion never arrives',
    body: 'We registered a webhook for batch completion last week. It has never been called, although batches complete normally.',
    intent: 'webhook_not_received',
    queue: 'integrations',
    ageHours: 60,
    steps: [
      assign('agent3'),
      status('open', 15),
      note('agent3', 'Subscription exists but filtered on an event name that does not exist.', 30),
      reply(
        'agent3',
        'The subscription filters on an event name we do not emit. We are confirming the right name with our developers.',
        25,
      ),
      status('waiting_on_dev', 15),
    ],
  },
  {
    key: 'demo-17',
    org: 'borealis',
    contact: 0,
    subject: 'Does the platform support exporting to Excel?',
    body: 'Can reports be exported directly to Excel, or only to CSV?',
    intent: 'feature_question',
    queue: 'support',
    ageHours: 11 * 24,
    steps: [
      assign('agent1'),
      status('open', 10),
      reply(
        'agent1',
        'Reports export to CSV and PDF today; Excel export is on our wishlist. CSV opens in Excel directly.',
        90,
      ),
      status('resolved', 20),
      status('closed', 3 * DAY),
    ],
  },
  {
    key: 'demo-18',
    org: 'borealis',
    contact: 1,
    subject: 'ผลคะแนนคุณภาพไม่ตรงกับที่คำนวณเอง',
    body: 'คะแนนคุณภาพของล็อตที่ 7 ในระบบต่างจากที่เราคำนวณเองประมาณ 2 คะแนน ช่วยอธิบายวิธีคำนวณหน่อยครับ',
    intent: 'result_dispute',
    queue: 'support',
    ageHours: 15,
    steps: [assign('agent2'), status('triage', 20)],
  },
  {
    key: 'demo-19',
    org: 'borealis',
    contact: 0,
    subject: 'Quality file upload also stuck',
    body: 'A second batch file is stuck in processing as well.',
    intent: 'upstream_timeout',
    queue: 'integrations',
    ageHours: 30,
    steps: [assign('agent4')],
    mergeInto: { key: 'demo-13', afterMin: 30, reason: 'Same stuck-file cause' },
  },
  {
    key: 'demo-20',
    org: 'borealis',
    contact: 1,
    subject: 'มีเหตุขัดข้องกับระบบรายงานหรือไม่',
    body: 'หน้ารายงานโหลดช้ามากตั้งแต่เช้า ขอสอบถามว่ามีเหตุขัดข้องอยู่หรือไม่ครับ',
    intent: 'incident_inquiry',
    queue: 'support',
    ageHours: 3,
    steps: [],
  },
  {
    key: 'demo-21',
    org: 'borealis',
    contact: 0,
    subject: 'Add two users to the quality workspace',
    body: 'Please add two new colleagues to the quality workspace with read-only access. Their addresses are in the attached form.',
    intent: 'workspace_config',
    queue: 'support',
    ageHours: 28,
    steps: [
      assign('agent1'),
      status('open', 10),
      reply('agent1', 'We have the form. We will add them today and confirm here.', 30),
    ],
  },
  {
    key: 'demo-22',
    org: 'borealis',
    contact: 1,
    subject: 'API คืนค่า 429 บ่อยผิดปกติ',
    body: 'ตั้งแต่เมื่อวาน API ตอบ 429 ทั้งที่เราเรียกไม่ถี่กว่าเดิม ขอให้ตรวจสอบโควตาของบัญชีด้วยครับ',
    intent: 'api_error',
    queue: 'integrations',
    ageHours: 3 * 24,
    steps: [
      assign('agent3'),
      status('open', 10),
      reply('agent3', 'พบว่าโควตาต่อนาทีของคีย์ลดลงหลังปรับแพ็กเกจ เราคืนค่าเดิมให้แล้วครับ', 80),
      status('resolved', 15),
    ],
  },

  // --- Cedar Retail (standard) ---
  {
    key: 'demo-23',
    org: 'cedar',
    contact: 1,
    subject: 'Can we schedule a report to run every Monday?',
    body: 'We would like the sales report to run automatically every Monday morning and be emailed to three people.',
    intent: 'feature_question',
    queue: 'support',
    ageHours: 7 * 24,
    steps: [
      assign('agent2'),
      status('open', 15),
      reply(
        'agent2',
        'Yes. Open the report, choose Schedule, then pick Monday and add the three addresses. Tell us if you cannot find it.',
        60,
      ),
      status('resolved', 25),
    ],
  },
  {
    key: 'demo-24',
    org: 'cedar',
    contact: 0,
    subject: 'ตั้งค่าเวลาปิดร้านในระบบไม่ถูกต้อง',
    body: 'เวลาปิดร้านที่ตั้งไว้ในระบบเป็น 18:00 แต่จริง ๆ เราปิด 21:00 ช่วยแก้การตั้งค่าให้หน่อยครับ',
    intent: 'workspace_config',
    queue: 'support',
    ageHours: 32,
    steps: [
      assign('agent1'),
      status('open', 20),
      note('agent1', 'Store hours are per site, not per workspace. Asking which site.', 25),
    ],
  },
  {
    key: 'demo-25',
    org: 'cedar',
    contact: 2,
    subject: 'ฟีเจอร์แจ้งเตือนสต็อกใกล้หมดมีไหม',
    body: 'อยากทราบว่าระบบแจ้งเตือนเมื่อสินค้าใกล้หมดสต็อกได้หรือไม่ และตั้งค่าตรงไหน',
    intent: 'feature_question',
    queue: 'support',
    ageHours: 2 * 24,
    steps: [
      assign('agent2'),
      status('open', 10),
      reply(
        'agent2',
        'ทำได้ครับ แต่ต้องเปิดใช้โมดูลสต็อกก่อน ท่านใช้โมดูลนี้อยู่หรือไม่ครับ',
        50,
        'waiting_on_customer',
      ),
    ],
  },
  {
    key: 'demo-26',
    org: 'cedar',
    contact: 0,
    subject: 'Locked out of the owner account',
    body: 'Our owner account is locked after several wrong attempts. The owner is travelling and needs access today.',
    intent: 'account_access',
    queue: 'support',
    ageHours: 20,
    steps: [
      assign('agent1'),
      status('open', 8),
      reply(
        'agent1',
        'To unlock the account we need to confirm it is you. Please reply with the last four digits of the phone number on the account.',
        25,
        'waiting_on_customer',
      ),
    ],
  },
  {
    key: 'demo-27',
    org: 'cedar',
    contact: 1,
    subject: 'Nightly sales import failed three nights in a row',
    body: 'The nightly sales import has failed for three nights. The log only says "import aborted".',
    intent: 'processing_failure',
    queue: 'integrations',
    ageHours: 4 * 24,
    steps: [
      assign('agent3'),
      status('open', 15),
      note('agent3', 'Fails when a CSV row has an unescaped quote. Needs a parser fix.', 40),
      reply(
        'agent3',
        'We found that rows with a stray quote make the import abort. A fix is with our developers; we will tell you when it is released.',
        30,
      ),
      status('waiting_on_dev', 20),
    ],
  },
  {
    key: 'demo-28',
    org: 'cedar',
    contact: 2,
    subject: 'ขอใบเสนอราคาเพิ่มสาขา',
    body: 'เรากำลังจะเปิดร้านสาขาที่ 4 ขอใบเสนอราคาสำหรับเพิ่มสาขาในระบบหน่อยครับ',
    intent: 'other',
    queue: 'support',
    ageHours: 4,
    steps: [],
  },
  {
    key: 'demo-29',
    org: 'cedar',
    contact: 1,
    subject: 'Monthly usage report seems to be missing last week',
    body: 'The usage report starts on the 8th instead of the 1st. Can you check why?',
    intent: 'billing_report',
    queue: 'billing',
    ageHours: 14,
    steps: [assign('agent2'), status('triage', 30)],
  },
  {
    key: 'demo-30',
    org: 'cedar',
    contact: 0,
    subject: 'คะแนนความพึงพอใจของลูกค้าที่คำนวณได้ดูผิดปกติ',
    body: 'คะแนนความพึงพอใจเฉลี่ยของเดือนนี้ขึ้นมา 4.9 ทั้งที่มีลูกค้าบ่นเยอะ ขอให้ตรวจสูตรคำนวณด้วยครับ',
    intent: 'result_dispute',
    queue: 'support',
    ageHours: 2 * 24,
    steps: [
      assign('agent1'),
      status('open', 20),
      reply(
        'agent1',
        'เราจะตรวจสอบสูตรและตัวอย่างข้อมูลของเดือนนี้ แล้วแจ้งผลกลับภายในวันนี้ครับ',
        90,
      ),
    ],
  },
];
