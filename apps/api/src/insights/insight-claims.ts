import { DELTA_FLAT_PERCENT } from '@watchtower/domain';
import {
  INSIGHT_MASKED_REF_KINDS,
  insightStoredClaimsSchema,
  makeClaim,
  numbersSubsetOfFacts,
  renderInsightTemplate,
  type Claim,
  type ClaimEvidence,
  type ClaimEvidenceKind,
  type InsightElementKey,
  type InsightFact,
  type InsightFactView,
  type InsightLocale,
  type InsightRef,
  type InsightRefKind,
  type InsightStoredClaim,
  type InsightTemplateId,
} from '@watchtower/shared';

/**
 * The pure half of the read path (ADR-029 section 9.3): the sentences of mode F made from facts by template in the
 * viewer's language, and a stored narration turned back into claims whose placeholders and links are restored with
 * the viewer's own rights. Nothing here reads a database or a model.
 */

/** A ref as the viewer may see it: a label, a page when there is one, or "no access". */
export interface ResolvedRef {
  readonly allowed: boolean;
  readonly label: string;
  readonly href?: string;
}

export const refKey = (ref: InsightRef): string => `${ref.kind}:${ref.id}`;

export const NO_ACCESS: Readonly<Record<InsightLocale, string>> = {
  th: 'ไม่มีสิทธิ์เข้าถึง',
  en: 'No access',
};

/** The kind of evidence chip a ref of each kind shows as. */
const EVIDENCE_KIND: Readonly<Record<InsightRefKind, ClaimEvidenceKind>> = {
  user: 'person',
  org: 'data',
  contact: 'data',
  intent: 'intent',
  service: 'data',
  queue: 'data',
  incident: 'incident',
  ticket: 'ticket',
  alert: 'alert',
  shift: 'shift',
};

const clipLabel = (text: string): string => (text.length <= 200 ? text : `${text.slice(0, 199)}…`);

/** A chip for a ref: restored (label, page, `ref`) when the viewer may open it, else "No access" and nothing to follow. */
export function evidenceFor(
  ref: InsightRef,
  resolved: ReadonlyMap<string, ResolvedRef>,
  locale: InsightLocale,
): ClaimEvidence {
  const kind = EVIDENCE_KIND[ref.kind];
  const found = resolved.get(refKey(ref));
  if (found?.allowed !== true) return { kind, label: NO_ACCESS[locale] };
  return {
    kind,
    label: clipLabel(found.label),
    ...(found.href === undefined ? {} : { href: found.href }),
    ref: { kind, id: ref.id },
  };
}

/** Evidence of a fact that has no ref: the fact itself, a number from the system. */
function metricEvidence(fact: InsightFact, locale: InsightLocale): ClaimEvidence {
  return { kind: 'metric', label: clipLabel(fact.display[locale]) };
}

const PERSON_PLACEHOLDER = /\{(person_[a-h])\}/g;

/**
 * The facts as the viewer reads them: the sentence in their language, with `{person_a}` replaced by the name of the
 * person the fact's ref points at, or by "No access" when the viewer may not see that person.
 */
export function factViews(
  facts: readonly InsightFact[],
  locale: InsightLocale,
  resolved: ReadonlyMap<string, ResolvedRef>,
): InsightFactView[] {
  return facts.map((fact) => {
    let text = fact.display[locale];
    if (fact.ref?.kind === 'user') {
      const ref = resolved.get(refKey(fact.ref));
      const name = ref?.allowed === true ? ref.label : NO_ACCESS[locale];
      text = text.replace(PERSON_PLACEHOLDER, () => name);
    }
    return { id: fact.id, kind: fact.kind, value: fact.value, text };
  });
}

// --- mode F: sentences by template -----------------------------------------------------------------------------

const DELTA_LABELS: Readonly<Record<string, Readonly<Record<InsightLocale, string>>>> = {
  created_24h_delta: {
    th: 'ticket ใหม่ใน 24 ชั่วโมงล่าสุด',
    en: 'Tickets created in the last 24 hours',
  },
  started_24h_delta: {
    th: 'incident ใหม่ใน 24 ชั่วโมงล่าสุด',
    en: 'Incidents started in the last 24 hours',
  },
};

interface Sentence {
  readonly templateId: InsightTemplateId;
  readonly params: Readonly<Record<string, string | number>>;
  /** Facts the sentence is made from; their refs and values are its evidence. */
  readonly from: readonly string[];
}

const num = (fact: InsightFact | undefined): number =>
  typeof fact?.value === 'number' ? fact.value : 0;

function deltaSentences(
  facts: ReadonlyMap<string, InsightFact>,
  locale: InsightLocale,
): Sentence[] {
  const out: Sentence[] = [];
  for (const [id, labels] of Object.entries(DELTA_LABELS)) {
    const fact = facts.get(id);
    if (fact === undefined || typeof fact.value !== 'number') continue;
    const percent = Math.abs(fact.value);
    const templateId: InsightTemplateId =
      percent < DELTA_FLAT_PERCENT ? 'delta_flat' : fact.value > 0 ? 'delta_up' : 'delta_down';
    out.push({ templateId, params: { label: labels[locale], percent }, from: [id] });
  }
  return out;
}

function driverSentences(
  facts: readonly InsightFact[],
  locale: InsightLocale,
  resolved: ReadonlyMap<string, ResolvedRef>,
): Sentence[] {
  const out: Sentence[] = [];
  for (const fact of facts) {
    if (fact.kind !== 'driver' || !fact.id.endsWith('_1') || fact.ref === undefined) continue;
    const ref = resolved.get(refKey(fact.ref));
    out.push({
      templateId: 'top_driver',
      params: { name: ref?.allowed === true ? ref.label : NO_ACCESS[locale], count: num(fact) },
      from: [fact.id],
    });
  }
  return out;
}

/** The deterministic sentences of an element, in order. Elements without recipes have facts and no sentence. */
function sentencesFor(
  element: InsightElementKey,
  facts: readonly InsightFact[],
  locale: InsightLocale,
  resolved: ReadonlyMap<string, ResolvedRef>,
): Sentence[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const out: Sentence[] = [];
  switch (element) {
    case 'dashboard.ops.sla': {
      const open = byId.get('open');
      if (open !== undefined) {
        out.push({ templateId: 'open_count', params: { count: num(open) }, from: ['open'] });
      }
      const risk = num(byId.get('at_risk')) + num(byId.get('breached'));
      if (risk > 0) {
        out.push({
          templateId: 'sla_at_risk',
          params: { count: risk },
          from: ['at_risk', 'breached'],
        });
      }
      out.push(...driverSentences(facts, locale, resolved));
      break;
    }
    case 'dashboard.ops.volume':
      out.push(...deltaSentences(byId, locale), ...driverSentences(facts, locale, resolved));
      break;
    case 'alerts.noise': {
      const pct = byId.get('noise_pct');
      if (pct !== undefined) {
        out.push({
          templateId: 'noise_share',
          params: { percent: num(pct), days: num(byId.get('window_days')) },
          from: ['noise_pct', 'window_days'],
        });
      }
      out.push(...driverSentences(facts, locale, resolved));
      break;
    }
    case 'incidents.open': {
      const open = byId.get('open');
      if (open !== undefined) {
        out.push({ templateId: 'incidents_open', params: { count: num(open) }, from: ['open'] });
      }
      out.push(...deltaSentences(byId, locale), ...driverSentences(facts, locale, resolved));
      break;
    }
    case 'home.my_work': {
      const open = byId.get('open');
      if (open !== undefined) {
        out.push({ templateId: 'my_work_open', params: { count: num(open) }, from: ['open'] });
        const risk = num(byId.get('at_risk')) + num(byId.get('breached'));
        if (risk > 0) {
          out.push({
            templateId: 'my_work_sla_risk',
            params: { total: num(open), count: risk },
            from: ['open', 'at_risk', 'breached'],
          });
        }
      }
      break;
    }
    // --- Wave 9b Mode F & Mode N elements (T-420) ---
    case 'home.status': {
      const active = num(byId.get('active_intents'));
      const stage3 = num(byId.get('stage_3_intents'));
      const killSwitchVal = byId.get('kill_switch')?.value;
      const killSwitch =
        locale === 'th'
          ? killSwitchVal === 'enabled'
            ? 'เปิดอยู่'
            : 'ปิดอยู่'
          : killSwitchVal === 'enabled'
            ? 'active'
            : 'inactive';
      out.push({
        templateId: 'home_status',
        params: { active, stage3, killSwitch },
        from: ['active_intents', 'stage_3_intents', 'kill_switch'],
      });
      break;
    }
    case 'queue.list': {
      const myOpen = num(byId.get('my_open'));
      const myRisk = num(byId.get('my_at_risk')) + num(byId.get('my_breached'));
      const unassigned = num(byId.get('unassigned_open'));
      out.push({
        templateId: 'queue_summary',
        params: { myOpen, myRisk, unassigned },
        from: ['my_open', 'my_at_risk', 'my_breached', 'unassigned_open'],
      });
      break;
    }
    case 'home.volume':
      out.push(...deltaSentences(byId, locale), ...driverSentences(facts, locale, resolved));
      break;
    case 'dashboard.ops.now': {
      const open = byId.get('open_tickets');
      if (open !== undefined) {
        out.push({
          templateId: 'open_count',
          params: { count: num(open) },
          from: ['open_tickets'],
        });
      }
      const risk = num(byId.get('at_risk_sla')) + num(byId.get('breached_sla'));
      if (risk > 0) {
        out.push({
          templateId: 'sla_at_risk',
          params: { count: risk },
          from: ['at_risk_sla', 'breached_sla'],
        });
      }
      const openIncidents = num(byId.get('open_incidents'));
      if (openIncidents > 0) {
        out.push({
          templateId: 'incidents_open',
          params: { count: openIncidents },
          from: ['open_incidents'],
        });
      }
      break;
    }
    case 'dashboard.ops.reliability': {
      const openInc = num(byId.get('open_incidents'));
      if (openInc > 0) {
        out.push({
          templateId: 'incidents_open',
          params: { count: openInc },
          from: ['open_incidents'],
        });
      }
      out.push(...driverSentences(facts, locale, resolved));
      break;
    }
    case 'dashboard.ops.services': {
      const activeServices = num(byId.get('total_services'));
      const servicesWithAlerts = num(byId.get('services_with_alerts'));
      out.push({
        templateId: 'alerts_services_summary',
        params: { activeServices, servicesWithAlerts },
        from: ['total_services', 'services_with_alerts'],
      });
      out.push(...driverSentences(facts, locale, resolved));
      break;
    }
    case 'dashboard.ops.quality':
      out.push(...driverSentences(facts, locale, resolved));
      break;
    case 'dashboard.ops.ai': {
      const runs = num(byId.get('total_runs'));
      const costVal = byId.get('cost_usd')?.value;
      const cost = typeof costVal === 'number' ? costVal : Number(costVal ?? 0);
      const errors = num(byId.get('error_count')) + num(byId.get('fallback_count'));
      out.push({
        templateId: 'ai_ops_summary',
        params: { runs, cost, errors },
        from: ['total_runs', 'cost_usd', 'error_count', 'fallback_count'],
      });
      break;
    }
    case 'dashboard.ops.grades': {
      const graded = num(byId.get('total_graded'));
      const verifiedPct = num(byId.get('verified_pct'));
      const violations = num(byId.get('violation_count'));
      out.push({
        templateId: 'ai_grades_summary',
        params: { graded, verifiedPct, violations },
        from: ['total_graded', 'verified_pct', 'violation_count'],
      });
      break;
    }
    case 'dashboard.ops.team':
      out.push(...driverSentences(facts, locale, resolved));
      break;
    case 'dashboard.ops.usage':
      out.push(...driverSentences(facts, locale, resolved));
      break;
    case 'reports.ai_cost': {
      const runs = num(byId.get('total_runs'));
      const cost = Number(byId.get('cost_usd')?.value ?? 0).toFixed(2);
      out.push({
        templateId: 'ai_ops_summary',
        params: { runs, cost, errors: 0 },
        from: ['total_runs', 'cost_usd'],
      });
      out.push(...driverSentences(facts, locale, resolved));
      break;
    }
    case 'reports.ceo.figures': {
      const tickets = num(byId.get('total_tickets'));
      const resolvedCount = num(byId.get('resolved_tickets'));
      const incidents = num(byId.get('incidents_count'));
      const week = num(byId.get('week_number'));
      out.push({
        templateId: 'ceo_figures_summary',
        params: { tickets, resolved: resolvedCount, incidents, week },
        from: ['total_tickets', 'resolved_tickets', 'incidents_count', 'week_number'],
      });
      break;
    }
    case 'incident.detail':
      out.push(...driverSentences(facts, locale, resolved));
      break;
    case 'alerts.services': {
      const activeServices = num(byId.get('total_services'));
      const servicesWithAlerts = num(byId.get('services_with_alerts'));
      out.push({
        templateId: 'alerts_services_summary',
        params: { activeServices, servicesWithAlerts },
        from: ['total_services', 'services_with_alerts'],
      });
      out.push(...driverSentences(facts, locale, resolved));
      break;
    }
    case 'statuspage.admin': {
      const total = num(byId.get('total_components'));
      const degraded = num(byId.get('non_operational_components'));
      const activePosts = num(byId.get('active_posts'));
      out.push({
        templateId: 'statuspage_summary',
        params: { total, degraded, activePosts },
        from: ['total_components', 'non_operational_components', 'active_posts'],
      });
      break;
    }
    case 'org.health': {
      const open = byId.get('open_tickets');
      if (open !== undefined) {
        out.push({
          templateId: 'open_count',
          params: { count: num(open) },
          from: ['open_tickets'],
        });
      }
      const risk = num(byId.get('at_risk')) + num(byId.get('breached'));
      if (risk > 0) {
        out.push({
          templateId: 'sla_at_risk',
          params: { count: risk },
          from: ['at_risk', 'breached'],
        });
      }
      break;
    }
    case 'admin.intents': {
      const stage = num(byId.get('autonomy_stage'));
      const tickets28d = num(byId.get('tickets_28d'));
      out.push({
        templateId: 'admin_intents_summary',
        params: { stage, tickets28d },
        from: ['autonomy_stage', 'tickets_28d'],
      });
      break;
    }
    case 'admin.intent.gate': {
      const statusVal = String(byId.get('gate_status')?.value ?? 'none');
      const statusLabels: Record<string, Record<InsightLocale, string>> = {
        green: { th: 'ผ่าน', en: 'green' },
        red: { th: 'ไม่ผ่าน', en: 'red' },
        insufficient_data: { th: 'ข้อมูลยังไม่เพียงพอ', en: 'insufficient data' },
        pass: { th: 'ผ่าน', en: 'pass' },
        fail: { th: 'ไม่ผ่าน', en: 'fail' },
        hold: { th: 'รอดำเนินการ', en: 'hold' },
        none: { th: 'ยังไม่มี', en: 'none' },
      };
      const status = statusLabels[statusVal]?.[locale] ?? statusVal;
      const passCount = num(byId.get('criteria_pass'));
      const failCount = num(byId.get('criteria_fail'));
      out.push({
        templateId: 'admin_gate_summary',
        params: { status, passCount, failCount },
        from: ['gate_status', 'criteria_pass', 'criteria_fail'],
      });
      break;
    }
    case 'admin.ai': {
      const killSwitchVal = byId.get('kill_switch')?.value;
      const killSwitch =
        locale === 'th'
          ? killSwitchVal === 'enabled'
            ? 'เปิดอยู่'
            : 'ปิดอยู่'
          : killSwitchVal === 'enabled'
            ? 'active'
            : 'inactive';
      const tokens = num(byId.get('tokens_today'));
      const cost = Number(byId.get('cost_today_usd')?.value ?? 0).toFixed(2);
      out.push({
        templateId: 'admin_ai_summary',
        params: { killSwitch, tokens, cost },
        from: ['kill_switch', 'tokens_today', 'cost_today_usd'],
      });
      break;
    }
    case 'admin.integrations': {
      const active = num(byId.get('active_accounts'));
      const healthy = num(byId.get('healthy_accounts'));
      const errors = num(byId.get('error_accounts'));
      out.push({
        templateId: 'admin_integrations_summary',
        params: { active, healthy, errors },
        from: ['active_accounts', 'healthy_accounts', 'error_accounts'],
      });
      break;
    }
    case 'admin.outbox': {
      const pending = num(byId.get('pending_jobs'));
      const failed = num(byId.get('failed_jobs'));
      out.push({
        templateId: 'admin_outbox_summary',
        params: { pending, failed },
        from: ['pending_jobs', 'failed_jobs'],
      });
      break;
    }
    case 'admin.queues': {
      const outboxPending = num(byId.get('outbox_pending'));
      const outboundScheduled = num(byId.get('outbound_scheduled'));
      out.push({
        templateId: 'admin_queues_summary',
        params: { outboxPending, outboundScheduled },
        from: ['outbox_pending', 'outbound_scheduled'],
      });
      break;
    }
    default:
      break;
  }
  return out;
}

/** Mode F: the sentences of the element made by template in the viewer's language, each with its evidence. */
export function templateClaims(
  element: InsightElementKey,
  facts: readonly InsightFact[],
  locale: InsightLocale,
  resolved: ReadonlyMap<string, ResolvedRef>,
): Claim[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const claims: Claim[] = [];
  for (const sentence of sentencesFor(element, facts, locale, resolved)) {
    const evidence: ClaimEvidence[] = [];
    const seen = new Set<string>();
    for (const id of sentence.from) {
      const fact = byId.get(id);
      if (fact === undefined) continue;
      const chip =
        fact.ref === undefined
          ? metricEvidence(fact, locale)
          : evidenceFor(fact.ref, resolved, locale);
      const key = `${chip.kind}|${chip.label}|${chip.ref?.id ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        evidence.push(chip);
      }
    }
    claims.push(
      makeClaim(
        renderInsightTemplate(sentence.templateId, sentence.params, locale),
        evidence.slice(0, 8),
      ),
    );
  }
  return claims;
}

// --- mode N: the stored narration -------------------------------------------------------------------------------

/** `[PERSON_1]`, `[EMAIL_2]`: what the redactor wrote in place of a name or an address (N4). */
const STORED_PLACEHOLDER = /\[([A-Z_]+)_(\d{1,9})\]/g;

/**
 * Turns the stored claims of a narration into the claims a viewer reads (section 9.3 "restore"):
 *  - each `[PERSON_n]` becomes the name of the n-th person the claim cites, or "No access" when the viewer may not see
 *    that person or no person is cited for it (a placeholder is never shown raw, and never guessed);
 *  - evidence becomes chips restored with the viewer's rights, "No access" for a ref they cannot open;
 *  - for a `masked` viewer (the `dev` role): a claim whose evidence has a customer ref (`org`, `contact`) is dropped,
 *    and so is one whose numbers are not all in the masked facts (section 9.3 masked `dev`).
 * Returns an empty list for anything that is not a valid stored narration.
 */
export function restoreNarration(
  stored: unknown,
  options: {
    readonly facts: readonly InsightFact[];
    readonly locale: InsightLocale;
    readonly resolved: ReadonlyMap<string, ResolvedRef>;
    readonly masked: boolean;
  },
): Claim[] {
  const parsed = insightStoredClaimsSchema.safeParse(stored);
  if (!parsed.success) return [];
  const out: Claim[] = [];
  for (const claim of parsed.data as InsightStoredClaim[]) {
    // Aggregate provenance must resolve in the viewer's facts and must not disguise an entity ref.
    if (
      claim.evidence.some(
        (item) =>
          item.kind === 'aggregate' &&
          !options.facts.some((fact) => fact.id === item.factId && fact.ref === undefined),
      )
    )
      continue;
    if (options.masked) {
      const names = claim.evidence.some(
        (item) => item.kind !== 'aggregate' && INSIGHT_MASKED_REF_KINDS.includes(item.kind),
      );
      if (names) continue;
      const cited = options.facts.filter((fact) =>
        claim.evidence.some((item) => item.factId === fact.id),
      );
      if (
        !numbersSubsetOfFacts(
          claim.text.replaceAll(STORED_PLACEHOLDER, ' ').replaceAll(PERSON_PLACEHOLDER, ' '),
          cited,
        ).ok
      )
        continue;
    }
    const distinctPeople = [
      ...new Set(claim.evidence.flatMap((item) => (item.kind === 'user' ? [item.id] : []))),
    ];
    const text = claim.text
      .replaceAll(PERSON_PLACEHOLDER, (_match, token: string) => {
        const letter = token.slice('person_'.length);
        const index = letter.charCodeAt(0) - 97;
        const id = distinctPeople[index];
        const ref =
          id === undefined ? undefined : options.resolved.get(refKey({ kind: 'user', id }));
        return ref?.allowed === true ? ref.label : NO_ACCESS[options.locale];
      })
      .replaceAll(STORED_PLACEHOLDER, (_match, label: string, n: string) => {
        if (label !== 'PERSON') return NO_ACCESS[options.locale];
        const id = distinctPeople[Number(n) - 1];
        const ref =
          id === undefined ? undefined : options.resolved.get(refKey({ kind: 'user', id }));
        return ref?.allowed === true ? ref.label : NO_ACCESS[options.locale];
      });
    const evidence = claim.evidence.slice(0, 8).map((item) => {
      if (item.kind === 'aggregate') {
        const fact = options.facts.find((candidate) => candidate.id === item.factId);
        // Checked above: absence cannot become a fabricated citation.
        if (fact === undefined) throw new Error('Aggregate fact disappeared');
        return metricEvidence(fact, options.locale);
      }
      return evidenceFor({ kind: item.kind, id: item.id }, options.resolved, options.locale);
    });
    out.push(makeClaim(text.slice(0, 600), evidence));
  }
  return out;
}

/** Refs a response may need labels for: those of the facts and those of the stored narration. */
export function refsOf(
  facts: readonly InsightFact[],
  stored: readonly InsightStoredClaim[],
): InsightRef[] {
  const seen = new Map<string, InsightRef>();
  for (const fact of facts) if (fact.ref !== undefined) seen.set(refKey(fact.ref), fact.ref);
  for (const claim of stored) {
    for (const item of claim.evidence) {
      if (item.kind === 'aggregate') continue;
      const ref = { kind: item.kind, id: item.id };
      seen.set(refKey(ref), ref);
    }
  }
  return [...seen.values()];
}
