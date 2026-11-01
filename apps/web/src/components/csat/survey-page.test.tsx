import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';

import { SurveyPage } from './survey-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

// A made-up value in the shape of a real one. Not a credential.
const SAMPLE = 'c2FtcGxlLXZhbHVlLWZvci10ZXN0cw';

const view = { ticketKey: 'OPS-12', locale: 'en', expiresAt: '2030-01-01T00:00:00.000Z' };

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', `/csat#token=${SAMPLE}&score=4`);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function openSurvey(routes: Record<string, MockHandler> = {}, locale?: 'th') {
  const api = mockApi({
    'GET /v1/csat/survey': () => ({ json: view }),
    'POST /v1/csat/responses': () => ({ status: 201, json: { recorded: true } }),
    ...routes,
  });
  renderApp(<SurveyPage />, locale ? { locale } : {});
  return api;
}

describe('CSAT survey page', () => {
  it('takes the link from the fragment, removes it from the address bar and sends it as a header', async () => {
    const api = openSurvey();
    expect(await screen.findByRole('heading', { name: 'How did we do?' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(SAMPLE);
    const [call] = api.callsTo('/v1/csat/survey', 'GET');
    expect(call?.headers.get('x-csat-token')).toBe(SAMPLE);
    expect(call?.search).toBe('');
    // Public pages never call the staff api.
    expect(api.calls.every((c) => c.path.startsWith('/v1/csat/'))).toBe(true);
    expect(screen.getByText(/Your request OPS-12 was resolved/)).toBeInTheDocument();
  });

  it('preselects the rating from the email and records nothing until the button is pressed', async () => {
    const api = openSurvey();
    const four = await screen.findByRole('radio', { name: '4 out of 5: Happy' });
    expect(four).toBeChecked();
    expect(api.callsTo('/v1/csat/responses')).toHaveLength(0);
  });

  it('sends the score, "was this resolved?" and the comment once, and says thank you', async () => {
    const user = userEvent.setup();
    const api = openSurvey();
    await user.click(await screen.findByRole('radio', { name: '2 out of 5: Unhappy' }));
    await user.click(screen.getByRole('radio', { name: 'No, I still need help' }));
    await user.type(
      screen.getByRole('textbox', { name: /Anything you would like to add/ }),
      '  Still broken ',
    );
    await user.click(screen.getByRole('button', { name: 'Send my answer' }));

    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    const [call] = api.callsTo('/v1/csat/responses', 'POST');
    expect(call?.body).toEqual({ score: 2, resolved: false, comment: 'Still broken' });
    expect(call?.headers.get('x-csat-token')).toBe(SAMPLE);
    // The link is spent: the page forgot it, and it never says anything about reopening.
    expect(sessionStorage.length).toBe(0);
    expect(screen.queryByText(/reopen/i)).not.toBeInTheDocument();
  });

  it('leaves "resolved" and the comment out when the customer gave neither', async () => {
    const user = userEvent.setup();
    const api = openSurvey();
    await screen.findByRole('radio', { name: '4 out of 5: Happy' });
    await user.click(screen.getByRole('button', { name: 'Send my answer' }));
    await screen.findByRole('heading', { name: 'Thank you' });
    expect(api.callsTo('/v1/csat/responses', 'POST')[0]?.body).toEqual({ score: 4 });
  });

  it('asks for a rating when the link had none, and does not call the api', async () => {
    window.history.replaceState(null, '', `/csat#token=${SAMPLE}`);
    const user = userEvent.setup();
    const api = openSurvey();
    await screen.findByRole('heading', { name: 'How did we do?' });
    await user.click(screen.getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please choose a rating from 1 to 5.',
    );
    expect(api.callsTo('/v1/csat/responses')).toHaveLength(0);
  });

  it('shows "this link does not work" for a bad link and for a page opened without one', async () => {
    openSurvey({ 'GET /v1/csat/survey': () => apiError(401, 'invalid_or_expired_link') });
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it('shows "this link does not work" when the page is opened with no link at all', async () => {
    window.history.replaceState(null, '', '/csat');
    const api = openSurvey();
    expect(
      await screen.findByRole('heading', { name: 'This link does not work' }),
    ).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('shows "already answered" when the api says the link was used (409)', async () => {
    openSurvey({ 'GET /v1/csat/survey': () => apiError(409, 'conflict') });
    expect(await screen.findByRole('heading', { name: 'Already answered' })).toBeInTheDocument();
  });

  it('turns to "already answered" when the answer is refused as a second use', async () => {
    const user = userEvent.setup();
    openSurvey({ 'POST /v1/csat/responses': () => apiError(409, 'conflict') });
    await screen.findByRole('radio', { name: '4 out of 5: Happy' });
    await user.click(screen.getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByRole('heading', { name: 'Already answered' })).toBeInTheDocument();
  });

  it('keeps the form and says how long to wait after a 429', async () => {
    const user = userEvent.setup();
    openSurvey({
      'POST /v1/csat/responses': () => apiError(429, 'rate_limited'),
    });
    await screen.findByRole('radio', { name: '4 out of 5: Happy' });
    await user.click(screen.getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send my answer' })).toBeEnabled();
  });

  it('survives a reload: the link is kept for this tab only', async () => {
    const first = openSurvey();
    await screen.findByRole('heading', { name: 'How did we do?' });
    expect(first.callsTo('/v1/csat/survey')).toHaveLength(1);
    expect(window.location.hash).toBe('');
    // A second page load in the same tab has no fragment but reads the tab's storage.
    vi.unstubAllGlobals();
    const second = openSurvey();
    await waitFor(() => {
      expect(second.callsTo('/v1/csat/survey', 'GET')[0]?.headers.get('x-csat-token')).toBe(SAMPLE);
    });
  });

  it('is written in Thai for a Thai visitor', async () => {
    openSurvey({}, 'th');
    expect(
      await screen.findByRole('heading', { name: 'เราให้บริการเป็นอย่างไรบ้าง' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5 จาก 5: พอใจมาก' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ส่งคำตอบ' })).toBeInTheDocument();
  });
});
