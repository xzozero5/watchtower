import { AUDIT_ACTIONS, TICKET_EVENT_TYPES } from '@watchtower/shared';

import { sha256Hex, DAY, HOUR, MINUTE, type Rng } from './prng.js';
import type { SimTicket, TicketBundle } from './tickets.js';
import type { Row } from './types.js';
import type { World, WorldStaff } from './world.js';

/**
 * AI activity (runs, drafts, per-ticket insights) at autonomy stage 2 (draft for approval, N3),
 * CSAT surveys with a realistic response rate, and in-app notifications.
 */

export interface ExtrasInput {
  readonly rng: Rng;
  readonly world: World;
  readonly bundles: readonly TicketBundle[];
  readonly start: Date;
  readonly now: Date;
  /** Day (from the start) on which the team began to use the AI drafts. */
  readonly aiStartsAfterDays: number;
  readonly alerts: readonly {
    id: string;
    severity: string;
    title: string;
    at: Date;
    service: string;
  }[];
  readonly escalations: readonly { alertId: string; level: number; at: Date }[];
}

export interface ExtrasOutput {
  readonly tables: Map<string, Row[]>;
}

/** Share of drafts that are approved as written, edited, or rejected (the rest of 1). */
const DISPOSITION: Record<string, readonly [number, number, number]> = {
  account_access: [0.62, 0.28, 0.1],
  feature_question: [0.66, 0.26, 0.08],
  billing_report: [0.5, 0.35, 0.15],
  workspace_config: [0.55, 0.32, 0.13],
  webhook_not_received: [0.45, 0.38, 0.17],
  api_error: [0.38, 0.4, 0.22],
  processing_failure: [0.36, 0.4, 0.24],
  upstream_timeout: [0.4, 0.38, 0.22],
  result_dispute: [0.3, 0.42, 0.28],
  incident_inquiry: [0.52, 0.3, 0.18],
  other: [0.4, 0.34, 0.26],
};
const REJECT_REASONS: readonly (readonly [string, number])[] = [
  ['factually_wrong', 22],
  ['missing_info', 20],
  ['tone_style', 16],
  ['not_grounded', 12],
  ['wrong_intent', 9],
  ['no_reply_needed', 8],
  ['wrong_language', 5],
  ['disclosure_risk', 3],
  ['other', 5],
];
const SUMMARY_EN = (t: SimTicket): string =>
  `${t.org.name} reports: ${t.subject}. Channel ${t.channel}, priority ${t.priority}.`;

function mockRun(
  rng: Rng,
  t: SimTicket,
  agent: string,
  at: Date,
  tier: 'light' | 'standard' | 'deep',
  promptVersion: number,
  inTok: number,
  outTok: number,
): Row {
  const error = rng.chance(0.025);
  const costPerM = tier === 'light' ? [0.8, 4] : tier === 'standard' ? [3, 15] : [15, 75];
  return {
    id: rng.uuid(),
    created_at: new Date(at.getTime() + rng.int(2, 9) * 1000),
    started_at: at,
    agent,
    ticket_id: t.id,
    intent: t.intent.key,
    provider: 'mock',
    model: 'mock-model',
    tier,
    prompt_id: agent,
    prompt_version: promptVersion,
    prompt_hash: sha256Hex(`${agent}:v${String(promptVersion)}`),
    tools: agent === 'investigator' ? ['search_kb', 'search_logs', 'query_usage'] : [],
    input_hmac: sha256Hex(`${t.id}:${agent}:${at.toISOString()}`),
    output: error ? null : `[${agent}] ok`,
    confidence: error ? null : Math.round((0.62 + rng.next() * 0.36) * 100) / 100,
    redaction: { total: rng.int(0, 4), byKind: { EMAIL: rng.int(0, 2), PERSON: rng.int(0, 2) } },
    input_tokens: inTok,
    output_tokens: error ? 0 : outTok,
    cost_usd: ((inTok * (costPerM[0] ?? 3) + outTok * (costPerM[1] ?? 15)) / 1_000_000).toFixed(8),
    latency_ms: Math.round(rng.logNormal(tier === 'light' ? 900 : 3200, 0.4)),
    status: error ? 'error' : 'ok',
    error_code: error ? 'ProviderError' : null,
  };
}

export function planExtras(input: ExtrasInput): ExtrasOutput {
  const { rng, world, bundles, now, start } = input;
  const tables = new Map<string, Row[]>();
  const rows = (name: string): Row[] => {
    let list = tables.get(name);
    if (!list) {
      list = [];
      tables.set(name, list);
    }
    return list;
  };
  const aiStart = new Date(start.getTime() + input.aiStartsAfterDays * DAY);
  const heads = world.staff.filter((s) => s.role === 'head' || s.role === 'lead');
  const audit = (
    at: Date,
    actorType: 'user' | 'ai',
    actor: WorldStaff | null,
    action: string,
    targetId: string,
    metadata: Row = {},
  ): void => {
    rows('audit_log').push({
      id: rng.uuid(),
      created_at: at,
      actor_type: actorType,
      actor_id: actor?.id ?? (actorType === 'ai' ? 'ai:drafter' : null),
      action,
      outcome: 'success',
      target_type: 'ticket',
      target_id: targetId,
      before: null,
      after: null,
      ip: null,
      request_id: null,
      metadata: { seed: 'year', ...metadata },
    });
  };

  // ---------- AI ----------
  for (const bundle of bundles) {
    const t = bundle.sim;
    if (t.createdAt.getTime() < aiStart.getTime() || t.status === 'merged') continue;
    if (!rng.chance(0.92)) continue;
    const promptVersion = t.createdAt.getTime() > start.getTime() + 210 * DAY ? 2 : 1;
    const classifyAt = new Date(t.createdAt.getTime() + rng.int(8, 45) * 1000);
    const classifier = mockRun(
      rng,
      t,
      'classifier',
      classifyAt,
      'light',
      promptVersion,
      rng.int(500, 1100),
      rng.int(40, 120),
    );
    rows('ai_run').push(classifier);
    audit(classifyAt, 'ai', null, AUDIT_ACTIONS.aiRequest, t.id, {
      agent: 'classifier',
      promptVersion,
      model: 'mock-model',
    });
    const summarizer = mockRun(
      rng,
      t,
      'summarizer',
      new Date(classifyAt.getTime() + 15_000),
      'light',
      promptVersion,
      rng.int(700, 1800),
      rng.int(90, 220),
    );
    rows('ai_run').push(summarizer);

    const firstReply = t.replies[0];
    const lastReply = t.replies[t.replies.length - 1];
    const stillOpenNoReply = !firstReply;
    let draftId: string | null = null;
    let draftState: 'draft_ready' | 'classified' | 'needs_human' = 'classified';
    let nextKind: string = 'reply';
    if (t.priority === 'P1' && rng.chance(0.5)) draftState = 'needs_human';

    // A draft is made for the reply the person later sends (or is still waiting).
    const draftFor = lastReply ?? firstReply;
    if (draftFor || stillOpenNoReply) {
      const drafterAt = new Date(
        draftFor
          ? Math.min(draftFor.at.getTime() - 3 * MINUTE, t.createdAt.getTime() + 4 * MINUTE)
          : t.createdAt.getTime() + 4 * MINUTE,
      );
      const draftTime = new Date(Math.max(drafterAt.getTime(), t.createdAt.getTime() + 60_000));
      if (draftTime.getTime() <= now.getTime()) {
        const drafter = mockRun(
          rng,
          t,
          'drafter',
          draftTime,
          'standard',
          promptVersion,
          rng.int(1500, 3600),
          rng.int(180, 520),
        );
        rows('ai_run').push(drafter);
        audit(draftTime, 'ai', null, AUDIT_ACTIONS.aiRequest, t.id, {
          agent: 'drafter',
          promptVersion,
          model: 'mock-model',
        });
        if (t.priority === 'P1' || t.priority === 'P2') {
          const inv = mockRun(
            rng,
            t,
            'investigator',
            new Date(draftTime.getTime() - 20_000),
            'deep',
            promptVersion,
            rng.int(4000, 9000),
            rng.int(500, 1100),
          );
          rows('ai_run').push(inv);
        }
        if (drafter.status === 'ok') {
          draftId = rng.uuid();
          const [pa, pe] = DISPOSITION[t.intent.key] ?? [0.45, 0.35, 0.2];
          const roll = rng.next();
          const disposition =
            draftFor === undefined
              ? null
              : roll < pa
                ? 'approved'
                : roll < pa + pe
                  ? 'edited'
                  : 'rejected';
          const language = t.lang;
          const base: Row = {
            id: draftId,
            ticket_id: t.id,
            ai_run_id: drafter.id,
            created_at: draftTime,
            language,
            customer_language: language,
            citations: [],
            uncited_claims: rng.chance(0.2) ? rng.int(1, 2) : 0,
            prompt_id: 'drafter',
            prompt_version: promptVersion,
            disclosure_level: 'verified',
            disclosure_removed: 0,
            needs_review: rng.chance(0.06),
            requested_by: null,
          };
          if (disposition === null || !draftFor) {
            // Still waiting for a person (recent ticket without a reply).
            rows('ai_draft').push({
              ...base,
              body_text:
                t.lang === 'th'
                  ? 'ขอบคุณที่แจ้งปัญหา ทีมได้รับเรื่องแล้วและกำลังตรวจสอบ จะแจ้งความคืบหน้าโดยเร็วที่สุดค่ะ'
                  : 'Thank you for reporting this. We have received your request and are checking it now; we will update you here shortly.',
              status: 'draft',
              approved_by: null,
              approved_at: null,
              disposition: null,
              edit_distance: null,
              reject_reason: null,
              reject_comment: null,
              resolved_by: null,
              resolved_at: null,
              final_message_id: null,
            });
            draftState = 'draft_ready';
            nextKind = 'approve_draft';
          } else {
            const person = draftFor.by;
            const at = draftFor.at;
            if (disposition === 'approved') {
              rows('ai_draft').push({
                ...base,
                body_text: draftFor.text,
                status: 'sent',
                approved_by: person.id,
                approved_at: at,
                disposition,
                edit_distance: 0,
                reject_reason: null,
                reject_comment: null,
                resolved_by: person.id,
                resolved_at: at,
                final_message_id: draftFor.messageId,
              });
              audit(at, 'user', person, AUDIT_ACTIONS.outboundSent, t.id, {
                origin: 'ai_approved',
                draftId,
              });
            } else if (disposition === 'edited') {
              const distance = Math.round((0.08 + rng.next() * 0.5) * 100) / 100;
              rows('ai_draft').push({
                ...base,
                body_text: `${draftFor.text} ${t.lang === 'th' ? 'หากต้องการข้อมูลเพิ่มเติมแจ้งได้เลยค่ะ' : 'Let us know if you need anything else.'}`,
                status: 'sent',
                approved_by: person.id,
                approved_at: at,
                disposition,
                edit_distance: distance,
                reject_reason: null,
                reject_comment: null,
                resolved_by: person.id,
                resolved_at: at,
                final_message_id: draftFor.messageId,
              });
              audit(at, 'user', person, AUDIT_ACTIONS.aiDraftEdited, t.id, {
                draftId,
                editDistance: distance,
              });
            } else {
              const reason = rng.weighted(REJECT_REASONS);
              rows('ai_draft').push({
                ...base,
                body_text:
                  t.lang === 'th'
                    ? 'ขอบคุณที่ติดต่อมา เราจะตรวจสอบและแจ้งกลับค่ะ'
                    : 'Thanks for getting in touch. We will look into it and get back to you.',
                status: 'rejected',
                approved_by: null,
                approved_at: null,
                disposition,
                edit_distance: null,
                reject_reason: reason,
                reject_comment:
                  reason === 'other'
                    ? 'Customer already had a phone call; no written reply needed.'
                    : null,
                resolved_by: person.id,
                resolved_at: new Date(at.getTime() - MINUTE),
                final_message_id: null,
              });
              audit(
                new Date(at.getTime() - MINUTE),
                'user',
                person,
                AUDIT_ACTIONS.aiDraftReject,
                t.id,
                { draftId, reason },
              );
            }
            draftState = 'draft_ready';
            nextKind =
              t.status === 'resolved' || t.status === 'closed'
                ? 'resolve'
                : t.status === 'waiting_on_customer'
                  ? 'wait_customer'
                  : t.status === 'waiting_on_dev'
                    ? 'escalate_dev'
                    : 'reply';
          }
        }
      }
    }
    const confidence = Math.round((0.7 + rng.next() * 0.29) * 100) / 100;
    const wrong = rng.chance(0.05);
    rows('ai_ticket_insight').push({
      ticket_id: t.id,
      state: draftId === null && draftState === 'classified' ? 'classified' : draftState,
      reason_code: draftState === 'needs_human' ? 'high_priority' : null,
      summary: SUMMARY_EN(t),
      intent_key: wrong ? 'other' : t.intent.key,
      intent_confidence: wrong ? Math.round((0.35 + rng.next() * 0.2) * 100) / 100 : confidence,
      intent_reason: wrong
        ? 'Low similarity to known intents.'
        : `Matches the usual wording of ${t.intent.key.replaceAll('_', ' ')} reports.`,
      next_step_kind: nextKind,
      next_step_label:
        nextKind === 'approve_draft'
          ? 'Review and send the draft'
          : nextKind === 'resolve'
            ? 'Already resolved'
            : nextKind === 'wait_customer'
              ? 'Wait for the customer'
              : nextKind === 'escalate_dev'
                ? 'Waiting for the developer'
                : 'Reply to the customer',
      evidence: [],
      draft_id: draftId,
      stage: t.intent.autonomyStage,
      classifier_run_id: classifier.id,
      summarizer_run_id: summarizer.id,
      generated_at: new Date(classifyAt.getTime() + 20_000),
      report: null,
      progress: null,
      requested_by: null,
      investigated_at: null,
      updated_at: t.updatedAt.getTime() > classifyAt.getTime() ? t.updatedAt : classifyAt,
    });
  }

  // ---------- CSAT ----------
  const csat = rows('csat_survey');
  for (const bundle of bundles) {
    const t = bundle.sim;
    if (!t.resolvedAt && t.status !== 'closed') continue;
    if (t.status === 'merged') continue;
    const resolvedAt = t.resolvedAt ?? t.closedAt;
    if (!resolvedAt) continue;
    const sendAfter = new Date(resolvedAt.getTime() + 60 * MINUTE);
    const channel = t.channel === 'line' ? 'line' : 'email';
    const base: Row = {
      id: rng.uuid(),
      ticket_id: t.id,
      contact_id: t.contact.id,
      org_id: t.org.id,
      channel,
      send_after: sendAfter,
      created_at: resolvedAt,
    };
    const skipRoll = rng.next();
    if (t.reopenCount > 0 && skipRoll < 0.6) {
      csat.push({
        ...base,
        status: 'voided',
        reason: 'ticket_reopened',
        sent_at: null,
        reminder_due_at: null,
        reminder_sent_at: null,
        token_expires_at: null,
        answered_at: null,
        score: null,
        resolved: null,
        comment: null,
        reopened: false,
        updated_at: sendAfter,
      });
      continue;
    }
    if (skipRoll > 0.9) {
      csat.push({
        ...base,
        status: 'skipped',
        reason: rng.pick(['recently_surveyed', 'no_contact_address']),
        sent_at: null,
        reminder_due_at: null,
        reminder_sent_at: null,
        token_expires_at: null,
        answered_at: null,
        score: null,
        resolved: null,
        comment: null,
        reopened: false,
        updated_at: sendAfter,
      });
      continue;
    }
    if (sendAfter.getTime() > now.getTime()) {
      csat.push({
        ...base,
        status: 'scheduled',
        reason: null,
        sent_at: null,
        reminder_due_at: null,
        reminder_sent_at: null,
        token_expires_at: null,
        answered_at: null,
        score: null,
        resolved: null,
        comment: null,
        reopened: false,
        updated_at: resolvedAt,
      });
      continue;
    }
    const sentAt = new Date(sendAfter.getTime() + rng.int(1, 8) * MINUTE);
    const expires = new Date(sentAt.getTime() + 14 * DAY);
    const reminderDue = new Date(sentAt.getTime() + 3 * DAY);
    const answers = rng.chance(0.3) && sentAt.getTime() + HOUR < now.getTime();
    if (answers) {
      const answeredAt = new Date(
        Math.min(now.getTime() - MINUTE, sentAt.getTime() + rng.logNormal(9, 1.0) * HOUR),
      );
      const breached = t.firstBreached || t.resolutionBreached;
      const score = rng.weighted<number>(
        breached
          ? [
              [5, 30],
              [4, 24],
              [3, 18],
              [2, 14],
              [1, 14],
            ]
          : [
              [5, 56],
              [4, 26],
              [3, 9],
              [2, 5],
              [1, 4],
            ],
      );
      const comment = rng.chance(0.38)
        ? score >= 4
          ? rng.pick(
              t.lang === 'th'
                ? ['แก้ปัญหาได้เร็ว ขอบคุณมากครับ', 'ทีมตอบไว อธิบายชัดเจน', 'ประทับใจการติดตามผล']
                : [
                    'Fast and clear answer, thank you.',
                    'The engineer explained the cause well.',
                    'Great follow-up, problem solved.',
                  ],
            )
          : rng.pick(
              t.lang === 'th'
                ? ['รอนานไปหน่อย', 'ปัญหากลับมาอีกหลังแก้ไข', 'อยากให้แจ้งความคืบหน้าบ่อยกว่านี้']
                : [
                    'It took longer than we hoped.',
                    'The problem came back after the fix.',
                    'We would like more frequent updates.',
                  ],
            )
        : null;
      csat.push({
        ...base,
        status: 'answered',
        reason: null,
        sent_at: sentAt,
        reminder_due_at: reminderDue,
        reminder_sent_at: null,
        token_expires_at: expires,
        answered_at: answeredAt,
        score,
        resolved: score >= 3,
        comment,
        reopened: false,
        updated_at: answeredAt,
      });
      bundle.ticket.csat_score = score;
      bundle.events.push({
        id: rng.uuid(),
        created_at: answeredAt,
        ticket_id: t.id,
        type: 'ticket.csat_received',
        actor_type: 'system',
        actor_id: null,
        visibility: 'internal',
        payload: { score },
      });
      rows('audit_log').push({
        id: rng.uuid(),
        created_at: answeredAt,
        actor_type: 'anonymous',
        actor_id: null,
        action: AUDIT_ACTIONS.csatResponse,
        outcome: 'success',
        target_type: 'ticket',
        target_id: t.id,
        before: null,
        after: null,
        ip: null,
        request_id: null,
        metadata: { seed: 'year', score },
      });
    } else {
      const expired = expires.getTime() < now.getTime();
      const reminderSent = reminderDue.getTime() < now.getTime() && rng.chance(0.65);
      csat.push({
        ...base,
        status: expired ? 'expired' : 'sent',
        reason: null,
        sent_at: sentAt,
        reminder_due_at: reminderDue,
        reminder_sent_at: reminderSent
          ? new Date(reminderDue.getTime() + rng.int(1, 30) * MINUTE)
          : null,
        token_expires_at: expires,
        answered_at: null,
        score: null,
        resolved: null,
        comment: null,
        reopened: false,
        updated_at: expired ? expires : sentAt,
      });
    }
  }

  // ---------- notifications (last 30 days) ----------
  const notifications = rows('notification');
  const since = new Date(now.getTime() - 30 * DAY);
  const seen = new Set<string>();
  const push = (
    userId: string,
    kind: string,
    severity: string,
    key: string,
    at: Date,
    ticket: SimTicket | null,
    data: Row,
  ): void => {
    const dedupe = `${userId}:${key}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const ageDays = (now.getTime() - at.getTime()) / DAY;
    const read = ageDays > 2 || rng.chance(0.55);
    notifications.push({
      id: rng.uuid(),
      user_id: userId,
      kind,
      severity,
      dedupe_key: key,
      ticket_id: ticket?.id ?? null,
      org_id: ticket?.org.id ?? null,
      queue_id: null,
      channel: ticket?.channel ?? null,
      data,
      created_at: at,
      read_at: read
        ? new Date(Math.min(now.getTime(), at.getTime() + rng.logNormal(20, 1.0) * MINUTE))
        : null,
    });
  };
  for (const bundle of bundles) {
    const t = bundle.sim;
    if (t.createdAt.getTime() < since.getTime()) continue;
    const assignEvent = bundle.events.find((e) => e.type === TICKET_EVENT_TYPES.assigned);
    if (assignEvent && t.assignee) {
      push(
        t.assignee.id,
        'ticket.assigned',
        'normal',
        `ticket.assigned:${t.id}`,
        assignEvent.created_at as Date,
        t,
        { number: t.number, priority: t.priority },
      );
    }
    if (t.priority === 'P1') {
      for (const lead of heads)
        push(
          lead.id,
          'ticket.p1',
          'critical',
          `ticket.p1:${t.id}`,
          new Date(t.createdAt.getTime() + 30_000),
          t,
          { number: t.number },
        );
    }
  }
  for (const alert of input.alerts) {
    if (alert.at.getTime() < since.getTime() || alert.severity !== 'critical') continue;
    for (const lead of heads)
      push(
        lead.id,
        'alert.fired',
        'high',
        `alert.fired:${alert.id}`,
        new Date(alert.at.getTime() + 20_000),
        null,
        { severity: alert.severity },
      );
  }
  for (const esc of input.escalations) {
    if (esc.at.getTime() < since.getTime()) continue;
    for (const lead of heads)
      push(
        lead.id,
        'alert.escalated',
        'high',
        `alert.escalated:${esc.alertId}:${String(esc.level)}`,
        esc.at,
        null,
        { level: esc.level },
      );
  }
  return { tables };
}
