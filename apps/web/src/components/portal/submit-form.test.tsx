import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasWork } from '@/lib/portal/pow-core';
import { readSubmittedRaw } from '@/lib/portal/submitted-handoff';
import { renderApp } from '@/test-utils';
import { makeChallenge } from '@/test/portal-fixtures';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';

import { SubmitForm } from './submit-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/portal');
});
afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const SUBMITTED = {
  ticketKey: 'OPS-12',
  maskedEmail: 'a***@example.com',
  status: 'received',
  expectedFirstResponseAt: '2026-11-05T08:00:00.000Z',
};

function openForm(routes: Record<string, MockHandler> = {}, locale?: 'th') {
  const api = mockApi({
    'GET /v1/portal/challenge': () => ({ json: makeChallenge() }),
    'POST /v1/portal/tickets': { status: 201, json: SUBMITTED },
    ...routes,
  });
  renderApp(<SubmitForm />, locale ? { locale } : {});
  return api;
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Your name'), 'Dana Demo');
  await user.type(screen.getByLabelText('Email address'), 'Ada@Example.com');
  await user.selectOptions(screen.getByLabelText('What is it about?'), 'api_error');
  await user.click(screen.getByRole('radio', { name: /Something is broken/ }));
  await user.type(screen.getByLabelText('What happened?'), 'The export fails with a 500.');
}

describe('portal submit form', () => {
  it('asks for a challenge when it opens, shows the check, and stays usable meanwhile', async () => {
    const api = openForm();
    expect(screen.getByRole('heading', { name: 'Contact support' })).toBeInTheDocument();
    await waitFor(() => {
      expect(api.callsTo('/v1/portal/challenge', 'GET')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByText('Verified. You can submit your request.')).toBeInTheDocument();
    });
    // No staff api is called by the public page.
    expect(api.calls.every((call) => call.path.startsWith('/v1/portal/'))).toBe(true);
  });

  it('puts every label above its control and marks optional fields in words', () => {
    openForm();
    for (const label of [
      'Your name',
      'Email address',
      'What is it about?',
      'What happened?',
      /Company or organization/,
      /Short summary/,
      /Affected session or request IDs/,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('(optional)', { selector: 'legend span' })).toBeInTheDocument();
    // Urgency is in plain words, not P1 to P4.
    expect(screen.getByRole('radio', { name: /Everything is down/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Something is broken/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /A question/ })).toBeInTheDocument();
    expect(screen.queryByText(/\bP[1-4]\b/)).not.toBeInTheDocument();
    // No attachments yet, so nothing about them.
    expect(screen.queryByText(/attach/i)).not.toBeInTheDocument();
  });

  it('has a honeypot that people cannot see or reach', () => {
    openForm();
    const field = screen.getByTestId('portal-honeypot');
    expect(field).toHaveAttribute('aria-hidden', 'true');
    const input = within(field).getByRole('textbox', { hidden: true });
    expect(input).toHaveAttribute('name', 'website');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveValue('');
  });

  it('submits with a valid proof of work, an empty honeypot and the page language, then shows the confirmation', async () => {
    const user = userEvent.setup();
    const api = openForm();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/portal/submitted');
    });
    const [post] = api.callsTo('/v1/portal/tickets', 'POST');
    const body = post?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      email: 'ada@example.com',
      name: 'Dana Demo',
      category: 'api_error',
      urgency: 'something_broken',
      description: 'The export fails with a 500.',
      locale: 'en',
      website: '',
    });
    expect(body).not.toHaveProperty('attachments');
    const proof = body.verification as { provider: string; challenge: string; nonce: string };
    expect(proof).toMatchObject({ provider: 'pow-sha256', challenge: makeChallenge().challenge });
    expect(await hasWork(proof.challenge, proof.nonce, 8)).toBe(true);
    // The staff api and cookies are not involved.
    expect(post?.headers.get('x-csrf-token')).toBeNull();

    expect(JSON.parse(readSubmittedRaw() ?? 'null')).toEqual(SUBMITTED);
  });

  it('shows an inline error and a summary, moves focus there, and sends nothing', async () => {
    const user = userEvent.setup();
    const api = openForm();
    await user.type(screen.getByLabelText('Email address'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText('Please check the form')).toBeInTheDocument();
    expect(within(summary).getByRole('link', { name: 'Your name' })).toBeInTheDocument();
    expect(within(summary).getByRole('link', { name: 'Email address' })).toBeInTheDocument();
    expect(summary.parentElement).toHaveFocus();

    const email = screen.getByLabelText('Email address');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    expect(
      describedBy
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' '),
    ).toContain('Enter an email address like name@example.com.');
    expect(api.callsTo('/v1/portal/tickets', 'POST')).toHaveLength(0);

    // A summary link moves focus to the field.
    await user.click(within(summary).getByRole('link', { name: 'Your name' }));
    expect(screen.getByLabelText('Your name')).toHaveFocus();

    // Editing a field clears its error.
    await user.type(screen.getByLabelText('Your name'), 'Ada');
    expect(screen.getByLabelText('Your name')).not.toHaveAttribute('aria-invalid');
  });

  it('passes a filled honeypot through to the api, which refuses it', async () => {
    const user = userEvent.setup();
    const api = openForm({
      'POST /v1/portal/tickets': apiError(400, 'verification_failed'),
    });
    await fillValid(user);
    const trap = within(screen.getByTestId('portal-honeypot')).getByRole('textbox', {
      hidden: true,
    });
    await user.type(trap, 'https://spam.example');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/portal/tickets', 'POST')).toHaveLength(1);
    });
    expect(
      (api.callsTo('/v1/portal/tickets', 'POST')[0]?.body as { website: string }).website,
    ).toBe('https://spam.example');
  });

  it('on a failed verification asks for a new challenge and keeps the text', async () => {
    const user = userEvent.setup();
    const api = openForm({ 'POST /v1/portal/tickets': apiError(400, 'verification_failed') });
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    expect(await screen.findByText(/We couldn't verify your request/)).toBeInTheDocument();
    await waitFor(() => {
      expect(api.callsTo('/v1/portal/challenge', 'GET')).toHaveLength(2);
    });
    expect(screen.getByLabelText('What happened?')).toHaveValue('The export fails with a 500.');
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeEnabled();
  });

  it('on 429 shows a friendly wait from Retry-After, blocks Submit and asks for a new challenge', async () => {
    const user = userEvent.setup();
    const api = openForm({
      'POST /v1/portal/tickets': () => ({
        status: 429,
        json: { statusCode: 429, error: 'Too Many Requests', code: 'rate_limited', message: 'x' },
      }),
    });
    // mockApi cannot set headers, so wrap fetch to add Retry-After to the 429.
    const inner = api.fetchMock.getMockImplementation();
    api.fetchMock.mockImplementation(async (input, init) => {
      const response = await inner?.(input, init);
      if (response?.status !== 429) return response as Response;
      return new Response(response.body, {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '600' },
      });
    });
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    expect(
      await screen.findByText(
        'You have sent several requests recently. Please wait about 10 minutes and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();
    await waitFor(() => {
      expect(api.callsTo('/v1/portal/challenge', 'GET')).toHaveLength(2);
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('says verification could not load, with a button to check again, when the challenge fails', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = openForm({
      'GET /v1/portal/challenge': () => {
        calls += 1;
        return calls === 1 ? { status: 500, json: undefined } : { json: makeChallenge() };
      },
    });
    expect(
      await screen.findByText(
        "Verification couldn't load. Check your connection or try another browser.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Verified. You can submit your request.')).toBeInTheDocument();
    expect(api.callsTo('/v1/portal/challenge')).toHaveLength(2);
  });

  it('shows a network failure without losing the form', async () => {
    const user = userEvent.setup();
    const api = openForm();
    await fillValid(user);
    api.fetchMock.mockImplementation((input) =>
      new URL(input instanceof Request ? input.url : input.toString()).pathname ===
      '/v1/portal/tickets'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(
            new Response(JSON.stringify(makeChallenge()), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
    );
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText(/We couldn't reach the server/)).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveValue('Dana Demo');
  });

  it('is available in Thai', async () => {
    openForm({}, 'th');
    expect(screen.getByRole('heading', { name: 'ติดต่อทีมซัพพอร์ต' })).toBeInTheDocument();
    expect(screen.getByLabelText('ชื่อของคุณ')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ใช้งานไม่ได้เลย/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ส่งคำขอ' })).toBeInTheDocument();
    expect(await screen.findByText('ตรวจสอบแล้ว ส่งคำขอได้เลย')).toBeInTheDocument();
  });
});
