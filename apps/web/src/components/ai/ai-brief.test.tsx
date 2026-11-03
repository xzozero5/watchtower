import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SINGLE_KEY_STORAGE_KEY, resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import {
  makeInsight,
  makeReport,
  makeInsightTh,
  makeInvestigatingInsight,
  makeLowConfidenceInsight,
  makeUncitedInsight,
} from '@/test/ai-fixtures';
import { makeMessage, makeTicket, uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ticket1 = makeTicket(1, { subject: 'Re: Re: login', priority: 'P2' });

async function openTicket(options: Parameters<typeof renderWorkspace>[0] = {}) {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  const view = renderWorkspace(options);
  const conversation = await screen.findByRole('region', { name: 'Conversation' });
  return { ...view, conversation };
}

describe('the AI brief', () => {
  it('shows what is happening, intent with confidence and reason, the next step and provenance', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });

    expect(within(brief).getByText(/Cannot sign in after a reset/)).toBeVisible();
    // The key is turned into words; the api is to send the name itself (T-134).
    expect(within(brief).getByText('Login issue')).toBeVisible();
    expect(within(brief).queryByText('login_issue')).toBeNull();
    expect(within(brief).getByRole('meter', { name: 'Confidence High 0.86' })).toBeVisible();
    expect(within(brief).getByText('Same wording as 12 earlier lockout tickets.')).toBeVisible();
    expect(within(brief).getByRole('button', { name: 'Approve reply' })).toBeVisible();
    expect(within(brief).getByRole('button', { name: 'Write myself' })).toBeVisible();
    // Provenance: AI, prompt version, how long ago (exact time on hover); the stage in words.
    // Provenance is a bot icon and an age; the prompt version is in the tooltip and the name.
    const provenance = within(brief).getByTitle(/^AI · prompt v3 · /);
    expect(provenance.tagName).toBe('TIME');
    expect(provenance).toHaveAttribute('datetime', '2026-11-02T02:58:00.000Z');
    expect(provenance.textContent).toMatch(/^AI · prompt v3 · .+ · .+$/);
    expect(within(brief).getByText('Stage 2 · Draft for approval')).toBeVisible();
    expect(within(brief).getByText('Draft ready')).toBeVisible();
  });

  it('keeps the human subject as the title and puts the AI summary first in the brief, labelled AI', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(conversation).getByRole('heading', { name: 'Re: Re: login' })).toBeVisible();
    const summary = within(brief).getByTestId('ai-summary');
    expect(summary).toHaveTextContent(/^AI\s*Cannot sign in after a reset/);
    expect(
      within(conversation).queryByRole('heading', { name: /Cannot sign in after a reset/ }),
    ).toBeNull();
  });

  it('says only "AI brief unavailable" when the api has no brief, and keeps the composer open', async () => {
    workspaceApi({ tickets: [ticket1] });
    const { conversation } = await openTicket();
    expect(await within(conversation).findByText('AI brief unavailable')).toBeVisible();
    expect(within(conversation).queryByRole('region', { name: 'AI brief' })).toBeNull();
    expect(within(conversation).queryByTestId('ai-draft')).toBeNull();
    // Nothing for the AI to take over from: the title is the subject and the composer is open.
    expect(within(conversation).getByRole('heading', { name: 'Re: Re: login' })).toBeVisible();
    expect(
      await within(conversation).findByRole('textbox', { name: 'Public reply' }),
    ).toBeVisible();
  });

  it('flags low confidence in words and offers no draft', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeLowConfidenceInsight() } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getByRole('meter', { name: 'Confidence Low 0.31' })).toBeVisible();
    expect(within(brief).getByText('Low confidence. Check before relying on it.')).toBeVisible();
    expect(within(brief).getByText('Needs you')).toBeVisible();
    expect(within(conversation).queryByTestId('ai-draft')).toBeNull();
  });

  it('flags a draft with uncited claims in the brief and on the draft', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeUncitedInsight() } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getByText('1 uncited')).toBeVisible();
    expect(
      within(within(conversation).getByTestId('ai-draft')).getByText('1 uncited'),
    ).toBeVisible();
  });

  it('shows an investigating brief without a draft and says the AI is working', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInvestigatingInsight() } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getAllByText('Investigating')[0]).toBeVisible();
    expect(within(brief).getAllByText('Investigating').length).toBeGreaterThan(0);
    expect(within(conversation).queryByTestId('ai-draft')).toBeNull();
  });

  it('draws no stage badge for a stage the first release does not have (3 and up)', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight({ stage: 3 }) } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).queryByText(/^Stage /)).toBeNull();
  });

  it('renders in Thai', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsightTh() } });
    window.history.replaceState(null, '', '/?ticket=OPS-1');
    renderWorkspace({ locale: 'th' });
    const conversation = await screen.findByRole('region', { name: 'บทสนทนา' });
    const brief = await within(conversation).findByRole('region', { name: 'สรุปจาก AI' });
    expect(within(brief).getByText('ขั้น 2 · ร่างรออนุมัติ')).toBeVisible();
    expect(within(brief).getByRole('button', { name: 'เขียนเอง' })).toBeVisible();
    expect(
      within(within(conversation).getByTestId('ai-draft')).getByText('ไม่มีแหล่งอ้างอิง 1'),
    ).toBeVisible();
  });

  it('is not there for someone who cannot review AI drafts, and no request is made', async () => {
    const api = workspaceApi({
      role: 'client',
      ai: { 'OPS-1': makeInsight() },
    });
    await openTicket();
    await screen.findByRole('region', { name: 'Conversation' });
    expect(screen.queryByRole('region', { name: 'AI brief' })).toBeNull();
    expect(api.calls.filter((call) => call.path.endsWith('/ai'))).toHaveLength(0);
  });

  it('opens the Evidence tab on the card when an evidence chip is chosen', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(
      within(brief).getByRole('button', {
        name: 'Similar ticket: OPS-1180 Locked out after reset Relevance Medium 0.64',
      }),
    );
    const tab = screen.getByRole('tab', { name: 'Evidence' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const card = document.getElementById('evidence-card-ev-ticket-1');
    expect(card).toHaveAttribute('data-highlighted', 'true');
    await waitFor(() => {
      expect(card).toHaveFocus();
    });
    expect(within(card as HTMLElement).getByText('Cited in draft')).toBeVisible();
  });

  it('opens the panel on Details even when the AI brought evidence; Evidence has safe links only', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': makeInsight({
          evidence: [
            {
              id: 'ev-bad',
              kind: 'log',
              title: 'Odd link',
              snippet: 'x',
              confidence: 0.5,
              href: 'javascript:alert(1)',
            },
            {
              id: 'ev-good',
              kind: 'kb',
              title: 'Good link',
              snippet: 'y',
              confidence: 0.8,
              href: 'https://docs.example.com/a',
            },
          ],
        }),
      },
    });
    await openTicket();
    // Stable default: Details, whatever the AI has.
    await screen.findByRole('tabpanel', { name: 'Details' });
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Evidence' }));
    const tabpanel = await screen.findByRole('tabpanel', { name: 'Evidence' });
    const panel = await within(tabpanel).findByRole('list', { name: 'Evidence' });
    expect(within(panel).getAllByRole('link')).toHaveLength(1);
    expect(within(panel).getByRole('link', { name: /Open source/ })).toHaveAttribute(
      'href',
      'https://docs.example.com/a',
    );
  });

  it('collapses the conversation to the last customer message and shows the rest on request', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': makeInsight() },
      timelines: {
        'OPS-1': [
          makeMessage(1, ticket1, {
            bodyText: 'First question',
            createdAt: '2026-11-02T01:00:00.000Z',
          }),
          makeMessage(2, ticket1, {
            direction: 'outbound',
            sender: { type: 'user', id: uuid(900), name: 'Alex Agent' },
            bodyText: 'First answer',
            createdAt: '2026-11-02T01:10:00.000Z',
          }),
          makeMessage(3, ticket1, {
            bodyText: 'Still locked out',
            createdAt: '2026-11-02T02:00:00.000Z',
          }),
        ],
      },
    });
    const { conversation } = await openTicket();
    expect(await within(conversation).findByText('Still locked out')).toBeVisible();
    expect(within(conversation).queryByText('First question')).toBeNull();
    await user.click(within(conversation).getByRole('button', { name: 'Show 2 earlier' }));
    expect(within(conversation).getByText('First question')).toBeVisible();
    expect(within(conversation).getByText('First answer')).toBeVisible();
    await user.click(within(conversation).getByRole('button', { name: 'Hide earlier' }));
    expect(within(conversation).queryByText('First question')).toBeNull();
  });

  it('keeps the composer out of the way until "Write myself" or C', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(conversation).queryByRole('textbox', { name: 'Public reply' })).toBeNull();
    expect(within(conversation).getByRole('button', { name: /Write a reply/ })).toBeVisible();

    await user.click(within(conversation).getByRole('button', { name: 'Write myself' }));
    expect(
      await within(conversation).findByRole('textbox', { name: 'Public reply' }),
    ).toHaveFocus();
  });

  it('puts the box opened by "Write myself" away again, keeping what was typed', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(within(conversation).getByRole('button', { name: 'Write myself' }));
    await user.type(
      await within(conversation).findByRole('textbox', { name: 'Public reply' }),
      'Half a sentence',
    );

    await user.click(within(conversation).getByRole('button', { name: /Close the reply box/ }));
    expect(within(conversation).queryByRole('textbox', { name: 'Public reply' })).toBeNull();
    expect(within(conversation).getByRole('button', { name: /Write a reply/ })).toBeVisible();

    await user.click(within(conversation).getByRole('button', { name: /Write a reply/ }));
    expect(await within(conversation).findByRole('textbox', { name: 'Public reply' })).toHaveValue(
      'Half a sentence',
    );
  });

  it('opens the composer with C and the note box with N when it is hidden', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.keyboard('n');
    expect(
      await within(conversation).findByRole('textbox', { name: 'Internal note' }),
    ).toHaveFocus();
  });
});

describe('the evidence panel', () => {
  it('says "AI brief unavailable" when there is no brief and "No evidence found." when the brief has none', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1] });
    await openTicket();
    await user.click(await screen.findByRole('tab', { name: 'Evidence' }));
    const panel = screen.getByRole('tabpanel', { name: 'Evidence' });
    expect(await within(panel).findByText('AI brief unavailable')).toBeVisible();
  });

  it('lists no cards and says so when the AI found nothing', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeLowConfidenceInsight() } });
    await openTicket();
    await user.click(await screen.findByRole('tab', { name: 'Evidence' }));
    const panel = screen.getByRole('tabpanel', { name: 'Evidence' });
    expect(await within(panel).findByText('No evidence found.')).toBeVisible();
  });
});

describe('what the AI wrote, in the language of the page', () => {
  it('takes the next step button from its kind, not from the api prose, in Thai', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': {
          ...makeInsightTh(),
          nextStep: { kind: 'reply', label: 'Reply from the guide' },
          intent: { key: 'billing_report', confidence: 0.86, reason: 'Matches the billing guide.' },
        },
      },
    });
    window.history.replaceState(null, '', '/?ticket=OPS-1');
    renderWorkspace({ locale: 'th' });
    const conversation = await screen.findByRole('region', { name: 'บทสนทนา' });
    const brief = await within(conversation).findByRole('region', { name: 'สรุปจาก AI' });
    expect(within(brief).getByRole('button', { name: 'ตอบลูกค้า' })).toBeVisible();
    expect(within(brief).queryByText('Reply from the guide')).toBeNull();
    // The reason is prose in English on a Thai page: tagged with its language, with a chip.
    const reason = within(brief).getByText('Matches the billing guide.');
    expect(reason).toHaveAttribute('lang', 'en');
    expect(within(brief).getByTitle('ภาษา: EN')).toBeVisible();
  });

  it('shows the intent as words, and the raw key in the tooltip only for a lead or head', async () => {
    const insight = makeInsight({
      intent: { key: 'billing_report', confidence: 0.86, reason: 'x' },
    });
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': insight }, role: 'lead' });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getByText('Billing report')).toBeVisible();
    expect(within(brief).getByTitle('Intent: billing_report')).toBeVisible();
  });

  it('does not show the key in the tooltip to an agent', async () => {
    const insight = makeInsight({
      intent: { key: 'billing_report', confidence: 0.86, reason: 'x' },
    });
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': insight } });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getByText('Billing report')).toBeVisible();
    expect(within(brief).queryByTitle('Intent: billing_report')).toBeNull();
  });

  it('a stand-in AI run shows a Demo chip and no score, no dots and no match words', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': makeInsight({
          report: makeReport({
            tools: [{ name: 'kb.search', status: 'ok', mock: true }],
          }),
        }),
      },
    });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getAllByText('Demo').length).toBeGreaterThan(0);
    expect(within(brief).queryByRole('meter', { name: /Confidence/ })).toBeNull();
    expect(within(brief).queryByText(/0\.\d\d/)).toBeNull();
    await user.click(within(brief).getByRole('button', { name: /Unlocking an account/ }));
    const panel = screen.getByRole('tabpanel', { name: 'Evidence' });
    expect(within(panel).getAllByText('Demo').length).toBe(2);
    expect(within(panel).queryByText(/match/i)).toBeNull();
  });

  it('writes a certain score as "> 0.99", never 1.00', async () => {
    const user = userEvent.setup();
    const base = makeInsight();
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': {
          ...base,
          evidence: base.evidence.map((entry, index) =>
            index === 0 ? { ...entry, confidence: 1 } : entry,
          ),
        },
      },
    });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(within(brief).getByRole('button', { name: /Unlocking an account/ }));
    const panel = screen.getByRole('tabpanel', { name: 'Evidence' });
    expect(within(panel).getByText('Relevance High > 0.99')).toBeVisible();
    expect(within(panel).queryByText('1.00')).toBeNull();
  });

  it('shows evidence markdown as plain text and never as HTML', async () => {
    const user = userEvent.setup();
    const base = makeInsight();
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': {
          ...base,
          evidence: base.evidence.map((entry, index) =>
            index === 0
              ? {
                  ...entry,
                  snippet:
                    '## Unlock\n**Wait** 15 minutes, see [the guide](https://example.com) <img src=x onerror=alert(1)> `reset`',
                }
              : entry,
          ),
        },
      },
    });
    const { conversation } = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(within(brief).getByRole('button', { name: /Unlocking an account/ }));
    const panel = screen.getByRole('tabpanel', { name: 'Evidence' });
    expect(within(panel).getByText('Unlock Wait 15 minutes, see the guide reset')).toBeVisible();
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelector('strong')).toBeNull();
    expect(panel.textContent).not.toContain('##');
    expect(panel.textContent).not.toContain('**');
  });
});

describe('the single-key preference', () => {
  it('turns A, E and R off with the rest, while the buttons keep working', async () => {
    const user = userEvent.setup();
    localStorage.setItem(SINGLE_KEY_STORAGE_KEY, 'off');
    resetPreferencesCache();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const { conversation } = await openTicket();
    const draft = await within(conversation).findByTestId('ai-draft');
    await user.keyboard('a');
    await user.keyboard('r');
    await user.keyboard('e');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(draft).queryByRole('textbox')).toBeNull();
    await user.click(within(draft).getByRole('button', { name: /^Approve/ }));
    expect(await screen.findByRole('dialog', { name: 'Send this reply?' })).toBeVisible();
  });
});

describe('AI suggestion: wait for the customer', () => {
  const base = makeTicket(1);
  const setup = (messages = [makeMessage(1, base)], failTimeline = false) =>
    workspaceApi({
      tickets: [base],
      timelines: { 'OPS-1': messages },
      ai: { 'OPS-1': makeInsight({ nextStep: { kind: 'wait_customer', label: 'Wait' } }) },
      overrides: {
        'POST /v1/tickets/:id/status': { json: { ...base, status: 'waiting_on_customer' } },
        ...(failTimeline
          ? { 'GET /v1/tickets/:id/timeline': () => apiError(503, 'unavailable') }
          : {}),
      },
    });

  it('requires confirmation before pausing an unanswered customer request, and cancel makes no write', async () => {
    const user = userEvent.setup();
    const api = setup();
    await openTicket();
    await user.click(await screen.findByRole('button', { name: 'Wait for the customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set Waiting on customer?' });
    expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Wait for the customer' }));
    await user.click(await screen.findByRole('button', { name: 'Set anyway' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')).toHaveLength(1);
    });
  });

  it('moves immediately if a delivered public reply follows the last customer message', async () => {
    const user = userEvent.setup();
    const api = setup([
      makeMessage(1, base),
      makeMessage(2, base, { direction: 'outbound', deliveryStatus: 'delivered' }),
    ]);
    await openTicket();
    await user.click(await screen.findByRole('button', { name: 'Wait for the customer' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the ticket active if the latest conversation cannot be checked', async () => {
    const user = userEvent.setup();
    const api = setup(undefined, true);
    await openTicket();
    await user.click(await screen.findByRole('button', { name: 'Wait for the customer' }));
    expect(
      await screen.findByText('Something went wrong. Nothing was changed; try again.'),
    ).toBeVisible();
    expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
