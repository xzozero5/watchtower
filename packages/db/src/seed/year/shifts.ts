import { AUDIT_ACTIONS } from '@watchtower/shared';

import { DAY, HOUR, MINUTE, type Rng } from './prng.js';
import type { RosterSlot } from './roster.js';
import type { SimTicket } from './tickets.js';
import type { Row } from './types.js';
import type { World, WorldStaff } from './world.js';

/**
 * Shift sessions, handoffs with items, shift notes and read receipts, derived from the roster and
 * from what was really open at each handoff.
 */

export interface ShiftsInput {
  readonly rng: Rng;
  readonly world: World;
  readonly slots: readonly RosterSlot[];
  readonly tickets: readonly SimTicket[];
  readonly incidents: readonly {
    id: string;
    title: string;
    startedAt: Date;
    resolvedAt: Date | null;
    severity: string;
  }[];
  readonly deploys: readonly { id: string; at: Date; slug: string; version: string }[];
  readonly alerts: readonly {
    id: string;
    title: string;
    severity: string;
    at: Date;
    resolvedAt: Date | null;
  }[];
  readonly now: Date;
}

export interface ShiftsOutput {
  readonly tables: Map<string, Row[]>;
  readonly notifications: Row[];
}

const NOTE_BODIES = [
  'Customer on the Gold tier is waiting for a call back about the batch import; please check in at the start of your shift.',
  'The nightly report run was slow again. Not an incident yet, but keep an eye on the queue depth.',
  'Reminder: the maintenance window tomorrow starts at 01:00. Do not start long jobs before then.',
  'I changed the rate limit of one customer key temporarily; it reverts on its own at the end of the month.',
  'Two tickets are waiting for the developer on call. Both customers know the timing.',
  'Heads up: the LINE message quota is at 80% for this month. Prefer email for long replies.',
  'Billing asked to hold credit notes until the invoice run on the 5th.',
  'ลูกค้ารายหนึ่งขอให้โทรกลับก่อนเที่ยงพรุ่งนี้ ดูรายละเอียดในตั๋วที่ติดดาวไว้',
  'ช่วงนี้ webhook ของลูกค้าบางรายช้า ถ้าเจอให้ดูคู่มือ endpoint checklist ก่อนส่งต่อ dev',
  'ระบบรายงานช้าตอนสิ้นเดือน แจ้งลูกค้าให้ส่งออกนอกเวลาทำการได้',
];
const MESSAGES_FOR_NEXT = [
  'Quiet shift overall. Two follow-ups are listed below; everything else is closed.',
  'Busy afternoon. The pending items below need a reply first thing.',
  'One incident ran during the shift; the details are in the incident page.',
  'Nothing special. Please check the watch items.',
  'กะนี้เรียบร้อยดี มีงานติดตามตามรายการด้านล่าง',
  'มีลูกค้ารอคำตอบสองรายตามรายการด้านล่าง รบกวนดูก่อนเลย',
];

export function planShifts(input: ShiftsInput): ShiftsOutput {
  const { rng, world, now } = input;
  const tables = new Map<string, Row[]>();
  const rows = (name: string): Row[] => {
    let list = tables.get(name);
    if (!list) {
      list = [];
      tables.set(name, list);
    }
    return list;
  };
  const notifications: Row[] = [];
  const head = world.staff.find((s) => s.role === 'head') as WorldStaff;
  const sorted = [...input.slots].sort((a, b) => a.start.getTime() - b.start.getTime());

  const byAssignee = new Map<string, SimTicket[]>();
  for (const t of input.tickets) {
    if (!t.assignee) continue;
    byAssignee.set(t.assignee.id, [...(byAssignee.get(t.assignee.id) ?? []), t]);
  }
  const endOf = (t: SimTicket): number =>
    (t.closedAt ?? t.resolvedAt ?? (t.status === 'merged' ? t.updatedAt : now)).getTime();

  const openSessionOwners = new Set<string>();
  const audit = (
    at: Date,
    action: string,
    actor: WorldStaff,
    targetType: string,
    targetId: string,
    metadata: Row = {},
  ): void => {
    rows('audit_log').push({
      id: rng.uuid(),
      created_at: at,
      actor_type: 'user',
      actor_id: actor.id,
      action,
      outcome: 'success',
      target_type: targetType,
      target_id: targetId,
      before: null,
      after: null,
      ip: null,
      request_id: null,
      metadata: { seed: 'year', ...metadata },
    });
  };

  for (const slot of sorted) {
    rows('roster_entry').push({
      id: slot.id,
      shift_id: slot.shift.id,
      user_id: slot.person.id,
      work_date: slot.workDate,
      created_by: head.id,
      created_at: new Date(
        Math.max(slot.person.createdAt.getTime(), slot.start.getTime() - 6 * DAY),
      ),
    });
  }

  for (const slot of sorted) {
    if (slot.start.getTime() > now.getTime()) continue;
    const late = rng.chance(0.1) ? rng.int(3, 28) : 0;
    const early = late === 0 ? rng.int(0, 9) : 0;
    const clockedInAt = new Date(slot.start.getTime() + late * MINUTE - early * MINUTE);
    if (clockedInAt.getTime() > now.getTime()) continue;
    const inProgress = slot.end.getTime() > now.getTime();
    if (inProgress && openSessionOwners.has(slot.person.id)) continue;
    // Forgot to clock out now and then: closed by a lead the next morning.
    const forgot = !inProgress && rng.chance(0.015);
    const clockedOutAt = inProgress
      ? null
      : new Date(slot.end.getTime() + (forgot ? rng.int(120, 600) : rng.int(-4, 25)) * MINUTE);
    if (inProgress) openSessionOwners.add(slot.person.id);
    const sessionId = rng.uuid();
    const overrider = forgot ? rng.pick(world.staff.filter((s) => s.role === 'lead')) : null;
    rows('shift_session').push({
      id: sessionId,
      user_id: slot.person.id,
      shift_id: slot.shift.id,
      roster_entry_id: slot.id,
      scheduled_start: slot.start,
      scheduled_end: slot.end,
      clocked_in_at: clockedInAt,
      late_minutes: late,
      device: rng.chance(0.9) ? 'web' : 'mobile',
      location_consent: false,
      clocked_out_at: clockedOutAt,
      override_by: overrider?.id ?? null,
      override_reason: overrider ? 'Forgot to clock out; confirmed with the person.' : null,
      brief_read_at: rng.chance(0.85)
        ? new Date(clockedInAt.getTime() + rng.int(1, 12) * MINUTE)
        : null,
      created_at: clockedInAt,
    });
    audit(clockedInAt, AUDIT_ACTIONS.shiftClockIn, slot.person, 'shift_session', sessionId, {
      late: late > 0,
    });
    if (clockedOutAt)
      audit(
        clockedOutAt,
        overrider ? AUDIT_ACTIONS.shiftClockOutOverride : AUDIT_ACTIONS.shiftClockOut,
        overrider ?? slot.person,
        'shift_session',
        sessionId,
      );
    if (late > 15) {
      notifications.push({
        id: rng.uuid(),
        user_id: head.id,
        kind: 'shift.no_show',
        severity: 'normal',
        dedupe_key: `no-show:${sessionId}`,
        ticket_id: null,
        org_id: null,
        queue_id: null,
        channel: null,
        data: { lateMinutes: late },
        created_at: new Date(slot.start.getTime() + 15 * MINUTE),
        read_at: new Date(slot.start.getTime() + 40 * MINUTE),
      });
    }

    // handoff: desk shifts hand over when they end
    if (clockedOutAt === null || (slot.kind === 'oncall' && slot.person.role === 'dev')) continue;
    const next = sorted.find(
      (s) =>
        s.start.getTime() >= slot.end.getTime() - 2 * HOUR &&
        s.start.getTime() <= slot.end.getTime() + 2 * HOUR &&
        s.person.id !== slot.person.id &&
        s.person.role !== 'dev',
    );
    if (!next && slot.kind !== 'oncall') continue;
    const handoffId = rng.uuid();
    const confirmedAt = new Date(clockedOutAt.getTime() - rng.int(2, 12) * MINUTE);
    const handoffAt = confirmedAt;
    const toUser = next?.person ?? slot.person;
    if (toUser.id === slot.person.id) continue;
    const message = rng.pick(MESSAGES_FOR_NEXT);
    rows('handoff').push({
      id: handoffId,
      session_id: sessionId,
      from_user_id: slot.person.id,
      to_user_id: toUser.id,
      status: 'confirmed',
      notes: '',
      message_for_next: message,
      confirmed_at: confirmedAt,
      created_at: new Date(confirmedAt.getTime() - 20 * MINUTE),
      updated_at: confirmedAt,
    });
    audit(confirmedAt, AUDIT_ACTIONS.handoffConfirm, slot.person, 'handoff', handoffId);

    // pending items: what the person still had open at that moment
    const mine = (byAssignee.get(slot.person.id) ?? []).filter(
      (t) => t.createdAt.getTime() <= handoffAt.getTime() && endOf(t) > handoffAt.getTime() + HOUR,
    );
    const priorityOrder = mine
      .sort(
        (a, b) =>
          a.priority.localeCompare(b.priority) || a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .slice(0, 3);
    let position = 0;
    const ackBase = toUser;
    const addItem = (item: Row & { requiresAck: boolean }): void => {
      const age = now.getTime() - handoffAt.getTime();
      let ack = 'pending';
      let ackAt: Date | null = null;
      if (item.requiresAck && age > 20 * HOUR) {
        ack = rng.weighted([
          ['accepted', 88],
          ['question', 5],
          ['reassigned', 7],
        ]);
        ackAt = new Date(handoffAt.getTime() + rng.int(5, 55) * MINUTE);
      }
      const { requiresAck, ...rest } = item;
      rows('handoff_item').push({
        id: rng.uuid(),
        handoff_id: handoffId,
        position: position++,
        ...rest,
        edited: false,
        requires_ack: requiresAck,
        carried_shifts: 0,
        ack_status: ack,
        ack_by: ackAt ? ackBase.id : null,
        ack_at: ackAt,
        ack_note: ack === 'question' ? 'Which customer contact should I call?' : null,
        created_at: new Date(handoffAt.getTime() - 15 * MINUTE),
        updated_at: ackAt ?? handoffAt,
      });
    };
    for (const t of priorityOrder) {
      addItem({
        kind: 'pending',
        ticket_id: t.id,
        title: t.subject.slice(0, 160),
        next_action:
          t.status === 'waiting_on_customer'
            ? 'Wait for the customer; chase after one business day.'
            : t.status === 'waiting_on_dev'
              ? 'Ask the developer for an update at the start of the shift.'
              : 'Reply to the customer with the latest findings.',
        due_at: t.resolutionDueAt,
        severity: t.priority,
        source: 'prefill',
        requiresAck: t.priority === 'P1' || t.priority === 'P2',
      });
    }
    const activeIncident = input.incidents.find(
      (i) =>
        i.startedAt.getTime() <= handoffAt.getTime() &&
        (i.resolvedAt === null || i.resolvedAt.getTime() > handoffAt.getTime()),
    );
    if (activeIncident) {
      addItem({
        kind: 'incident',
        ticket_id: null,
        title: activeIncident.title.slice(0, 160),
        next_action: 'Follow the incident page; send the next update to affected customers.',
        due_at: null,
        severity: activeIncident.severity,
        source: 'prefill',
        requiresAck: true,
      });
    }
    const recentDeploy = input.deploys.find(
      (d) =>
        d.at.getTime() > handoffAt.getTime() - 3 * HOUR && d.at.getTime() <= handoffAt.getTime(),
    );
    if (recentDeploy && rng.chance(0.5)) {
      addItem({
        kind: 'deploy',
        ticket_id: null,
        title: `Deploy ${recentDeploy.version} of ${recentDeploy.slug}`,
        next_action: 'Watch the error rate for the next hour.',
        due_at: null,
        severity: null,
        source: 'prefill',
        requiresAck: false,
      });
    }
    const openAlert = input.alerts.find(
      (a) =>
        a.at.getTime() <= handoffAt.getTime() &&
        (a.resolvedAt === null || a.resolvedAt.getTime() > handoffAt.getTime()) &&
        a.severity !== 'info',
    );
    if (openAlert && rng.chance(0.6)) {
      addItem({
        kind: 'alert',
        ticket_id: null,
        title: openAlert.title.slice(0, 160),
        next_action: 'Confirm it has cleared; escalate if it fires again.',
        due_at: null,
        severity: openAlert.severity,
        source: 'prefill',
        requiresAck: false,
      });
    }
    if (rng.chance(0.25)) {
      addItem({
        kind: 'watch',
        ticket_id: null,
        title: rng.pick([
          'Customer expects a call back',
          'Month-end export load',
          'Planned maintenance tonight',
          'Quota nearly used up',
        ]),
        next_action: null,
        due_at: null,
        severity: null,
        source: 'manual',
        requiresAck: false,
      });
    }

    // the handoff message as a shift note (the product writes one per confirmed handoff)
    const noteId = rng.uuid();
    rows('shift_note').push({
      id: noteId,
      author_id: slot.person.id,
      audience: 'person',
      to_user_id: toUser.id,
      deliver_at: null,
      body: message,
      handoff_id: handoffId,
      created_at: confirmedAt,
    });
    const readAt = new Date(confirmedAt.getTime() + rng.int(3, 90) * MINUTE);
    if (readAt.getTime() < now.getTime() && rng.chance(0.93)) {
      rows('shift_note_read').push({ note_id: noteId, user_id: toUser.id, read_at: readAt });
    }
  }

  // free-standing notes: next-shift, person and scheduled
  const desk = world.staff.filter((s) => s.role === 'agent' || s.role === 'lead');
  const span = 360;
  for (let i = 0; i < 150; i += 1) {
    const at = new Date(now.getTime() - rng.int(1, span) * DAY - rng.int(0, 10) * HOUR);
    const author = rng.pick(desk.filter((s) => s.createdAt.getTime() < at.getTime()));
    const audience = rng.weighted<'next_shift' | 'person' | 'datetime'>([
      ['next_shift', 6],
      ['person', 3],
      ['datetime', 1],
    ]);
    const recipient =
      audience === 'person'
        ? rng.pick(desk.filter((s) => s.id !== author.id && s.createdAt.getTime() < at.getTime()))
        : null;
    const noteId = rng.uuid();
    rows('shift_note').push({
      id: noteId,
      author_id: author.id,
      audience,
      to_user_id: recipient?.id ?? null,
      deliver_at: audience === 'datetime' ? new Date(at.getTime() + 12 * HOUR) : null,
      body: rng.pick(NOTE_BODIES),
      handoff_id: null,
      created_at: at,
    });
    audit(at, AUDIT_ACTIONS.shiftNoteCreate, author, 'shift_note', noteId, { audience });
    const readers = recipient
      ? [recipient]
      : rng
          .shuffle(desk.filter((s) => s.id !== author.id && s.createdAt.getTime() < at.getTime()))
          .slice(0, rng.int(1, 4));
    for (const reader of readers) {
      const readAt = new Date(at.getTime() + rng.logNormal(5, 0.9) * HOUR);
      if (readAt.getTime() < now.getTime() - 5 * MINUTE && rng.chance(0.9))
        rows('shift_note_read').push({ note_id: noteId, user_id: reader.id, read_at: readAt });
    }
  }
  return { tables, notifications };
}
