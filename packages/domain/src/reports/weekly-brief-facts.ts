import type { Database } from '@watchtower/db';
import {
  formatIncidentKey,
  type CeoView,
  type ClaimEvidenceKind,
  type WeeklyBriefLocale,
} from '@watchtower/shared';
import { sql } from 'drizzle-orm';

import type { SeedPort } from './seed-filter.js';
import type { TicketKeys } from '../ticket-keys.js';

type Db = Database['db'];
type Row = Record<string, unknown>;

/**
 * One thing the code read this week, as text for the model and a chip for the reader (T-135, T-305c). Built from
 * the real figures of the CEO view and from rows read with no model in between: the model only rewords them
 * and says which ones a sentence rests on. `ticketId` is for the caller to look up the names of the people in
 * the subject (redaction, N4); it never reaches the model or the page.
 */
export interface BriefFact {
  readonly kind: ClaimEvidenceKind;
  readonly label: string;
  readonly href?: string;
  readonly text: string;
  readonly ticketId?: string;
  readonly mock?: boolean;
}

export interface WeeklyFacts {
  readonly facts: BriefFact[];
  /** Tickets whose subjects are in the facts. */
  readonly ticketIds: string[];
}

export const CEO_PAGE_HREF = '/dashboard/ceo';
export const ticketPageHref = (key: string): string => `/?ticket=${encodeURIComponent(key)}`;
export const incidentPageHref = (id: string): string =>
  `/incidents?incident=${encodeURIComponent(id)}`;

const t = (locale: WeeklyBriefLocale, th: string, en: string): string =>
  locale === 'th' ? th : en;
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const oneLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

const num = (row: Row, column: string): number => {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new Error(`column ${column} is not a number`);
  }
  return parsed;
};
const text = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
};

const MAX_INTENT_GROUPS = 6;
const SAMPLES_PER_INTENT = 2;
const MAX_FINDINGS = 8;
const MAX_INCIDENTS = 8;

const KPI_NAMES = {
  volume: ['จำนวนตั๋วใหม่', 'New tickets'],
  firstResponse: ['เวลาตอบครั้งแรก (มัธยฐาน)', 'First response (median)'],
  resolution: ['เวลาแก้เสร็จ (มัธยฐาน)', 'Time to resolve (median)'],
  sla: ['SLA ที่ทำได้', 'SLA compliance'],
  csat: ['CSAT', 'CSAT'],
  aiHandled: ['สัดส่วนที่ AI ช่วย', 'Share handled with AI'],
  verifiedResolution: ['การแก้ที่ยืนยันแล้ว', 'Verified resolutions'],
  automationSavings: ['เวลาที่ automation ประหยัด', 'Automation savings'],
} as const;

type KpiKey = keyof typeof KPI_NAMES;

function duration(seconds: number, locale: WeeklyBriefLocale): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} ${t(locale, 'นาที', 'min')}`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `${String(hours)} ${t(locale, 'ชม.', 'h')}`;
}
const percent = (value: number): string => `${String(Math.round(value * 1000) / 10)}%`;

function figureText(key: KpiKey, value: number, locale: WeeklyBriefLocale): string {
  switch (key) {
    case 'firstResponse':
    case 'resolution':
      return duration(value, locale);
    case 'sla':
    case 'aiHandled':
    case 'verifiedResolution':
      return percent(value);
    case 'csat':
      return `${String(Math.round(value * 100) / 100)}/5`;
    case 'automationSavings':
      return `${String(Math.round(value * 10) / 10)} ${t(locale, 'ชม.', 'h')}`;
    case 'volume':
      return String(Math.round(value));
  }
}

/** The figures of the CEO view as facts: the numbers the brief is made from, with last week's next to them. */
export function figureFacts(view: CeoView, locale: WeeklyBriefLocale): BriefFact[] {
  const facts: BriefFact[] = [];
  for (const key of Object.keys(KPI_NAMES) as KpiKey[]) {
    const [th, en] = KPI_NAMES[key];
    const name = t(locale, th, en);
    const figure = view.kpis[key];
    if (figure.status !== 'ok') {
      facts.push({
        kind: 'data',
        label: name,
        href: CEO_PAGE_HREF,
        text:
          figure.status === 'not_available' && figure.reason === 'needs_grader'
            ? t(
                locale,
                `${name}: ยังไม่มีข้อมูล เพราะยังไม่มีตั๋วที่ grader ตรวจ`,
                `${name}: not available, no ticket has been graded yet.`,
              )
            : t(locale, `${name}: ยังไม่มีข้อมูลในสัปดาห์นี้`, `${name}: no data in this period.`),
      });
      continue;
    }
    const { value, previous, samples } = figure.data;
    const before =
      previous === null
        ? t(locale, 'สัปดาห์ก่อนไม่มีข้อมูลเทียบ', 'no figure to compare with the period before')
        : t(
            locale,
            `ช่วงก่อนหน้า ${figureText(key, previous, locale)}`,
            `period before ${figureText(key, previous, locale)}`,
          );
    const assumed =
      key === 'automationSavings'
        ? t(
            locale,
            ` (สูตรสมมติ: ${String(view.formula.minutesPerTicket)} นาทีต่อตั๋วที่ AI ช่วย)`,
            ` (assumed formula: ${String(view.formula.minutesPerTicket)} minutes per AI-assisted ticket)`,
          )
        : '';
    facts.push({
      kind: 'data',
      label: name,
      href: CEO_PAGE_HREF,
      text: `${name}: ${figureText(key, value, locale)} (${before}; ${t(locale, 'จาก', 'from')} ${String(samples)} ${t(locale, 'รายการ', 'samples')})${assumed}.`,
    });
  }
  for (const tile of view.externalTiles) {
    const unit = tile.unit === '' ? '' : ` ${tile.unit}`;
    const before =
      tile.previous === null
        ? ''
        : ` (${t(locale, 'ก่อนหน้า', 'before')} ${String(tile.previous)}${unit})`;
    facts.push({
      kind: 'data',
      label: tile.label,
      href: CEO_PAGE_HREF,
      text: `${tile.label}: ${String(tile.value)}${unit}${before}, ${t(locale, 'ป้อนจากภายนอก ณ', 'fed from outside, observed')} ${tile.observedAt.slice(0, 10)}.`,
    });
  }
  return facts;
}

/**
 * Everything the week showed besides the figures: the incidents, the intents with most tickets (each with
 * its newest tickets), and what the investigations found. Read with the same seed rule as the figures.
 * Pure SQL, no model; the result is the evidence of the brief and nothing outside it can be cited.
 */
export async function weeklyBriefFacts(
  db: Db,
  input: {
    readonly view: CeoView;
    readonly locale: WeeklyBriefLocale;
    readonly keys: TicketKeys;
    readonly seed: SeedPort;
  },
): Promise<WeeklyFacts> {
  const { view, locale, keys } = input;
  const from = view.window.from;
  const to = view.window.to;
  const previousFrom = view.previous.from;
  const seedOnTicket = await input.seed.exclude('t');
  const facts: BriefFact[] = [];
  const ticketIds = new Set<string>();

  // --- incidents: open now, or started this week -------------------------------------------------------
  const incidents = (
    await db.execute(
      sql`SELECT i.id, i.number, i.title, i.severity, i.status, i.root_cause, i.started_at, i.resolved_at
        FROM incident i
        WHERE i.started_at >= ${from}::timestamptz AND i.started_at < ${to}::timestamptz
          OR i.status <> 'resolved'
        ORDER BY (i.status <> 'resolved') DESC, i.severity ASC, i.started_at DESC
        LIMIT ${MAX_INCIDENTS}`,
    )
  ).rows as Row[];
  const incidentStats = (
    await db.execute(
      sql`SELECT count(*)::int AS started,
          count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - started_at)::float8)
            FILTER (WHERE resolved_at IS NOT NULL) AS median_seconds
        FROM incident
        WHERE started_at >= ${from}::timestamptz AND started_at < ${to}::timestamptz`,
    )
  ).rows as Row[];
  const stats = incidentStats[0];
  if (stats !== undefined) {
    const started = num(stats, 'started');
    const median = stats.median_seconds === null ? null : num(stats, 'median_seconds');
    facts.push({
      kind: 'data',
      label: t(locale, 'เหตุการณ์ (incident)', 'Incidents'),
      href: '/incidents',
      text:
        started === 0
          ? t(locale, 'ไม่มี incident เริ่มในช่วงนี้', 'No incident started in this period.')
          : t(
              locale,
              `${String(started)} incident เริ่มในช่วงนี้ แก้เสร็จ ${String(num(stats, 'resolved'))}${median === null ? '' : ` เวลาแก้มัธยฐาน ${duration(median, locale)}`}`,
              `${String(started)} incidents started in this period, ${String(num(stats, 'resolved'))} resolved${median === null ? '' : `, median time to resolve ${duration(median, locale)}`}.`,
            ),
    });
  }
  for (const row of incidents) {
    const key = formatIncidentKey(num(row, 'number'));
    const cause = text(row, 'root_cause');
    facts.push({
      kind: 'incident',
      label: key,
      href: incidentPageHref(text(row, 'id')),
      text: `${key} "${cut(oneLine(text(row, 'title')), 160)}" (${text(row, 'severity')}, ${text(row, 'status')})${
        cause === ''
          ? t(locale, ' ยังไม่บันทึกสาเหตุ', ' no root cause recorded')
          : `${t(locale, ' สาเหตุที่บันทึก', ' recorded root cause')}: ${cut(oneLine(cause), 240)}`
      }.`,
    });
  }

  // --- intents with most tickets this week, against the week before -----------------------------------------
  const groups = (
    await db.execute(
      sql`SELECT i.id AS intent_id, i.key AS intent_key,
          count(*) FILTER (WHERE t.created_at >= ${from}::timestamptz)::int AS current,
          count(*) FILTER (WHERE t.created_at < ${from}::timestamptz)::int AS previous
        FROM ticket t JOIN intent i ON i.id = t.intent_id
        WHERE t.created_at >= ${previousFrom}::timestamptz AND t.created_at < ${to}::timestamptz
          AND t.status <> 'merged' AND ${seedOnTicket}
        GROUP BY i.id, i.key
        HAVING count(*) FILTER (WHERE t.created_at >= ${from}::timestamptz) > 0
        ORDER BY current DESC, i.key ASC
        LIMIT ${MAX_INTENT_GROUPS}`,
    )
  ).rows as Row[];
  const intentIds = groups.map((group) => text(group, 'intent_id'));
  const samples =
    intentIds.length === 0
      ? []
      : ((
          await db.execute(
            sql`SELECT * FROM (
              SELECT t.id, t.number, t.subject, t.status, t.intent_id,
                row_number() OVER (PARTITION BY t.intent_id ORDER BY t.created_at DESC, t.id DESC) AS rn
              FROM ticket t
              WHERE t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
                AND t.status <> 'merged' AND ${seedOnTicket}
                AND t.intent_id IN (${sql.join(
                  intentIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})
            ) ranked WHERE rn <= ${SAMPLES_PER_INTENT}`,
          )
        ).rows as Row[]);
  for (const group of groups) {
    const intent = text(group, 'intent_key');
    const current = num(group, 'current');
    const previous = num(group, 'previous');
    facts.push({
      kind: 'data',
      label: `intent: ${intent}`,
      text: t(
        locale,
        `intent ${intent}: ${String(current)} ตั๋วในช่วงนี้ (ช่วงก่อนหน้า ${String(previous)})`,
        `Intent ${intent}: ${String(current)} tickets in this period (${String(previous)} in the period before).`,
      ),
    });
    for (const sample of samples.filter(
      (row) => text(row, 'intent_id') === text(group, 'intent_id'),
    )) {
      const key = keys.format(num(sample, 'number'));
      ticketIds.add(text(sample, 'id'));
      facts.push({
        kind: 'ticket',
        label: key,
        href: ticketPageHref(key),
        ticketId: text(sample, 'id'),
        text: `${key} "${cut(oneLine(text(sample, 'subject')), 160)}" (${t(locale, 'intent', 'intent')} ${intent}, ${text(sample, 'status')}).`,
      });
    }
  }

  // --- what the investigations found --------------------------------------------------------------------------
  const findings = (
    await db.execute(
      sql`SELECT t.id, t.number, t.subject, a.intent_key,
          a.report->>'likelyCause' AS likely_cause, a.report->'findings'->0->>'text' AS first_finding
        FROM ai_ticket_insight a JOIN ticket t ON t.id = a.ticket_id
        WHERE a.report IS NOT NULL AND t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
          AND t.status <> 'merged' AND ${seedOnTicket}
          AND (a.report->>'likelyCause' IS NOT NULL OR a.report->'findings'->0->>'text' IS NOT NULL)
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${MAX_FINDINGS}`,
    )
  ).rows as Row[];
  for (const row of findings) {
    const key = keys.format(num(row, 'number'));
    const cause = row.likely_cause === null ? null : text(row, 'likely_cause');
    const finding = row.first_finding === null ? null : text(row, 'first_finding');
    ticketIds.add(text(row, 'id'));
    facts.push({
      kind: 'ticket',
      label: key,
      href: ticketPageHref(key),
      ticketId: text(row, 'id'),
      text: `${key} "${cut(oneLine(text(row, 'subject')), 120)}"${
        row.intent_key === null ? '' : ` (intent ${text(row, 'intent_key')})`
      } ${t(locale, 'ผลสืบสวนของ AI', 'AI investigation')}: ${
        cause === null
          ? t(locale, 'ยังไม่ระบุสาเหตุ', 'no likely cause')
          : `${t(locale, 'สาเหตุที่น่าจะเป็น', 'likely cause')} ${cut(oneLine(cause), 220)}`
      }${finding === null ? '' : `; ${t(locale, 'พบ', 'finding')}: ${cut(oneLine(finding), 220)}`}.`,
    });
  }

  return { facts: [...figureFacts(view, locale), ...facts], ticketIds: [...ticketIds] };
}
