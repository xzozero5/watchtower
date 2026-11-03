import { describe, expect, it } from 'vitest';

import { isShortcut, stepIndex } from '@/lib/keyboard';
import { makeClientTicket, makeTicket } from '@/test/fixtures';

import {
  activeFilterCount,
  BUILT_IN_VIEWS,
  DEFAULT_FILTERS,
  filtersEqual,
  filtersFromSearch,
  filtersFromView,
  filtersToParams,
  filtersToView,
  matchBuiltInView,
  queueHref,
  SYSTEM_VIEW_OF,
} from './filters';
import { isOverdue, severityOf, toRowModel } from './model';
import { readSelectedTicket, withSelectedTicket } from './selection';
import { allowedNextStatuses, draftStore, findPlaceholders, renderTemplate } from './templates';

const NOW = Date.parse('2026-11-02T03:00:00.000Z');

describe('queue filters', () => {
  it('maps the default view to "all open, most urgent first" and leaves empty parts out', () => {
    expect(filtersToParams(DEFAULT_FILTERS)).toEqual({
      status: ['new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev'],
      sort: 'sla_due_asc',
      limit: 50,
    });
  });

  it('maps every filter to the api query', () => {
    expect(
      filtersToParams({
        status: ['open'],
        priority: ['P1', 'P2'],
        assignee: 'me',
        q: '  login  ',
        overdue: true,
        slaState: ['at_risk', 'breached'],
        sort: 'due_asc',
      }),
    ).toEqual({
      status: ['open'],
      priority: ['P1', 'P2'],
      assignee: 'me',
      q: 'login',
      overdue: true,
      slaState: ['at_risk', 'breached'],
      sort: 'due_asc',
      limit: 50,
    });
  });

  it('compares filters without regard to the order of lists or stray spaces', () => {
    expect(
      filtersEqual(
        { ...DEFAULT_FILTERS, status: ['open', 'new'], q: ' a ' },
        { ...DEFAULT_FILTERS, status: ['new', 'open'], q: 'a' },
      ),
    ).toBe(true);
    expect(filtersEqual(DEFAULT_FILTERS, { ...DEFAULT_FILTERS, overdue: true })).toBe(false);
  });

  it('recognises each built-in view and counts what differs from the default', () => {
    for (const view of BUILT_IN_VIEWS) expect(matchBuiltInView(view.filters)).toBe(view.id);
    expect(matchBuiltInView({ ...DEFAULT_FILTERS, q: 'x' })).toBeNull();
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, q: 'x', overdue: true, priority: ['P1'] })).toBe(
      3,
    );
    expect(activeFilterCount({ ...DEFAULT_FILTERS, slaState: ['at_risk'] })).toBe(1);
  });

  it('has the three server views next to the old ones, each mapped to the view that counts it', () => {
    const ids: string[] = BUILT_IN_VIEWS.map((view) => view.id);
    expect(ids).toEqual(
      expect.arrayContaining(['open', 'mine', 'unassigned', 'slaAtRisk', 'triage', 'waiting']),
    );
    expect(SYSTEM_VIEW_OF).toMatchObject({
      slaAtRisk: 'sla_at_risk',
      triage: 'triage',
      waiting: 'waiting_on_customer',
    });
    const risk = BUILT_IN_VIEWS.find((view) => view.id === 'slaAtRisk');
    expect(filtersToParams(risk?.filters ?? DEFAULT_FILTERS)).toMatchObject({
      slaState: ['at_risk', 'breached'],
      sort: 'sla_due_asc',
    });
  });

  it('reads and writes the SLA state in the address of a link', () => {
    expect(filtersFromSearch('?slaState=at_risk,breached&bogus=1')?.slaState).toEqual([
      'at_risk',
      'breached',
    ]);
    expect(filtersFromSearch('?slaState=nope')?.slaState).toEqual([]);
    expect(queueHref({ slaState: ['at_risk'], sort: 'sla_due_asc' })).toBe(
      '/?slaState=at_risk&sort=sla_due_asc',
    );
  });
});

describe('saved views from the server', () => {
  it('turns a saved view into queue filters and back without losing anything', () => {
    const filters = {
      ...DEFAULT_FILTERS,
      status: ['open' as const],
      priority: ['P1' as const],
      assignee: 'unassigned' as const,
      q: 'invoice',
      slaState: ['breached' as const],
      overdue: true,
      sort: 'sla_due_asc' as const,
    };
    const saved = filtersToView(filters);
    expect(saved).toEqual({
      sort: 'sla_due_asc',
      filters: {
        status: ['open'],
        priority: ['P1'],
        assignee: 'unassigned',
        q: 'invoice',
        overdue: true,
        slaState: ['breached'],
      },
    });
    expect(filtersFromView(saved)).toEqual(filters);
  });

  it('keeps "me" as it is for whoever opens the view, and a person as an id', () => {
    const mine = filtersFromView({ filters: { assignee: 'me' }, sort: 'created_desc' });
    expect(mine.assignee).toBe('me');
    expect(mine.assigneeId).toBeUndefined();
    const person = '3f0c1f4e-8f86-4c0e-9d52-0a1c7a9a3b11';
    const theirs = filtersFromView({ filters: { assignee: person }, sort: 'created_desc' });
    expect(theirs).toMatchObject({ assignee: 'any', assigneeId: person });
    expect(filtersToView(theirs).filters.assignee).toBe(person);
  });

  it('leaves out what is not set, and a search the server would refuse (under two characters)', () => {
    expect(filtersToView({ ...DEFAULT_FILTERS, status: [], q: 'a' }).filters).toEqual({});
  });
});

describe('ticket rows', () => {
  it('maps a staff ticket and a client ticket to the same row shape', () => {
    const staff = toRowModel(makeTicket(1, { assignee: { id: 'a', name: 'Sam' } }), NOW);
    expect(staff).toMatchObject({
      key: 'OPS-1',
      orgName: 'Example Org',
      requesterName: 'Riley Requester',
      channel: 'portal',
      assigneeName: 'Sam',
      unassigned: false,
    });
    const client = toRowModel(makeClientTicket(2), NOW);
    expect(client).toMatchObject({
      key: 'OPS-2',
      orgName: null,
      requesterName: 'Casey Customer',
      channel: null,
      assigneeName: null,
      unassigned: false,
    });
    expect(toRowModel(makeTicket(3), NOW).unassigned).toBe(true);
  });

  it('flags overdue only for open tickets with a running clock past a due time', () => {
    const past = '2026-11-02T02:00:00.000Z';
    const future = '2026-11-02T09:00:00.000Z';
    expect(isOverdue(makeTicket(1, { firstResponseDueAt: past }), NOW)).toBe(true);
    expect(
      isOverdue(makeTicket(1, { firstResponseDueAt: past, firstRespondedAt: past }), NOW),
    ).toBe(false);
    expect(isOverdue(makeTicket(1, { resolutionDueAt: past }), NOW)).toBe(true);
    expect(isOverdue(makeTicket(1, { resolutionDueAt: future }), NOW)).toBe(false);
    expect(isOverdue(makeTicket(1, { resolutionDueAt: past, status: 'resolved' }), NOW)).toBe(
      false,
    );
    expect(isOverdue(makeTicket(1, { resolutionDueAt: past, slaPausedAt: past }), NOW)).toBe(false);
    expect(isOverdue(makeClientTicket(1), NOW)).toBe(false);
  });

  it('maps P1 to P4 onto the severity levels', () => {
    expect(['P1', 'P2', 'P3', 'P4'].map((p) => severityOf(p as 'P1'))).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });
});

describe('reply templates', () => {
  const values = { 'requester.name': 'Riley', 'ticket.key': 'OPS-5' };

  it('fills known variables and leaves the rest visible and reported', () => {
    const result = renderTemplate(
      'Hi {{requester.name}} re {{ ticket.key }} {{agent.name}} {{nope}}',
      values,
    );
    expect(result.text).toBe('Hi Riley re OPS-5 {{agent.name}} {{nope}}');
    expect(result.unresolved).toEqual(['agent.name', 'nope']);
  });

  it('treats a blank value as missing', () => {
    expect(renderTemplate('{{requester.name}}', { 'requester.name': '  ' }).unresolved).toEqual([
      'requester.name',
    ]);
  });

  it('finds placeholders left in a text', () => {
    expect(findPlaceholders('a {{x.y}} b {{ z }} {{x.y}}')).toEqual(['x.y', 'z']);
    expect(findPlaceholders('plain')).toEqual([]);
  });

  it('keeps unsent drafts per ticket and mode, and forgets empty ones', () => {
    draftStore.set('OPS-1', 'reply', 'hello');
    draftStore.set('OPS-1', 'note', 'secret');
    expect(draftStore.get('OPS-1', 'reply')).toBe('hello');
    expect(draftStore.get('OPS-1', 'note')).toBe('secret');
    expect(draftStore.get('OPS-2', 'reply')).toBe('');
    draftStore.set('OPS-1', 'reply', '');
    expect(draftStore.get('OPS-1', 'reply')).toBe('');
  });
});

describe('allowedNextStatuses', () => {
  it('follows the configured workflow when it is loaded', () => {
    const workflow = { transitions: [{ from: 'open' as const, to: 'resolved' as const }] };
    expect(allowedNextStatuses(workflow, 'open')).toEqual(['resolved']);
    expect(allowedNextStatuses(workflow, 'new')).toEqual([]);
  });

  it('falls back to the default transitions and never offers merged', () => {
    const next = allowedNextStatuses(undefined, 'open');
    expect(next).toContain('resolved');
    expect(next).not.toContain('open');
    expect(next).not.toContain('merged');
    expect(allowedNextStatuses(undefined, 'closed')).toEqual([]);
  });
});

describe('selected ticket in the address', () => {
  it('reads a valid reference and ignores anything else', () => {
    expect(readSelectedTicket('?ticket=OPS-12')).toBe('OPS-12');
    expect(readSelectedTicket('?ticket=a0000000-0000-4000-8000-000000000001')).toBe(
      'a0000000-0000-4000-8000-000000000001',
    );
    expect(readSelectedTicket('?ticket=drop-table')).toBeNull();
    expect(readSelectedTicket('')).toBeNull();
  });

  it('writes the selection and keeps other parameters', () => {
    expect(withSelectedTicket('', 'OPS-3')).toBe('/?ticket=OPS-3');
    expect(withSelectedTicket('?a=1&ticket=OPS-3', null)).toBe('/?a=1');
    expect(withSelectedTicket('?ticket=OPS-3', null)).toBe('/');
  });
});

describe('keyboard helpers', () => {
  it('steps through a list, clamps at the ends and starts at the top when nothing is selected', () => {
    expect(stepIndex(-1, 1, 5)).toBe(0);
    expect(stepIndex(-1, -1, 5)).toBe(0);
    expect(stepIndex(0, 1, 5)).toBe(1);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(2, 1, 0)).toBe(-1);
  });

  const press = (
    key: string,
    extra: Partial<Parameters<typeof isShortcut>[0]> = {},
    shortcut = 'j',
  ) =>
    isShortcut(
      {
        key,
        code: `Key${key.toUpperCase()}`,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: document.body,
        defaultPrevented: false,
        ...extra,
      },
      shortcut,
    );

  it('treats a bare key as a shortcut, but not with a modifier or while typing', () => {
    expect(press('j')).toBe(true);
    expect(press('k')).toBe(false);
    expect(press('j', { ctrlKey: true })).toBe(false);
    expect(press('j', { metaKey: true })).toBe(false);
    expect(press('j', { defaultPrevented: true })).toBe(false);
    for (const tag of ['input', 'textarea', 'select']) {
      expect(press('j', { target: document.createElement(tag) })).toBe(false);
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(press('j', { target: checkbox })).toBe(true);
  });

  it('also matches the physical key, so shortcuts work on a Thai keyboard layout', () => {
    // Thai layout: the key that types "j" on a US keyboard types a Thai letter.
    expect(press('\u0e48', { code: 'KeyJ' })).toBe(true);
    expect(press('\u0e48', { code: 'KeyK' })).toBe(false);
    // "/" and "?" share a physical key and differ by Shift.
    expect(press('\u0e1d', { code: 'Slash' }, '/')).toBe(true);
    expect(press('\u0e1d', { code: 'Slash', shiftKey: true }, '/')).toBe(false);
    expect(press('\u0e1d', { code: 'Slash', shiftKey: true }, '?')).toBe(true);
    expect(press('\u0e43', { code: 'Period' }, '.')).toBe(true);
    // Shift+J is a different key press, not the "j" shortcut.
    expect(press('J', { code: 'KeyJ', shiftKey: true })).toBe(false);
    // A modifier still cancels it, and typing in a field still wins.
    expect(press('\u0e48', { code: 'KeyJ', ctrlKey: true })).toBe(false);
    expect(press('\u0e48', { code: 'KeyJ', target: document.createElement('textarea') })).toBe(
      false,
    );
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute, so set it as a browser would.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(press('j', { target: editable })).toBe(false);
  });

  it('does not fire while a dialog is open', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    expect(press('j')).toBe(false);
    dialog.remove();
    expect(press('j')).toBe(true);
  });
});
