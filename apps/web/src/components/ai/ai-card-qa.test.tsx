import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeInsight, makeInsightTh } from '@/test/ai-fixtures';
import { makeTicket, uuid } from '@/test/fixtures';
import { workspaceApi } from '@/test/scenarios';

import { evidenceHref } from './evidence-href';
import { WEAK_EVIDENCE_THRESHOLD, splitEvidence } from './evidence-split';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ticket1 = makeTicket(1, { subject: 'Re: Re: login' });

async function openTicket(locale: 'en' | 'th' = 'en') {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  renderWorkspace({ locale });
  return screen.findByRole('region', { name: locale === 'en' ? 'Conversation' : 'บทสนทนา' });
}

const evidence = (id: string, confidence: number, extra = {}) => ({
  id,
  kind: 'kb' as const,
  title: `Article ${id}`,
  snippet: 'text',
  confidence,
  ...extra,
});

describe('a failed AI brief', () => {
  it('says why in plain words and keeps a retry', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': makeInsight({
          state: 'failed',
          reasonCode: 'model_output_invalid',
          draft: undefined,
          nextStep: undefined,
        }),
      },
      overrides: { 'POST /v1/tickets/:id/ai/requests': { status: 202, json: { accepted: true } } },
    });
    const conversation = await openTicket();
    const failed = await within(conversation).findByTestId('ai-failed');
    expect(failed).toHaveTextContent('The AI could not finish. Over to you.');
    expect(failed).toHaveTextContent('The AI gave an answer that could not be used.');
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/ai/requests', 'POST')).toHaveLength(1);
    });
  });

  it('still shows the generic line and the retry when the api gave no reason', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': makeInsight({ state: 'failed', draft: undefined, nextStep: undefined }) },
    });
    const conversation = await openTicket();
    const failed = await within(conversation).findByTestId('ai-failed');
    expect(failed).toHaveTextContent('The AI could not finish. Over to you.');
    expect(within(failed).getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('the state badge and the intent', () => {
  it('says "No intent matched" instead of "Classified" when nothing set an intent', async () => {
    workspaceApi({
      tickets: [{ ...ticket1, intent: null }],
      ai: {
        'OPS-1': makeInsight({
          state: 'classified',
          intent: undefined,
          draft: undefined,
          nextStep: undefined,
        }),
      },
    });
    const conversation = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getByText('No intent matched')).toBeVisible();
    expect(within(brief).queryByText('Classified')).toBeNull();
  });

  it('keeps "Classified" when the ticket has an intent', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: {
        'OPS-1': makeInsight({ state: 'classified', draft: undefined, nextStep: undefined }),
      },
    });
    const conversation = await openTicket();
    const brief = await within(conversation).findByRole('region', { name: 'AI brief' });
    expect(within(brief).getByText('Classified')).toBeVisible();
  });
});

describe('evidence relevance', () => {
  const insight = makeInsight({
    evidence: [
      evidence('strong', 0.82),
      evidence('weak-a', 0.21),
      evidence('weak-b', 0.43),
      evidence('org', 0.9, { kind: 'data', href: '/orgs/00000000-0000-4000-8000-000000000500' }),
    ],
    draft: undefined,
    nextStep: undefined,
  });

  it('shows a word and the number, and folds the weaker matches behind a button', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': insight } });
    const conversation = await openTicket();
    await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(screen.getByRole('tab', { name: 'Evidence' }));
    const panel = await screen.findByRole('tabpanel', { name: 'Evidence' });
    expect(within(panel).getByText('Relevance High 0.82')).toBeVisible();
    expect(within(panel).queryByText('Article weak-a')).toBeNull();
    expect(within(panel).queryByText(/Strong match/)).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Show 2 weaker matches' }));
    expect(within(panel).getByText('Article weak-a')).toBeVisible();
    expect(within(panel).getByText('Relevance Low 0.21')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Hide weaker matches' }));
    expect(within(panel).queryByText('Article weak-a')).toBeNull();
  });

  it('gives no link to the org page that does not exist for someone who cannot open it', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': insight } });
    const conversation = await openTicket();
    await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(screen.getByRole('tab', { name: 'Evidence' }));
    const panel = await screen.findByRole('tabpanel', { name: 'Evidence' });
    expect(within(panel).queryByRole('link')).toBeNull();
  });

  it('opens an in-app source through the router, an outside one in a new tab', async () => {
    const user = userEvent.setup();
    const linked = makeInsight({
      evidence: [
        evidence('inside', 0.9, { href: '/?ticket=OPS-2' }),
        evidence('outside', 0.8, { href: 'https://docs.example.com/a' }),
      ],
      draft: undefined,
      nextStep: undefined,
    });
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': linked } });
    const conversation = await openTicket();
    await within(conversation).findByRole('region', { name: 'AI brief' });
    await user.click(screen.getByRole('tab', { name: 'Evidence' }));
    const panel = await screen.findByRole('tabpanel', { name: 'Evidence' });
    const links = within(panel).getAllByRole('link', { name: /Open/ });
    expect(links[1]).toHaveAttribute('target', '_blank');
    push.mockClear();
    await user.click(links[0] as HTMLElement);
    expect(push).toHaveBeenCalledWith('/?ticket=OPS-2');
  });

  it('splits at the named threshold and never folds a cited or pointed-at card', () => {
    expect(WEAK_EVIDENCE_THRESHOLD).toBe(0.5);
    const list = [evidence('a', 0.5), evidence('b', 0.49), evidence('c', 0.1), evidence('d', 0.2)];
    const base = { citedIds: [], highlightId: null, demo: false };
    expect(splitEvidence(list, base).weak.map((e) => e.id)).toEqual(['b', 'c', 'd']);
    const kept = splitEvidence(list, { ...base, citedIds: ['c'], highlightId: 'd' });
    expect(kept.weak.map((e) => e.id)).toEqual(['b']);
    expect(splitEvidence(list, { ...base, demo: true }).weak).toEqual([]);
  });

  it('turns the org path into the admin page only for someone who may open it', () => {
    const id = uuid(500);
    expect(evidenceHref(`/orgs/${id}`, false)).toBeNull();
    expect(evidenceHref(`/orgs/${id}`, true)).toBe(`/admin/orgs/${id}`);
    expect(evidenceHref('https://docs.example.com/a', false)).toBe('https://docs.example.com/a');
    expect(evidenceHref('/?ticket=OPS-2', false)).toBe('/?ticket=OPS-2');
    expect(evidenceHref(undefined, true)).toBeNull();
  });
});

describe('words on the decisions', () => {
  it('shows a text label on Approve, Edit, Reject and Write myself', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    const conversation = await openTicket();
    const bar = await within(conversation).findByRole('group', { name: 'Draft actions' });
    expect(within(bar).getByRole('button', { name: 'Approve' })).toHaveTextContent('Approve');
    expect(within(bar).getByRole('button', { name: 'Edit' })).toHaveTextContent('Edit');
    expect(within(bar).getByRole('button', { name: 'Reject' })).toHaveTextContent('Reject');
    const brief = within(conversation).getByRole('region', { name: 'AI brief' });
    expect(within(brief).getByRole('button', { name: 'Write myself' })).toHaveTextContent(
      'Write myself',
    );
    expect(within(brief).getByRole('button', { name: 'Investigate again' })).toHaveTextContent(
      'Investigate again',
    );
  });

  it('shows them in Thai too, and the right-pane tabs carry their words', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsightTh() } });
    const conversation = await openTicket('th');
    const bar = await within(conversation).findByRole('group', { name: 'การดำเนินการกับร่าง' });
    for (const button of within(bar).getAllByRole('button')) {
      expect(button.textContent.trim()).not.toBe('');
    }
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.textContent.trim()).not.toBe('');
    }
  });
});

describe('the right pane', () => {
  it('opens on Details whether or not the AI brought evidence', async () => {
    workspaceApi({ tickets: [ticket1], ai: { 'OPS-1': makeInsight() } });
    await openTicket();
    expect(await screen.findByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'false');
  });

  it('opens on Details with no evidence at all', async () => {
    workspaceApi({
      tickets: [ticket1],
      ai: { 'OPS-1': makeInsight({ evidence: [], draft: undefined }) },
    });
    await openTicket();
    expect(await screen.findByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
