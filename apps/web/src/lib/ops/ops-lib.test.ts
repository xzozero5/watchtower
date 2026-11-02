import { describe, expect, it } from 'vitest';

import { en } from '@/i18n/messages/en';
import { th } from '@/i18n/messages/th';
import { translate } from '@/i18n';
import { alert, FAR_FUTURE } from '@/test/ops-fixtures';

import {
  ALERT_VIEWS,
  alertQueryFor,
  alertSeverityId,
  describeRule,
  incidentSeverityId,
  isAlertView,
  isSnoozed,
  labelsToLines,
  parseLabelLines,
  parseSubscriptionFragment,
  secondsToMinutes,
  stepIndex,
} from './model';
import { actorKey, timelineLine } from './timeline';

describe('severity mapping (UI spec section 8.1, Q10)', () => {
  it('maps critical, error, warning and info to P1 to P4', () => {
    expect(alertSeverityId('critical')).toBe('p1');
    expect(alertSeverityId('error')).toBe('p2');
    expect(alertSeverityId('warning')).toBe('p3');
    expect(alertSeverityId('info')).toBe('p4');
  });

  it('shows an unknown severity as P3, never as P1', () => {
    expect(alertSeverityId('unknown')).toBe('p3');
  });

  it('maps SEV1 to SEV4 onto the same four levels', () => {
    expect(['SEV1', 'SEV2', 'SEV3', 'SEV4'].map((s) => incidentSeverityId(s as 'SEV1'))).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });
});

describe('isSnoozed', () => {
  const now = Date.parse('2026-11-02T03:00:00.000Z');
  it('is true only while the snooze is in force and the alert is not resolved', () => {
    expect(isSnoozed(alert(1, { snoozedUntil: FAR_FUTURE, snoozeReason: 'x' }), now)).toBe(true);
    expect(isSnoozed(alert(1, { snoozedUntil: '2026-11-02T02:00:00.000Z' }), now)).toBe(false);
    expect(isSnoozed(alert(1, { snoozedUntil: null }), now)).toBe(false);
    expect(isSnoozed(alert(1, { snoozedUntil: FAR_FUTURE, state: 'resolved' }), now)).toBe(false);
  });
});

describe('alert views', () => {
  it('turns each list view into the query the api understands', () => {
    expect(alertQueryFor('open')).toEqual({ state: 'open' });
    expect(alertQueryFor('snoozed')).toEqual({ snoozed: true });
    expect(alertQueryFor('unmapped')).toEqual({ unmapped: true });
    expect(alertQueryFor('groups')).toBeNull();
    expect(alertQueryFor('noise')).toBeNull();
  });

  it('accepts only the known view names from the address', () => {
    expect(ALERT_VIEWS.every((view) => isAlertView(view))).toBe(true);
    expect(isAlertView('nope')).toBe(false);
    expect(isAlertView(null)).toBe(false);
  });
});

describe('stepIndex (J and K)', () => {
  it('starts at the first row, stays inside the list and handles an empty list', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe('service rules and labels', () => {
  it('writes and reads key=value lines', () => {
    expect(parseLabelLines('env=prod\n\n  team = core ')).toEqual({ env: 'prod', team: 'core' });
    expect(parseLabelLines('env')).toBeNull();
    expect(parseLabelLines('=x')).toBeNull();
    expect(parseLabelLines('a=')).toBeNull();
    expect(labelsToLines({ env: 'prod', team: 'core' })).toBe('env=prod\nteam=core');
  });

  it('describes a rule in the provider words', () => {
    expect(
      describeRule({ source: 'gcp_logging', policyName: 'High 5xx', labels: { env: 'prod' } }),
    ).toBe('gcp_logging · High 5xx · env=prod');
  });

  it('shows policy seconds as minutes', () => {
    expect(secondsToMinutes(900)).toBe(15);
  });
});

describe('subscription link fragment', () => {
  it('takes the token from #token= and nothing else', () => {
    expect(parseSubscriptionFragment('#token=abcdefghij.klm')).toBe('abcdefghij.klm');
    expect(parseSubscriptionFragment('token=abcdefghij')).toBe('abcdefghij');
    expect(parseSubscriptionFragment('')).toBeNull();
    expect(parseSubscriptionFragment('#token=short')).toBeNull();
    expect(parseSubscriptionFragment('#other=abcdefghijklmnop')).toBeNull();
    expect(parseSubscriptionFragment('#token=abc def ghijklmnop')).toBeNull();
  });
});

describe('incident timeline lines', () => {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(en, key, values);
  const entry = (type: string, payload: Record<string, unknown>) => ({
    id: 'e',
    type: type as never,
    actorType: 'user' as const,
    actorId: null,
    payload,
    createdAt: '2026-11-02T03:00:00.000Z',
  });

  it('reads enumerations and counts, and a note as it was written', () => {
    expect(
      timelineLine(entry('status_changed', { from: 'investigating', to: 'identified' }), t),
    ).toBe('Status changed from Investigating to Identified.');
    expect(timelineLine(entry('severity_changed', { from: 'SEV2', to: 'SEV1' }), t)).toBe(
      'Severity changed from SEV2 to SEV1.',
    );
    expect(timelineLine(entry('comms_sent', { sent: 6, failed: 1, recipients: 7 }), t)).toBe(
      'Update sent: 6 sent, 1 failed, out of 7.',
    );
    expect(timelineLine(entry('note', { text: 'Rolled back' }), t)).toBe('Rolled back');
    expect(timelineLine(entry('ticket_linked', { ticketId: 'x' }), t)).toBe('A ticket was linked.');
  });

  it('survives a payload without the expected fields', () => {
    expect(timelineLine(entry('created', {}), t)).toBe('Incident opened as .');
    expect(timelineLine(entry('note', {}), t)).toBe('');
  });

  it('names the actor as a word', () => {
    expect(actorKey('ai')).toBe('ops.incidents.timeline.actor.ai');
    expect(actorKey('anonymous')).toBe('ops.incidents.timeline.actor.system');
  });

  it('is available in Thai with the same placeholders', () => {
    expect(
      translate(th, 'ops.incidents.timeline.commsSent', { sent: 6, failed: 1, recipients: 7 }),
    ).toContain('7');
  });
});
