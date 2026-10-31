import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthConfig } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';
import { makeSession } from '@/test/fixtures';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';

import { LoginPage } from './login-page';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  search = '';
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

const LIVE: AuthConfig = {
  google: { mode: 'live', startPath: '/v1/auth/google/start' },
  devLoginEnabled: false,
  magicLinkEnabled: true,
  breakGlassEnabled: true,
};
const MOCK: AuthConfig = {
  google: { mode: 'mock', startPath: null },
  devLoginEnabled: true,
  magicLinkEnabled: true,
  breakGlassEnabled: true,
};

function openLogin(config: AuthConfig, routes: Record<string, MockHandler> = {}, locale?: 'th') {
  const api = mockApi({
    'GET /v1/auth/config': { json: config },
    'GET /v1/auth/session': apiError(401, 'unauthenticated'),
    ...routes,
  });
  renderApp(<LoginPage />, locale ? { locale } : {});
  return api;
}

describe('staff sign-in', () => {
  it('links to the api to start single sign-on, taking the provider name from configuration', async () => {
    openLogin(LIVE);
    const link = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(link).toHaveAttribute('href', 'http://api.test/v1/auth/google/start?returnTo=%2F');
    expect(screen.queryByRole('heading', { name: 'Development sign-in' })).not.toBeInTheDocument();
  });

  it('on an instance without single sign-on, says so instead of offering a dead link', async () => {
    openLogin(MOCK);
    const button = await screen.findByRole('button', { name: 'Continue with Google' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Google sign-in is not set up on this instance.')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it.each([
    ['domain_not_allowed', 'This account is not from an organization allowed here.'],
    ['staff_not_provisioned', 'Your account has not been set up yet. Ask an administrator.'],
    ['state_invalid', 'The sign-in session expired or did not start here. Start again.'],
    ['google_denied', 'The sign-in was cancelled or refused.'],
    ['something_new', 'Sign-in failed. Try again, or ask an administrator.'],
  ])('explains a failed single sign-on (%s)', async (code, message) => {
    search = `error=${code}`;
    openLogin(LIVE);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in did not complete');
    expect(alert).toHaveTextContent(message);
  });

  it('shows no error when there is none in the address', async () => {
    openLogin(LIVE);
    await screen.findByRole('link', { name: 'Continue with Google' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('development sign-in', () => {
  it('signs in with an email and role, then goes to the queue', async () => {
    const user = userEvent.setup();
    const api = openLogin(MOCK, {
      'POST /v1/auth/dev-login': { json: makeSession('lead') },
    });
    const section = (await screen.findByRole('heading', { name: 'Development sign-in' })).closest(
      'section',
    );
    if (!section) throw new Error('dev section not found');
    const form = within(section);

    await user.type(form.getByLabelText('Email address'), 'lead@example.com');
    await user.selectOptions(form.getByLabelText('Role'), 'lead');
    await user.click(form.getByRole('button', { name: 'Sign in for development' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/');
    });
    expect(api.callsTo('/v1/auth/dev-login', 'POST')[0]?.body).toEqual({
      email: 'lead@example.com',
      role: 'lead',
    });
  });
});

describe('customer magic link', () => {
  async function emailField() {
    const section = (await screen.findByRole('heading', { name: 'Customers' })).closest('section');
    if (!section) throw new Error('customer section not found');
    return within(section);
  }

  it('asks for a link and gives the same answer for any address', async () => {
    const user = userEvent.setup();
    const api = openLogin(LIVE, {
      'POST /v1/auth/magic-link/request': { status: 202, json: { status: 'accepted' } },
    });
    const form = await emailField();

    await user.type(form.getByLabelText('Email address'), 'known@example.com');
    await user.click(form.getByRole('button', { name: 'Email me a sign-in link' }));
    const first = await form.findByRole('status');
    expect(first).toHaveTextContent('Check your email');
    expect(first).toHaveTextContent(
      'If that address belongs to a customer account, a sign-in link is on its way.',
    );

    await user.clear(form.getByLabelText('Email address'));
    // Editing the address clears the old confirmation.
    expect(form.queryByText('Check your email')).not.toBeInTheDocument();
    await user.type(form.getByLabelText('Email address'), 'stranger@example.net');
    await user.click(form.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await form.findByRole('status')).toHaveTextContent(first.textContent);

    expect(api.callsTo('/v1/auth/magic-link/request').map((call) => call.body)).toEqual([
      { email: 'known@example.com' },
      { email: 'stranger@example.net' },
    ]);
  });

  it('tells the user to wait when the api says "too many requests"', async () => {
    const user = userEvent.setup();
    openLogin(LIVE, { 'POST /v1/auth/magic-link/request': apiError(429, 'rate_limited') });
    const form = await emailField();
    await user.type(form.getByLabelText('Email address'), 'a@example.com');
    await user.click(form.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await form.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait a few minutes and try again.',
    );
  });

  it('requires an email address', async () => {
    const user = userEvent.setup();
    const api = openLogin(LIVE);
    const form = await emailField();
    await user.click(form.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(api.callsTo('/v1/auth/magic-link/request')).toHaveLength(0);
    expect(form.getByLabelText('Email address')).toBeInvalid();
  });
});

describe('break-glass sign-in', () => {
  async function openForm() {
    const user = userEvent.setup();
    const summary = await screen.findByText('Emergency administrator sign-in');
    await user.click(summary);
    const details = summary.closest('details');
    if (!details) throw new Error('details not found');
    return { user, form: within(details) };
  }

  it('is folded away until asked for, and its fields are labelled', async () => {
    openLogin(LIVE);
    const summary = await screen.findByText('Emergency administrator sign-in');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    const { form } = await openForm();
    expect(form.getByLabelText('Email address')).toHaveAttribute('autocomplete', 'username');
    expect(form.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(form.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('signs in and goes to the queue', async () => {
    const api = openLogin(LIVE, { 'POST /v1/auth/break-glass': { json: makeSession('head') } });
    const { user, form } = await openForm();
    await user.type(form.getByLabelText('Email address'), 'admin@example.com');
    await user.type(form.getByLabelText('Password'), 'correct horse');
    await user.click(form.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/');
    });
    expect(api.callsTo('/v1/auth/break-glass', 'POST')[0]?.body).toEqual({
      email: 'admin@example.com',
      password: 'correct horse',
    });
  });

  it('gives one message for a wrong password, an unknown account and a locked one, and clears the password', async () => {
    const api = openLogin(LIVE, {
      'POST /v1/auth/break-glass': apiError(401, 'invalid_credentials'),
    });
    const { user, form } = await openForm();
    await user.type(form.getByLabelText('Email address'), 'admin@example.com');
    await user.type(form.getByLabelText('Password'), 'wrong');
    await user.click(form.getByRole('button', { name: 'Sign in' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      'Wrong email or password, or the account is temporarily locked.',
    );
    expect(form.getByLabelText('Password')).toHaveValue('');
    expect(replace).not.toHaveBeenCalled();
    // A failed sign-in is not a reason to refresh anything.
    expect(api.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('says to wait when this address has tried too often', async () => {
    openLogin(LIVE, { 'POST /v1/auth/break-glass': apiError(429, 'rate_limited') });
    const { user, form } = await openForm();
    await user.type(form.getByLabelText('Email address'), 'admin@example.com');
    await user.type(form.getByLabelText('Password'), 'x');
    await user.click(form.getByRole('button', { name: 'Sign in' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Too many attempts.');
  });
});

describe('the login page as a whole', () => {
  it('shows only the methods the instance offers', async () => {
    openLogin({ ...LIVE, magicLinkEnabled: false, breakGlassEnabled: false });
    await screen.findByRole('link', { name: 'Continue with Google' });
    expect(screen.queryByRole('heading', { name: 'Customers' })).not.toBeInTheDocument();
    expect(screen.queryByText('Emergency administrator sign-in')).not.toBeInTheDocument();
  });

  it('shows a loading state, then offers a retry if the options cannot be fetched', async () => {
    const user = userEvent.setup();
    let fail = true;
    openLogin(LIVE, {
      'GET /v1/auth/config': () => (fail ? apiError(503, 'unknown') : { json: LIVE }),
    });
    expect(screen.getByText('Loading sign-in options')).toBeInTheDocument();
    expect(await screen.findByText('Sign-in is not available right now')).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toBeVisible();
  });

  it('sends someone who is already signed in to the queue', async () => {
    localStorage.setItem('wt-had-session', '1');
    mockApi({
      'GET /v1/auth/config': { json: LIVE },
      'GET /v1/auth/session': { json: makeSession('agent') },
    });
    renderApp(<LoginPage />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/');
    });
  });

  it('does not try to refresh a session in a browser that never had one', async () => {
    const api = openLogin(LIVE);
    await screen.findByRole('link', { name: 'Continue with Google' });
    expect(api.callsTo('/v1/auth/session')).toHaveLength(1);
    expect(api.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('is available in Thai', async () => {
    openLogin(LIVE, {}, 'th');
    expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ', level: 1 })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'ดำเนินการต่อด้วย Google' })).toBeVisible();
    expect(screen.getByText('เข้าสู่ระบบผู้ดูแลฉุกเฉิน')).toBeVisible();
  });
});
