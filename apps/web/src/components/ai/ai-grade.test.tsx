import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TicketGrade } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import { apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { AiGradeCard } from './ai-grade';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const GRADE: TicketGrade = {
  resolutionClass: 'assumed',
  reasons: [
    {
      text: 'The customer never answered after the last reply.',
      evidence: [{ kind: 'ticket', label: 'OPS-7', href: '/?ticket=OPS-7' }],
      uncited: false,
    },
    { text: 'The fix may have worked.', evidence: [], uncited: true },
  ],
  draftVerdict: 'partial',
  draftQuality: 0.62,
  violations: [
    {
      code: 'promise',
      text: 'The reply promised a date.',
      evidence: [{ kind: 'ticket', label: 'OPS-7' }],
      uncited: false,
    },
  ],
  kbGap: true,
  intentKey: 'password_reset',
  csat: { score: 4, resolved: true },
  mock: false,
  gradedAt: '2026-11-02T02:00:00.000Z',
};

function open(grade: TicketGrade | null | 'error', enabled = true) {
  consoleApi({
    role: 'lead',
    overrides: {
      'GET /v1/tickets/:id/ai/grade':
        grade === 'error' ? apiError(500, 'internal', 'boom') : { json: { grade } },
    },
  });
  renderConsole(<AiGradeCard ticketKey="OPS-7" enabled={enabled} />);
}

describe('AiGradeCard', () => {
  it('shows the class as words and an icon, the reasons as claims, the draft, violations and the KB gap', async () => {
    open(GRADE);
    const card = await screen.findByRole('region', { name: 'How this ticket ended' });
    const result = await within(card).findByText('Assumed');
    expect(result).toBeVisible();
    // Reasons are claims: the first links to its evidence, the second says it has none.
    expect(
      within(card).getByText('The customer never answered after the last reply.'),
    ).toBeVisible();
    expect(within(card).getByRole('link', { name: 'OPS-7', hidden: false })).toBeVisible();
    expect(within(card).getAllByText('No evidence').length).toBeGreaterThan(0);
    expect(within(card).getByText(/Partly matches the reply that was sent/)).toBeVisible();
    expect(within(card).getByText(/Draft quality 62%/)).toBeVisible();
    expect(within(card).getByText('Promise')).toBeVisible();
    expect(within(card).getByText('The reply promised a date.')).toBeVisible();
    expect(within(card).getByText('Knowledge gap')).toBeVisible();
    expect(within(card).getByText(/Write one, or fix an article/)).toBeVisible();
    expect(within(card).getByText(/Customer rating 4 of 5/)).toBeVisible();
  });

  it('says there are no violations and no gap when there are none, and marks a demo verdict', async () => {
    open({ ...GRADE, violations: [], kbGap: false, mock: true, resolutionClass: 'verified' });
    const card = await screen.findByRole('region', { name: 'How this ticket ended' });
    expect(await within(card).findByText('Verified')).toBeVisible();
    expect(within(card).getByText('None found')).toBeVisible();
    expect(within(card).getByText('An article covered it')).toBeVisible();
    expect(within(card).getByText('Demo')).toBeVisible();
  });

  it('says nobody graded the ticket yet, instead of drawing a verdict', async () => {
    open(null);
    expect(await screen.findByText(/Nobody has graded this ticket yet/)).toBeVisible();
    expect(screen.queryByText('Verified')).toBeNull();
  });

  it('says the result is unavailable and offers a retry when the api fails', async () => {
    const user = userEvent.setup();
    open('error');
    expect(await screen.findByText('The result is not available right now')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
  });

  it('draws nothing and asks nothing while the ticket is not resolved', () => {
    const api = consoleApi({ role: 'lead' });
    renderConsole(<AiGradeCard ticketKey="OPS-7" enabled={false} />);
    expect(screen.queryByTestId('ai-grade')).toBeNull();
    expect(api.calls.some((call) => call.path.endsWith('/ai/grade'))).toBe(false);
  });
});
