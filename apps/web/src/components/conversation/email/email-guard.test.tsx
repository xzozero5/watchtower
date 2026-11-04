import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftHandoff } from '@/lib/ai/draft-handoff';
import { resetPendingSends } from '@/lib/outbound/pending-sends';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeMessage, makeScheduledReply, makeTicket } from '@/test/fixtures';
import { workspaceApi } from '@/test/scenarios';

import { emailDraftStore } from './email-composer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  resetPendingSends();
  localStorage.clear();
  resetPreferencesCache();
  emailDraftStore.clear();
  draftHandoff.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ticket = makeTicket(1, { subject: 'Printer is down', channel: 'gmail' });
const customerMail = makeMessage(1, ticket, {
  channel: 'gmail',
  bodyText: 'The printer is down.',
  bodyHtml: '<p>The printer is down.</p>',
  emailMeta: {
    from: { address: 'sam@example.org', name: 'Sam Customer' },
    to: [{ address: 'help@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Printer is down',
  },
  createdAt: '2026-11-02T03:00:00.000Z',
});

async function open() {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  renderWorkspace();
  return screen.findByRole('textbox', { name: 'Public reply' });
}

describe('sending to another company (C-2)', () => {
  it('asks before sending when the api names domains the customer is not linked to, then confirms', async () => {
    const user = userEvent.setup();
    const sent = makeScheduledReply(60, ticket, 5000);
    let attempts = 0;
    const api = workspaceApi({
      tickets: [ticket],
      timelines: { 'OPS-1': [customerMail] },
      overrides: {
        'POST /v1/tickets/:id/replies': () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: 409,
                json: {
                  statusCode: 409,
                  error: 'Conflict',
                  code: 'external_recipients',
                  message: 'This reply goes to a domain that this customer is not linked to',
                  domains: ['stranger.test'],
                },
              }
            : { status: 201, json: { message: sent, ticket } };
        },
      },
    });
    const editor = await open();
    await screen.findByRole('button', { name: 'Remove sam@example.org' });
    await user.click(screen.getByRole('button', { name: 'Add Bcc' }));
    await user.type(screen.getByLabelText('Bcc'), 'someone@stranger.test,');
    editor.innerHTML = '<p>Hello</p>';
    fireEvent.input(editor);
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const dialog = await screen.findByRole('dialog', { name: 'Send outside this customer?' });
    expect(dialog).toHaveTextContent('stranger.test');
    // The api's refusal is the dialog, not an error banner.
    expect(screen.queryByText(/Could not send/i)).toBeNull();
    let first = api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body as {
      email: Record<string, unknown>;
    };
    expect(first.email.confirmedDomains).toBeUndefined();

    await user.click(screen.getByTestId('confirm-external'));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(2);
    });
    first = api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[1]?.body as {
      email: Record<string, unknown>;
    };
    expect(first.email.confirmedDomains).toEqual(['stranger.test']);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('keeps the mail when the person goes back, and sends nothing more', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket],
      timelines: { 'OPS-1': [customerMail] },
      overrides: {
        'POST /v1/tickets/:id/replies': {
          status: 409,
          json: {
            statusCode: 409,
            error: 'Conflict',
            code: 'external_recipients',
            message: 'x',
            domains: ['stranger.test'],
          },
        },
      },
    });
    const editor = await open();
    await screen.findByRole('button', { name: 'Remove sam@example.org' });
    editor.innerHTML = '<p>Keep me</p>';
    fireEvent.input(editor);
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByRole('dialog', { name: 'Send outside this customer?' });
    await user.click(screen.getByRole('button', { name: 'Back to the email' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Public reply' })).toHaveTextContent('Keep me');
  });
});

describe('an AI draft in the email editor (T-171)', () => {
  it('puts the draft in the rich editor, and sends it as an edit of that draft', async () => {
    const user = userEvent.setup();
    const sent = makeScheduledReply(60, ticket, 5000);
    const api = workspaceApi({
      tickets: [ticket],
      timelines: { 'OPS-1': [customerMail] },
      overrides: {
        'POST /v1/tickets/:id/replies': { status: 201, json: { message: sent, ticket } },
      },
    });
    draftHandoff.send('OPS-1', {
      draftId: '5f0d2b1a-0000-4000-8000-000000000001',
      text: 'Hello Sam,\n\nWe restarted the printer.',
    });
    const editor = await open();
    await waitFor(() => {
      expect(editor).toHaveTextContent('We restarted the printer.');
    });
    expect(screen.getByTestId('ai-draft-note')).toHaveTextContent('AI draft');
    expect(draftHandoff.has('OPS-1')).toBe(false);

    // The person changes it in the editor, as they would any mail.
    editor.innerHTML = '<p>Hello Sam,</p><p>We restarted the <b>printer</b>.</p>';
    fireEvent.input(editor);
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(1);
    });
    const body = api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body as {
      editedFromDraftId?: string;
      aiDraftId?: string;
      email: { bodyHtml: string };
    };
    expect(body.editedFromDraftId).toBe('5f0d2b1a-0000-4000-8000-000000000001');
    expect(body.aiDraftId).toBeUndefined();
    expect(body.email.bodyHtml).toContain('<b>printer</b>');
  });

  it('does not take a draft meant for a plain-text channel', async () => {
    workspaceApi({ tickets: [makeTicket(1, { channel: 'line' })] });
    draftHandoff.send('OPS-1', { draftId: 'd', text: 'x' });
    const box = await open();
    expect(box.tagName).toBe('TEXTAREA');
    expect(draftHandoff.has('OPS-1')).toBe(true);
  });
});
