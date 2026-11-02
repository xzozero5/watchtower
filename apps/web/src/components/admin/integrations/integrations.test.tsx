import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleApi } from '@/test/console-api';
import {
  GMAIL_ACCOUNT,
  LINE_ACCOUNT,
  makeGmailStatus,
  makeIntegration,
  makeIntegrationList,
} from '@/test/integrations-fixtures';
import { type MockHandler, apiError } from '@/test/mock-api';
import { renderConsole } from '@/test/render-console';

import { IntegrationsPage } from './integrations-page';

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn(), navigate: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
  usePathname: () => '/admin/integrations',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/lib/navigate', () => ({ navigateTo: nav.navigate }));

beforeEach(() => {
  nav.search = '';
  nav.replace.mockClear();
  nav.navigate.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const READS = {
  'GET /v1/admin/integrations': { json: makeIntegrationList() },
  'GET /v1/admin/channel-accounts': { json: { items: [LINE_ACCOUNT, GMAIL_ACCOUNT] } },
  'GET /v1/admin/integrations/gmail/oauth/status': { json: makeGmailStatus() },
} satisfies Record<string, MockHandler>;

function setup(overrides: Record<string, MockHandler> = {}, role: 'head' | 'lead' = 'head') {
  const api = consoleApi({ role, overrides: { ...READS, ...overrides } });
  renderConsole(<IntegrationsPage />);
  return api;
}

describe('Integrations: credentials', () => {
  it('shows where each value comes from and never a value', async () => {
    const user = userEvent.setup();
    setup();
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    // Environment wins: no way to edit it, and the variable is named.
    expect(
      within(line).getByText(
        'Set by environment variable LINE_CHANNEL_SECRET — change it in your deployment',
      ),
    ).toBeVisible();
    expect(within(line).queryByRole('button', { name: /Replace Channel secret/ })).toBeNull();
    // Saved in the database: date and name, a Replace and a Remove, and no value or mask.
    expect(within(line).getByText(/^Set · updated .+ by Mana K\.$/)).toBeVisible();
    expect(within(line).getByRole('button', { name: /Replace\s+Channel ID/ })).toBeVisible();
    expect(within(line).getByRole('button', { name: /Remove\s+Channel ID/ })).toBeVisible();
    expect(within(line).getByText('Not set')).toBeVisible();
    expect(line.textContent).not.toMatch(/•|\*{3}/);
    // The sentences are chips with a hint behind each: Encrypted, and Demo (the mock test mode).
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Encrypted');
    expect(note).toHaveTextContent('Demo');
    expect(note).not.toHaveTextContent('built-in fake');
    await user.click(within(note).getByRole('button', { name: 'More about Demo' }));
    expect(await screen.findByText(/built-in fake/)).toBeVisible();
  });

  it('marks a card whose values all come from the environment, in words with an icon', async () => {
    setup();
    const ai = await screen.findByRole('region', { name: 'AI provider' });
    expect(within(ai).getByText('Set by environment')).toBeVisible();
    const gmail = screen.getByRole('region', { name: 'Gmail' });
    expect(within(gmail).getByText('Partly configured')).toBeVisible();
    const discord = screen.getByRole('region', { name: 'Discord' });
    expect(within(discord).getByText('Not configured')).toBeVisible();
  });

  it('replaces a value through a password input and sends only what was typed', async () => {
    const user = userEvent.setup();
    const api = setup({
      'PUT /v1/admin/integrations/:integration': {
        json: makeIntegration('line', {
          channelId: 'db',
          channelSecret: 'env',
          channelAccessToken: 'db',
        }),
      },
    });
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    const save = within(line).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.click(within(line).getByRole('button', { name: /Set\s+Channel access token/ }));
    const input = within(line).getByLabelText('New value for Channel access token');
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, '  token-from-the-test  ');
    await user.click(within(line).getByRole('button', { name: 'Show what I typed' }));
    expect(input).toHaveAttribute('type', 'text');
    await user.click(save);

    await waitFor(() => {
      expect(api.callsTo('/v1/admin/integrations/line', 'PUT')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/admin/integrations/line', 'PUT')[0]?.body).toEqual({
      fields: { channelAccessToken: 'token-from-the-test' },
    });
    // The typed value is gone from the page after saving.
    await waitFor(() => {
      expect(screen.queryByLabelText('New value for Channel access token')).toBeNull();
    });
    expect(document.body.textContent).not.toContain('token-from-the-test');
  });

  it('a Replace can be discarded without sending anything', async () => {
    const user = userEvent.setup();
    const api = setup();
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    await user.click(within(line).getByRole('button', { name: /Replace\s+Channel ID/ }));
    await user.type(within(line).getByLabelText('New value for Channel ID'), 'abc');
    await user.click(within(line).getByRole('button', { name: /^Discard/ }));
    expect(within(line).queryByLabelText('New value for Channel ID')).toBeNull();
    expect(within(line).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(api.callsTo('/v1/admin/integrations/line', 'PUT')).toHaveLength(0);
  });

  it('shows the api sentence for an environment-locked field (409)', async () => {
    const user = userEvent.setup();
    setup({
      'PUT /v1/admin/integrations/:integration': apiError(409, 'credential_env_locked', 'locked'),
    });
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    await user.click(within(line).getByRole('button', { name: /Replace\s+Channel ID/ }));
    await user.type(within(line).getByLabelText('New value for Channel ID'), 'abc');
    await user.click(within(line).getByRole('button', { name: 'Save changes' }));
    expect(await within(line).findByRole('alert')).toHaveTextContent(
      'This value is set by an environment variable, so it cannot be changed here.',
    );
    // What was typed is kept so nothing is lost.
    expect(within(line).getByLabelText('New value for Channel ID')).toHaveValue('abc');
  });

  it('removes a saved value only after a confirmation', async () => {
    const user = userEvent.setup();
    const api = setup({
      'DELETE /v1/admin/integrations/:integration/fields/:field': { status: 204 },
    });
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    await user.click(within(line).getByRole('button', { name: /Remove\s+Channel ID/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Channel ID?' });
    expect(within(dialog).getByText(/field name only, never the value/)).toBeVisible();
    expect(api.callsTo('/v1/admin/integrations/line/fields/channelId', 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/admin/integrations/line/fields/channelId', 'DELETE')).toHaveLength(1);
    });
  });
});

describe('Integrations: test connection', () => {
  it('tests the saved values and says the fake was used', async () => {
    const user = userEvent.setup();
    const api = setup({
      'POST /v1/admin/integrations/:integration/test': {
        json: {
          ok: true,
          mode: 'mock',
          identity: 'mock:line',
          message: 'All required fields are set.',
          checkedAt: '2026-11-02T03:00:00.000Z',
        },
      },
    });
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    await user.click(within(line).getByRole('button', { name: 'Test connection' }));
    expect(
      await within(line).findByText('Connected (built-in fake: nothing was contacted)'),
    ).toBeVisible();
    expect(within(line).getByText('Identity: mock:line')).toBeVisible();
    expect(api.callsTo('/v1/admin/integrations/line/test', 'POST')[0]?.body).toEqual({});
  });

  it('tests unsaved typed values without saving them, and shows a failure in words', async () => {
    const user = userEvent.setup();
    const api = setup({
      'POST /v1/admin/integrations/:integration/test': {
        json: {
          ok: false,
          mode: 'mock',
          identity: null,
          message: 'The channel access token is missing.',
          checkedAt: '2026-11-02T03:00:00.000Z',
        },
      },
    });
    const line = await screen.findByRole('region', { name: 'LINE Official Account' });
    await user.click(within(line).getByRole('button', { name: /Set\s+Channel access token/ }));
    await user.type(within(line).getByLabelText('New value for Channel access token'), 'try-me');
    expect(
      within(line).getByText('Tests the values you typed, without saving them.'),
    ).toBeVisible();
    await user.click(within(line).getByRole('button', { name: 'Test connection' }));
    expect(await within(line).findByText('The channel access token is missing.')).toBeVisible();
    expect(within(line).getByText('Last check failed')).toBeVisible();
    expect(api.callsTo('/v1/admin/integrations/line/test', 'POST')[0]?.body).toEqual({
      fields: { channelAccessToken: 'try-me' },
    });
    expect(api.callsTo('/v1/admin/integrations/line', 'PUT')).toHaveLength(0);
  });

  it('explains a rate limit', async () => {
    const user = userEvent.setup();
    setup({ 'POST /v1/admin/integrations/:integration/test': apiError(429, 'rate_limited') });
    const discord = await screen.findByRole('region', { name: 'Discord' });
    await user.click(within(discord).getByRole('button', { name: 'Test connection' }));
    expect(await within(discord).findByText(/Too many tests in a minute/)).toBeVisible();
  });

  it('says so when live tests are on', async () => {
    const user = userEvent.setup();
    setup({ 'GET /v1/admin/integrations': { json: makeIntegrationList({}, 'live') } });
    const note = await screen.findByRole('note');
    await within(note).findByText('Live');
    await user.click(within(note).getByRole('button', { name: 'More about Live' }));
    expect(await screen.findByText(/contacts the real service/)).toBeVisible();
  });
});

describe('Integrations: channel accounts', () => {
  it('lists accounts with the LINE webhook URL to copy, notes and credential state', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup();
    const list = await screen.findByRole('list', { name: 'Channel accounts' });
    const rows = within(list)
      .getAllByRole('listitem')
      .filter((row) => row.hasAttribute('data-account'));
    expect(rows).toHaveLength(2);
    const lineRow = rows[0];
    if (!lineRow) throw new Error('no row');
    expect(within(lineRow).getByText('Support LINE')).toBeVisible();
    expect(within(lineRow).getByText(/Save the channel access token/)).toBeVisible();
    const url = within(lineRow).getByLabelText(/Webhook URL/);
    expect(url).toHaveValue(LINE_ACCOUNT.webhookUrl);
    expect(url).toHaveAttribute('readonly');
    await user.click(within(lineRow).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(LINE_ACCOUNT.webhookUrl);
    const gmailRow = rows[1];
    if (!gmailRow) throw new Error('no row');
    expect(within(gmailRow).getByText('Mailbox support@example.com')).toBeVisible();
    expect(within(gmailRow).queryByLabelText(/Webhook URL/)).toBeNull();
  });

  it('adds a LINE account with a name only, and a Gmail mailbox with a valid address', async () => {
    const user = userEvent.setup();
    const api = setup({
      'POST /v1/admin/channel-accounts': { status: 201, json: LINE_ACCOUNT },
    });
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    let sheet = await screen.findByRole('dialog', { name: 'Add a channel account' });
    await user.type(within(sheet).getByLabelText('Name'), 'Main LINE');
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/admin/channel-accounts', 'POST')).toHaveLength(1);
    });
    expect(api.callsTo('/v1/admin/channel-accounts', 'POST')[0]?.body).toEqual({
      type: 'line',
      name: 'Main LINE',
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add a channel account' })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    sheet = await screen.findByRole('dialog', { name: 'Add a channel account' });
    await user.selectOptions(within(sheet).getByLabelText('Type'), 'gmail');
    await user.type(within(sheet).getByLabelText('Name'), 'Second box');
    await user.type(within(sheet).getByLabelText('Mailbox address'), 'not-an-address');
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    expect(await within(sheet).findByText('Enter a valid email address.')).toBeVisible();
    expect(api.callsTo('/v1/admin/channel-accounts', 'POST')).toHaveLength(1);
    await user.clear(within(sheet).getByLabelText('Mailbox address'));
    await user.type(within(sheet).getByLabelText('Mailbox address'), '  Help@Example.com ');
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/admin/channel-accounts', 'POST')).toHaveLength(2);
    });
    expect(api.callsTo('/v1/admin/channel-accounts', 'POST')[1]?.body).toEqual({
      type: 'gmail',
      name: 'Second box',
      emailAddress: 'help@example.com',
    });
  });

  it('shows the api sentence when a second LINE account is refused', async () => {
    const user = userEvent.setup();
    setup({
      'POST /v1/admin/channel-accounts': apiError(
        409,
        'conflict',
        'Disable the active LINE account first.',
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add a channel account' });
    await user.type(within(sheet).getByLabelText('Name'), 'Another');
    await user.click(within(sheet).getByRole('button', { name: 'Add account' }));
    expect(await within(sheet).findByText(/Disable the active LINE account first\./)).toBeVisible();
  });

  it('switches an account off after a confirmation that says nothing is deleted', async () => {
    const user = userEvent.setup();
    const api = setup({
      'POST /v1/admin/channel-accounts/:id/disable': {
        json: { ...LINE_ACCOUNT, enabled: false, disabledAt: '2026-11-02T03:00:00.000Z' },
      },
    });
    await user.click(await screen.findByRole('button', { name: /Switch off\s+Support LINE/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Switch off Support LINE?' });
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeVisible();
    expect(
      api.callsTo(`/v1/admin/channel-accounts/${LINE_ACCOUNT.id}/disable`, 'POST'),
    ).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() => {
      expect(
        api.callsTo(`/v1/admin/channel-accounts/${LINE_ACCOUNT.id}/disable`, 'POST'),
      ).toHaveLength(1);
    });
  });

  it('has an empty state and an error state with a retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    setup({
      'GET /v1/admin/channel-accounts': () =>
        fail ? apiError(500, 'unknown') : { json: { items: [] } },
    });
    const retry = await screen.findAllByRole('button', { name: 'Try again' });
    fail = false;
    await user.click(retry[0] as HTMLElement);
    expect(await screen.findByText('No channel account yet.')).toBeVisible();
  });
});

describe('Integrations: Gmail connection', () => {
  const gmailPanel = async () =>
    within(await screen.findByRole('group', { name: 'Gmail connection' }));

  it('starts the OAuth flow for the typed mailbox and sends the browser to Google', async () => {
    const user = userEvent.setup();
    const api = setup({
      'POST /v1/admin/integrations/gmail/oauth/start': {
        json: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
          expiresAt: '2026-11-02T03:10:00.000Z',
          redirectUri: 'https://watchtower.example.com/v1/admin/integrations/gmail/oauth/callback',
        },
      },
    });
    const panel = await gmailPanel();
    expect(panel.getByText('No mailbox is connected with Gmail sign-in.')).toBeVisible();
    expect(panel.getByText(/gmail\/oauth\/callback/)).toBeVisible();
    await user.type(panel.getByLabelText('Support mailbox to connect'), 'Support@Example.com');
    await user.click(panel.getByRole('button', { name: 'Connect Gmail' }));
    await waitFor(() => {
      expect(nav.navigate).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      );
    });
    expect(api.callsTo('/v1/admin/integrations/gmail/oauth/start', 'POST')[0]?.body).toEqual({
      mailbox: 'support@example.com',
    });
  });

  it('refuses an address that is not an email, and an authorization URL that is not https', async () => {
    const user = userEvent.setup();
    const api = setup({
      'POST /v1/admin/integrations/gmail/oauth/start': {
        json: {
          authorizationUrl: 'http://accounts.example.com/insecure',
          expiresAt: '2026-11-02T03:10:00.000Z',
          redirectUri: 'https://watchtower.example.com/v1/admin/integrations/gmail/oauth/callback',
        },
      },
    });
    const panel = await gmailPanel();
    await user.type(panel.getByLabelText('Support mailbox to connect'), 'nope');
    await user.click(panel.getByRole('button', { name: 'Connect Gmail' }));
    expect(await panel.findByText('Enter a valid email address.')).toBeVisible();
    expect(api.callsTo('/v1/admin/integrations/gmail/oauth/start', 'POST')).toHaveLength(0);

    await user.clear(panel.getByLabelText('Support mailbox to connect'));
    await user.type(panel.getByLabelText('Support mailbox to connect'), 'ok@example.com');
    await user.click(panel.getByRole('button', { name: 'Connect Gmail' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('not secure');
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('needs the OAuth client saved first', async () => {
    setup({
      'GET /v1/admin/integrations/gmail/oauth/status': {
        json: makeGmailStatus({ oauthClientConfigured: false }),
      },
    });
    const panel = await gmailPanel();
    expect(panel.getByText('Save the OAuth client ID and secret above first.')).toBeVisible();
    expect(panel.getByRole('button', { name: 'Connect Gmail' })).toBeDisabled();
  });

  it('shows the connected mailbox, asks to reconnect after a refused token, and disconnects after a confirmation', async () => {
    const user = userEvent.setup();
    const api = setup({
      'GET /v1/admin/integrations/gmail/oauth/status': {
        json: makeGmailStatus({
          oauthConnected: true,
          oauthMailbox: 'support@example.com',
          effectiveMethod: 'oauth',
          needsReconnect: true,
        }),
      },
      'POST /v1/admin/integrations/gmail/oauth/disconnect': { json: { revoke: 'failed' } },
    });
    const panel = await gmailPanel();
    expect(panel.getByText('Connected as support@example.com')).toBeVisible();
    expect(panel.getByText('In use: Gmail sign-in (OAuth)')).toBeVisible();
    expect(panel.getByRole('alert')).toHaveTextContent('The mail provider refused the saved token');
    expect(panel.getByRole('button', { name: 'Connect again' })).toBeEnabled();
    await user.click(panel.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect support@example.com?' });
    expect(api.callsTo('/v1/admin/integrations/gmail/oauth/disconnect', 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/admin/integrations/gmail/oauth/disconnect', 'POST')).toHaveLength(1);
    });
  });

  it('turns Connect and Disconnect off when the environment holds the grant', async () => {
    setup({
      'GET /v1/admin/integrations': {
        json: makeIntegrationList({
          gmail: makeIntegration('gmail', {
            oauthClientId: 'db',
            oauthClientSecret: 'db',
            oauthRefreshToken: 'env',
            oauthMailbox: 'env',
          }),
        }),
      },
      'GET /v1/admin/integrations/gmail/oauth/status': {
        json: makeGmailStatus({
          oauthConnected: true,
          oauthMailbox: 'support@example.com',
          effectiveMethod: 'oauth',
        }),
      },
    });
    const panel = await gmailPanel();
    expect(
      panel.getByText(/set by an environment variable, so Connect and Disconnect are off/),
    ).toBeVisible();
    expect(panel.getByRole('button', { name: 'Connect again' })).toBeDisabled();
    expect(panel.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });

  it('never offers an input for the refresh token or the mailbox of the grant', async () => {
    setup();
    const gmail = await screen.findByRole('region', { name: 'Gmail' });
    expect(within(gmail).queryByText('OAuth refresh token')).toBeNull();
    expect(within(gmail).queryByText('Mailbox the OAuth grant belongs to')).toBeNull();
    expect(within(gmail).getByText('Connect with Gmail sign-in (default)')).toBeVisible();
    expect(
      within(gmail).getByText('Or a service account with domain-wide delegation'),
    ).toBeVisible();
  });

  it.each([
    ['connected', 'Gmail is connected.'],
    ['denied', 'Sign-in was cancelled or refused. Nothing was saved.'],
    [
      'scope_mismatch',
      'The mail provider granted other permissions than read and send mail. Nothing was saved.',
    ],
    ['mailbox_mismatch', 'You signed in with a different account'],
    ['env_locked', 'set by an environment variable, so it cannot be saved here'],
  ])('shows the result of ?gmail_oauth=%s in words and dismisses it', async (code, text) => {
    const user = userEvent.setup();
    nav.search = `gmail_oauth=${code}`;
    setup();
    expect(
      await screen.findByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(nav.replace).toHaveBeenCalledWith('/admin/integrations');
  });

  it('ignores a result code it does not know', async () => {
    nav.search = 'gmail_oauth=%3Cb%3Ehi';
    setup();
    await screen.findByRole('region', { name: 'Gmail' });
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('Integrations: access and states', () => {
  it('is for the head only', async () => {
    setup({}, 'lead');
    expect(await screen.findByText('It needs the Head role.')).toBeVisible();
    expect(screen.queryByText('Credentials')).toBeNull();
  });

  it('has a loading state and an error state with a retry for the credentials', async () => {
    const user = userEvent.setup();
    let fail = true;
    setup({
      'GET /v1/admin/integrations': () =>
        fail ? apiError(500, 'unknown') : { json: makeIntegrationList() },
    });
    expect(await screen.findByText('Could not load the integrations.')).toBeVisible();
    fail = false;
    const alert = screen.getByText('Could not load the integrations.').closest('[role="alert"]');
    if (!(alert instanceof HTMLElement)) throw new Error('no alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Discord' })).toBeVisible();
  });

  it('renders in Thai', async () => {
    consoleApi({ overrides: READS });
    renderConsole(<IntegrationsPage />, { locale: 'th' });
    expect(await screen.findByText('บัญชีช่องทาง')).toBeVisible();
    expect(await screen.findByRole('region', { name: 'LINE Official Account' })).toBeVisible();
    expect(screen.getAllByText('ทดสอบการเชื่อมต่อ').length).toBeGreaterThan(0);
  });
});
