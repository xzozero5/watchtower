import type { IncidentTimelineEntry, IncidentTimelineType } from '@watchtower/shared';

import type { MessageKey, Translate } from '@/i18n';

const LINE_KEYS = {
  created: 'ops.incidents.timeline.created',
  status_changed: 'ops.incidents.timeline.statusChanged',
  severity_changed: 'ops.incidents.timeline.severityChanged',
  commander_changed: 'ops.incidents.timeline.commanderChanged',
  alert_linked: 'ops.incidents.timeline.alertLinked',
  ticket_linked: 'ops.incidents.timeline.ticketLinked',
  ticket_unlinked: 'ops.incidents.timeline.ticketUnlinked',
  service_added: 'ops.incidents.timeline.serviceAdded',
  note: 'ops.incidents.timeline.note',
  comms_drafted: 'ops.incidents.timeline.commsDrafted',
  comms_sent: 'ops.incidents.timeline.commsSent',
  thread_created: 'ops.incidents.timeline.threadCreated',
  deploy_noted: 'ops.incidents.timeline.deployNoted',
} as const satisfies Record<IncidentTimelineType, MessageKey>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * One line of the timeline in words. Only enumerations and counts of the payload are read; the
 * text of a note is shown as it was written (staff wrote it, staff read it) and nothing else free
 * is ever put on screen.
 */
export function timelineLine(entry: IncidentTimelineEntry, t: Translate): string {
  const p = entry.payload;
  const status = (value: unknown) => {
    const word = text(value);
    return word === '' ? '' : t(`ops.incidents.status.${word as 'investigating'}`);
  };
  switch (entry.type) {
    case 'created':
      return t(LINE_KEYS.created, { severity: text(p.severity) });
    case 'status_changed':
      return t(LINE_KEYS.status_changed, { from: status(p.from), to: status(p.to) });
    case 'severity_changed':
      return t(LINE_KEYS.severity_changed, { from: text(p.from), to: text(p.to) });
    case 'alert_linked':
      return t(LINE_KEYS.alert_linked, { count: count(p.alerts) });
    case 'comms_sent':
      return t(LINE_KEYS.comms_sent, {
        sent: count(p.sent),
        failed: count(p.failed),
        recipients: count(p.recipients),
      });
    case 'deploy_noted':
      return t(LINE_KEYS.deploy_noted, { service: text(p.service), env: text(p.env) });
    case 'note':
      return text(p.text);
    default:
      return t(LINE_KEYS[entry.type]);
  }
}

/** Who did it, as a word: a person, the system, the AI. */
export function actorKey(
  actorType: IncidentTimelineEntry['actorType'],
):
  | 'ops.incidents.timeline.actor.user'
  | 'ops.incidents.timeline.actor.system'
  | 'ops.incidents.timeline.actor.ai' {
  switch (actorType) {
    case 'ai':
      return 'ops.incidents.timeline.actor.ai';
    case 'user':
      return 'ops.incidents.timeline.actor.user';
    default:
      return 'ops.incidents.timeline.actor.system';
  }
}
