import type { CeoView, WeeklyBrief, WeeklyBriefContent } from '@watchtower/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { CeoPage } from './ceo-page';
import { WeeklyBriefEditPage } from './weekly-brief-edit-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/ceo',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ID = '00000000-0000-4000-8000-0000000000b1';

const figures: CeoView = {
  generatedAt: '2026-11-09T03:00:00.000Z',
  window: { from: '2026-11-03T00:00:00.000Z', to: '2026-11-09T03:00:00.000Z', days: 7 },
  previous: { from: '2026-10-27T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z' },
  seedExcluded: false,
  kpis: {
    volume: { status: 'ok', data: { value: 4, previous: 2, samples: 4 } },
    firstResponse: { status: 'not_available', reason: 'no_data' },
    resolution: { status: 'not_available', reason: 'no_data' },
    sla: { status: 'not_available', reason: 'no_data' },
    csat: { status: 'not_available', reason: 'no_data' },
    aiHandled: { status: 'not_available', reason: 'no_data' },
    verifiedResolution: { status: 'not_available', reason: 'needs_grader' },
    automationSavings: { status: 'not_available', reason: 'no_data' },
  },
  formula: {
    assumed: true,
    minutesPerTicket: 10,
    staffCostUsdPerHour: null,
    aiHandledTickets: 0,
    noTouchTickets: 0,
    hours: 0,
    savedUsd: null,
    aiCostUsd: 0,
    netUsd: null,
    aiCostPerResolvedTicketUsd: null,
    previousAiCostPerResolvedTicketUsd: null,
  },
  externalTiles: [],
};

const ticket = { kind: 'ticket', label: 'OPS-12', href: '/?ticket=OPS-12' } as const;
const incident = { kind: 'incident', label: 'INC-3', href: '/incidents?incident=abc' } as const;

const CONTENT: WeeklyBriefContent = {
  summary: [
    { text: 'Ticket volume doubled to 4.', evidence: [ticket], uncited: false },
    { text: 'A note the head wrote.', evidence: [], uncited: true },
  ],
  rootCauses: [
    {
      title: 'Sign-in loop',
      claims: [{ text: 'Nine tickets share the intent.', evidence: [ticket], uncited: false }],
      ask: 'Review the session cookie',
    },
  ],
  decisions: [{ text: 'INC-3 is still open.', evidence: [incident], uncited: false }],
};

function brief(over: Partial<WeeklyBrief> = {}): WeeklyBrief {
  return {
    id: ID,
    slotDate: '2026-11-09',
    periodFrom: '2026-11-03T00:00:00.000Z',
    periodTo: '2026-11-09T03:00:00.000Z',
    status: 'published',
    locale: 'en',
    source: 'ai',
    reasonCode: null,
    figures,
    content: CONTENT,
    aiContent: null,
    mock: false,
    aiRunId: null,
    promptVersion: 1,
    editedAt: '2026-11-09T04:00:00.000Z',
    recipients: [],
    publishedAt: '2026-11-09T05:00:00.000Z',
    createdAt: '2026-11-09T02:00:00.000Z',
    ...over,
  };
}

const ceoView = { json: figures };

function openCeo(
  role: 'head' | 'lead',
  published: WeeklyBrief | null,
  draft: WeeklyBrief | null = null,
) {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/reports/ceo': ceoView,
      'GET /v1/reports/ceo/brief': { json: { brief: published } },
      'GET /v1/reports/ceo/brief/draft': { json: { draft, defaultRecipients: [] } },
    },
  });
  renderConsole(<CeoPage />);
  return api;
}

describe('weekly brief card on the CEO view', () => {
  it('shows the published brief with its evidence, who wrote it, and says an uncited sentence has no evidence', async () => {
    openCeo('lead', brief());
    const heading = await screen.findByRole('heading', { name: 'Weekly brief' });
    const card = heading.closest('section') as HTMLElement;
    expect(await within(card).findByText('Ticket volume doubled to 4.')).toBeVisible();
    // Each sentence has its chips; the chip of a ticket is a link into the app.
    const link = within(card).getAllByRole('link', { name: /OPS-12/ })[0];
    expect(link).toHaveAttribute('href', expect.stringContaining('ticket=OPS-12'));
    expect(within(card).getByText('Sign-in loop', { exact: false })).toBeVisible();
    expect(within(card).getByText('INC-3 is still open.')).toBeVisible();
    expect(within(card).getByText(/Suggested ask/)).toBeVisible();
    expect(within(card).getByText('Review the session cookie')).toBeVisible();
    // A sentence nobody backed with evidence is marked, in words.
    expect(within(card).getByText('A note the head wrote.')).toBeVisible();
    expect(within(card).getByText('No evidence')).toBeVisible();
    expect(within(card).getByText('Drafted by AI')).toBeVisible();
    expect(within(card).getByText('Edited by the head')).toBeVisible();
    expect(within(card).getByText('2026-11-03 to 2026-11-09')).toBeVisible();
  });

  it('says so when no brief has been published, and offers a lead no way to edit', async () => {
    openCeo('lead', null);
    expect(await screen.findByText('No weekly brief has been published yet.')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Review and publish/ })).toBeNull();
  });

  it('tells a head a draft waits and links to the review page', async () => {
    openCeo('head', null, brief({ status: 'draft', publishedAt: null, aiContent: CONTENT }));
    expect(await screen.findByText('A new draft is ready for review.')).toBeVisible();
    const review = screen.getByRole('link', { name: /Review and publish/ });
    expect(review).toHaveAttribute('href', '/dashboard/ceo/brief');
  });

  it('marks a figures-only brief and a demo brief', async () => {
    openCeo('lead', brief({ source: 'data_only', mock: true, editedAt: null }));
    expect(await screen.findByText('Figures only')).toBeVisible();
    expect(screen.getByText('Demo')).toBeVisible();
    expect(screen.queryByText('Drafted by AI')).toBeNull();
  });

  it('says an empty section is empty', async () => {
    openCeo(
      'lead',
      brief({ content: { summary: [], rootCauses: [], decisions: [] }, editedAt: null }),
    );
    expect(await screen.findByText('No recurring cause with evidence this week.')).toBeVisible();
    expect(screen.getByText('No decision needed.')).toBeVisible();
    expect(screen.getByText('No summary was written.')).toBeVisible();
  });

  it('shows a retryable error without taking down the figures', async () => {
    consoleApi({
      role: 'lead',
      overrides: {
        'GET /v1/reports/ceo': ceoView,
        'GET /v1/reports/ceo/brief': () => apiError(500, 'internal'),
      },
    });
    renderConsole(<CeoPage />);
    expect(await screen.findByText('Could not load the weekly brief.')).toBeVisible();
    expect(await screen.findByText('Ticket volume')).toBeVisible();
  });
});

function openEditor(
  draft: WeeklyBrief | null,
  role: 'head' | 'lead' = 'head',
  extra: Parameters<typeof consoleApi>[0] extends infer O
    ? O extends { overrides?: infer R }
      ? R
      : never
    : never = {},
) {
  const api = consoleApi({
    role,
    overrides: {
      'GET /v1/reports/ceo/brief/draft': {
        json: { draft, defaultRecipients: ['board@example.test', 'ceo@example.test'] },
      },
      ...extra,
    },
  });
  renderConsole(<WeeklyBriefEditPage />);
  return api;
}

const DRAFT = () =>
  brief({ status: 'draft', publishedAt: null, editedAt: null, aiContent: CONTENT });

describe('weekly brief edit page', () => {
  it('is for a head only and asks the api for nothing from a lead', async () => {
    const api = openEditor(DRAFT(), 'lead');
    expect(await screen.findByText(/don.t have access/i)).toBeVisible();
    expect(api.callsTo('/v1/reports/ceo/brief/draft')).toHaveLength(0);
  });

  it('says there is no draft when there is none', async () => {
    openEditor(null);
    expect(await screen.findByText(/There is no draft to edit/)).toBeVisible();
  });

  it('lets the head reword a sentence and saves only what changed, keeping its evidence', async () => {
    const api = openEditor(DRAFT(), 'head', {
      'PUT /v1/reports/ceo/brief/:id': (request) => ({
        json: brief({
          status: 'draft',
          publishedAt: null,
          content: (request.body as { content: WeeklyBriefContent }).content,
        }),
      }),
    });
    const sentence = await screen.findByLabelText('Sentence 1');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(sentence, { target: { value: 'Ticket volume doubled, to 4 tickets.' } });
    expect(await screen.findByText('You have changes that are not saved.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ceo/brief/' + ID, 'PUT')).toHaveLength(1);
    });
    const body = api.callsTo('/v1/reports/ceo/brief/' + ID, 'PUT')[0]?.body as {
      content: WeeklyBriefContent;
    };
    expect(body.content.summary[0]).toMatchObject({
      text: 'Ticket volume doubled, to 4 tickets.',
      evidence: [ticket],
      uncited: false,
    });
    expect(await screen.findByText('Saved.')).toBeVisible();
  });

  it('adds a sentence of the head’s own with no evidence, and drops a blank one on save', async () => {
    const api = openEditor(DRAFT(), 'head', {
      'PUT /v1/reports/ceo/brief/:id': (request) => ({
        json: brief({
          status: 'draft',
          publishedAt: null,
          content: (request.body as { content: WeeklyBriefContent }).content,
        }),
      }),
    });
    await screen.findByLabelText('Sentence 1');
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Add a sentence of my own' })[0] as HTMLElement,
    );
    fireEvent.change(await screen.findByLabelText('Sentence 3'), {
      target: { value: 'Our own point.' },
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Add a sentence of my own' })[0] as HTMLElement,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove sentence 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/reports/ceo/brief/' + ID, 'PUT')).toHaveLength(1);
    });
    const body = api.callsTo('/v1/reports/ceo/brief/' + ID, 'PUT')[0]?.body as {
      content: WeeklyBriefContent;
    };
    expect(body.content.summary.map((claim) => [claim.text, claim.uncited])).toEqual([
      ['A note the head wrote.', true],
      ['Our own point.', true],
    ]);
  });

  it('restores the text the AI wrote', async () => {
    openEditor(DRAFT());
    const sentence = await screen.findByLabelText('Sentence 1');
    fireEvent.change(sentence, { target: { value: 'Something else.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore the AI text' }));
    expect(screen.getByLabelText('Sentence 1')).toHaveValue('Ticket volume doubled to 4.');
  });

  it('shows a figures-only draft as such and why', async () => {
    openEditor(brief({ ...DRAFT(), source: 'data_only', reasonCode: 'provider_offline' }));
    expect(await screen.findByText(/did not write this draft \(provider_offline\)/)).toBeVisible();
  });

  it('starts the recipients from the server setting, refuses a bad address, and publishes to the list', async () => {
    const api = openEditor(DRAFT(), 'head', {
      'POST /v1/reports/ceo/brief/:id/publish': {
        status: 201,
        json: {
          brief: brief({ recipients: ['board@example.test', 'ceo@example.test'] }),
          queued: 2,
        },
      },
    });
    const field = await screen.findByLabelText('Email to');
    expect(field).toHaveValue('board@example.test\nceo@example.test');

    fireEvent.change(field, { target: { value: 'board@example.test\nnot-an-address' } });
    expect(await screen.findByText('Not an email address: not-an-address')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();

    fireEvent.change(field, { target: { value: 'board@example.test, ceo@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    expect(await screen.findByText('Publish this brief?')).toBeVisible();
    expect(screen.getByText(/emailed to 2 people/)).toBeVisible();
    expect(api.callsTo('/v1/reports/ceo/brief/' + ID + '/publish', 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Published. 2 emails are queued.')).toBeVisible();
    const call = api.callsTo('/v1/reports/ceo/brief/' + ID + '/publish', 'POST')[0];
    expect(call?.body).toEqual({ recipients: ['board@example.test', 'ceo@example.test'] });
  });

  it('saves unsaved edits before it publishes', async () => {
    const order: string[] = [];
    openEditor(DRAFT(), 'head', {
      'PUT /v1/reports/ceo/brief/:id': (request) => {
        order.push('save');
        return {
          json: brief({
            status: 'draft',
            publishedAt: null,
            content: (request.body as { content: WeeklyBriefContent }).content,
          }),
        };
      },
      'POST /v1/reports/ceo/brief/:id/publish': () => {
        order.push('publish');
        return { status: 201, json: { brief: brief(), queued: 2 } };
      },
    });
    fireEvent.change(await screen.findByLabelText('Sentence 1'), {
      target: { value: 'Reworded.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await screen.findByText('Published. 2 emails are queued.');
    expect(order).toEqual(['save', 'publish']);
  });

  it('publishes with no email when the list is empty, and says so first', async () => {
    openEditor(DRAFT(), 'head', {
      'POST /v1/reports/ceo/brief/:id/publish': {
        status: 201,
        json: { brief: brief(), queued: 0 },
      },
    });
    fireEvent.change(await screen.findByLabelText('Email to'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    expect(await screen.findByText(/No email is sent, because the list is empty/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Published. No email was queued.')).toBeVisible();
  });

  it('keeps the dialog open and shows the api sentence when the brief was already published', async () => {
    openEditor(DRAFT(), 'head', {
      'POST /v1/reports/ceo/brief/:id/publish': () =>
        apiError(409, 'conflict', 'This brief is already published'),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/already published/i)).toBeVisible();
    expect(screen.getByText('Publish this brief?')).toBeVisible();
  });
});
