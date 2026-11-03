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
    // Attachments are optional too (T-140).
    expect(screen.getByLabelText(/^Attachments/, { selector: 'input' })).toBeInTheDocument();
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

describe('portal submit form attachments (R-9.1)', () => {
  const picker = () => screen.getByLabelText(/^Attachments/, { selector: 'input' });
  const png = (name = 'shot.png') => new File(['png-bytes'], name, { type: 'image/png' });

  it('has an optional file input that accepts the allowed types and several files', () => {
    openForm();
    const input = picker();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('multiple');
    expect(input.getAttribute('accept')).toBe('.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.log');
    expect(
      screen.getByText('Screenshots, PDF, text, CSV or log files. Up to 5 files, 10 MB each.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add files' })).toBeEnabled();
  });

  it('lists the chosen files, each with a remove button, and removes one', async () => {
    const user = userEvent.setup();
    openForm();
    await user.upload(picker(), [png('a.png'), png('b.png')]);
    const list = screen.getByRole('list', { name: 'Files to send' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Add more files' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).queryByText('a.png')).not.toBeInTheDocument();
    expect(screen.getByText('Removed a.png')).toHaveAttribute('role', 'status');
  });

  it('says in words why a file was not added, and keeps the good ones', async () => {
    // The browser's file dialog filters by `accept`, but a dropped or pasted file is not filtered.
    const user = userEvent.setup({ applyAccept: false });
    openForm();
    await user.upload(picker(), [
      png('ok.png'),
      new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
    ]);
    expect(screen.getByText('Some files were not added')).toBeInTheDocument();
    expect(
      screen.getByText(
        'logo.svg is not an accepted type. Use PNG, JPG, GIF, WebP, PDF, TXT, CSV or LOG.',
      ),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Files to send' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('refuses a file over 10 MB before anything is sent', async () => {
    const user = userEvent.setup();
    const api = openForm();
    const big = new File(['x'], 'huge.log');
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    await user.upload(picker(), [big]);
    expect(screen.getByText('huge.log is larger than 10 MB.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Files to send' })).not.toBeInTheDocument();
    expect(api.callsTo('/v1/portal/tickets', 'POST')).toHaveLength(0);
  });

  it('sends the form and the files as multipart', async () => {
    const user = userEvent.setup();
    const api = openForm();
    await fillValid(user);
    await user.upload(picker(), [
      png('screen.png'),
      new File(['line'], 'app.log', { type: 'text/plain' }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/portal/submitted');
    });
    const [post] = api.callsTo('/v1/portal/tickets', 'POST');
    const sent = post?.body as { payload: Record<string, unknown>; files: { name: string }[] };
    expect(sent.files.map((file) => file.name)).toEqual(['screen.png', 'app.log']);
    expect(sent.payload).toMatchObject({ name: 'Dana Demo', category: 'api_error' });
    expect(sent.payload).not.toHaveProperty('attachments');
    // The browser sets the multipart content type itself, with the boundary.
    expect(post?.headers.get('content-type')).toBeNull();
  });

  it('sends plain JSON when no file was chosen', async () => {
    const user = userEvent.setup();
    const api = openForm();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalled();
    });
    const [post] = api.callsTo('/v1/portal/tickets', 'POST');
    expect(post?.headers.get('content-type')).toBe('application/json');
  });

  it('keeps the files and the form when the api refuses a file, and reuses the proof', async () => {
    const user = userEvent.setup();
    const api = openForm({ 'POST /v1/portal/tickets': apiError(400, 'attachment_rejected') });
    await fillValid(user);
    await user.upload(picker(), [png()]);
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(
      await screen.findByText(
        'We could not accept one of your files. Remove it or choose another, then send again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveValue('Dana Demo');
    expect(screen.getByRole('list', { name: 'Files to send' })).toBeInTheDocument();
    // The proof was not used up by a refused file, so no new challenge is asked for.
    expect(api.callsTo('/v1/portal/challenge', 'GET')).toHaveLength(1);
  });

  it('is available in Thai', () => {
    openForm({}, 'th');
    expect(screen.getByLabelText(/^ไฟล์แนบ/, { selector: 'input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'เพิ่มไฟล์' })).toBeInTheDocument();
  });
});
