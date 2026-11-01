import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TimelineEntry } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWorkspace } from '@/test-utils';
import { makeClientTicket, makeMessage, makeTicket, uuid } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openTicket(key = 'OPS-1', options: Parameters<typeof renderWorkspace>[0] = {}) {
  window.history.replaceState(null, '', `/?ticket=${key}`);
  const view = renderWorkspace(options);
  const conversation = await screen.findByRole('region', { name: 'Conversation' });
  return { ...view, conversation };
}

const ticket1 = makeTicket(1, { subject: 'Cannot log in' });

function replyResult(ticket = ticket1) {
  return {
    status: 201,
    json: {
      message: makeMessage(50, ticket, {
        direction: 'outbound',
        sender: { type: 'user', id: uuid(900), name: 'Alex Agent' },
      }),
      ticket,
    },
  };
}

describe('timeline', () => {
  const entries: TimelineEntry[] = [
    makeMessage(1, ticket1, { bodyText: 'I cannot sign in to the portal.' }),
    makeMessage(2, ticket1, {
      direction: 'outbound',
      sender: { type: 'user', id: uuid(900), name: 'Alex Agent' },
      bodyText: 'Please try resetting your password.',
      deliveryStatus: 'failed',
    }),
    makeMessage(3, ticket1, {
      direction: 'internal',
      visibility: 'internal',
      sender: { type: 'user', id: uuid(901), name: 'Sam Support' },
      bodyText: 'Looks like the SSO config. Do not tell the customer yet.',
    }),
    {
      kind: 'event',
      id: uuid(3000),
      ticketId: ticket1.id,
      ticketKey: ticket1.key,
      type: 'ticket.status_changed',
      actor: { type: 'user', id: uuid(900), name: 'Alex Agent' },
      visibility: 'public',
      payload: { from: 'open', to: 'resolved' },
      createdAt: '2026-11-02T03:00:00.000Z',
    },
  ];

  it('tells a public reply from an internal note by words, icon and border', async () => {
    workspaceApi({ tickets: [ticket1], timelines: { 'OPS-1': entries } });
    const { conversation } = await openTicket();
    const timeline = await within(conversation).findByRole('list', { name: 'Messages and events' });

    const messages = within(timeline).getAllByRole('article');
    expect(messages.map((message) => message.getAttribute('data-message-kind'))).toEqual([
      'customer',
      'reply',
      'internal',
    ]);
    const [customer, reply, note] = messages;
    if (!customer || !reply || !note) throw new Error('messages missing');

    // No role label on a message: avatar, name and time are enough. Only a note keeps a lock
    // (with its words for screen readers) and the dashed border, so it cannot pass for a reply.
    expect(within(customer).queryByText('Customer message')).toBeNull();
    expect(within(reply).queryByText('Public reply')).toBeNull();
    expect(within(note).getByText('Internal note')).toHaveClass('sr-only');
    expect(note.querySelector('header svg.lucide-lock')).not.toBeNull();
    expect(customer.querySelector('header svg.lucide-lock')).toBeNull();
    expect(note).toHaveClass('border-dashed');
    expect(reply).not.toHaveClass('border-dashed');
    expect(reply).toHaveAccessibleName('Public reply');
    expect(note).toHaveAccessibleName('Internal note');
  });

  it('shows a delivery failure in words and system events as a sentence', async () => {
    workspaceApi({ tickets: [ticket1], timelines: { 'OPS-1': entries } });
    const { conversation } = await openTicket();
    expect(
      await within(conversation).findByText('Could not be delivered to the customer'),
    ).toBeVisible();
    expect(within(conversation).getByText(/Status changed from Open to Resolved/)).toBeVisible();
    expect(within(conversation).getByText(/by Alex Agent/)).toBeVisible();
  });

  it('shows message text as text, never as markup', async () => {
    workspaceApi({
      tickets: [ticket1],
      timelines: {
        'OPS-1': [makeMessage(1, ticket1, { bodyText: '<img src=x onerror=alert(1)> hi' })],
      },
    });
    const { conversation } = await openTicket();
    expect(await within(conversation).findByText('<img src=x onerror=alert(1)> hi')).toBeVisible();
    expect(conversation.querySelector('img[src="x"]')).toBeNull();
  });

  it('says when there are no messages yet', async () => {
    workspaceApi({ tickets: [ticket1], timelines: { 'OPS-1': [] } });
    await openTicket();
    expect(await screen.findByText('No messages yet')).toBeVisible();
  });

  it('says so, with a retry, when the messages cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    workspaceApi({
      tickets: [ticket1],
      overrides: {
        'GET /v1/tickets/:id/timeline': () =>
          fail
            ? apiError(500, 'unknown')
            : {
                json: {
                  entries: [makeMessage(1, ticket1, { bodyText: 'Now it works' })],
                  nextCursor: null,
                },
              },
      },
    });
    await openTicket();
    expect(await screen.findByText('The messages could not be loaded')).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Now it works')).toBeVisible();
  });

  it('follows every page of a long conversation', async () => {
    workspaceApi({
      tickets: [ticket1],
      overrides: {
        'GET /v1/tickets/:id/timeline': ({ url }) =>
          url.searchParams.get('cursor') === 'p2'
            ? {
                json: {
                  entries: [makeMessage(2, ticket1, { bodyText: 'Second page message' })],
                  nextCursor: null,
                },
              }
            : {
                json: {
                  entries: [makeMessage(1, ticket1, { bodyText: 'First page message' })],
                  nextCursor: 'p2',
                },
              },
      },
    });
    await openTicket();
    expect(await screen.findByText('First page message')).toBeVisible();
    expect(await screen.findByText('Second page message')).toBeVisible();
  });
});

describe('conversation states', () => {
  it('shows a skeleton while loading, and "not found" for a ticket that is not there', async () => {
    workspaceApi({ tickets: [ticket1] });
    await openTicket('OPS-404');
    expect(await screen.findByText('Ticket not found')).toBeVisible();
    expect(screen.getByText('It does not exist, or you do not have access to it.')).toBeVisible();
  });

  it('offers a retry when the ticket cannot be loaded', async () => {
    workspaceApi({
      tickets: [ticket1],
      overrides: { 'GET /v1/tickets/:id': apiError(500, 'unknown') },
    });
    const { conversation } = await openTicket();
    expect(await within(conversation).findByText('The ticket could not be loaded')).toBeVisible();
    expect(within(conversation).getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('composer: reply', () => {
  it('sends a public reply with the CSRF token and clears the box', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket1],
      overrides: { 'POST /v1/tickets/:id/replies': replyResult() },
    });
    await openTicket();
    const box = await screen.findByRole('textbox', { name: 'Public reply' });

    expect(screen.getByText('The customer will read this. It is sent by Portal.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    await user.type(box, 'We are looking into it.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Reply sent.')).toBeVisible();
    const post = api.callsTo('/v1/tickets/OPS-1/replies', 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toEqual({ body: 'We are looking into it.' });
    expect(post[0]?.headers.get('x-csrf-token')).toBe('csrf-token-for-tests');
    expect(box).toHaveValue('');
    // The timeline was asked for again so the new message appears.
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/timeline').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('sends with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket1],
      overrides: { 'POST /v1/tickets/:id/replies': replyResult() },
    });
    await openTicket();
    await user.type(await screen.findByRole('textbox', { name: 'Public reply' }), 'Quick answer');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(1);
    });
  });

  it('"reply and set status" sends both in one request and offers only valid next statuses', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket1],
      overrides: { 'POST /v1/tickets/:id/replies': replyResult() },
    });
    await openTicket();
    await user.type(await screen.findByRole('textbox', { name: 'Public reply' }), 'Fixed, thanks.');

    // The next statuses sit behind a small menu in the composer toolbar.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Then set status:/ })).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: /^Then set status:/ }));
    const offered = (await screen.findAllByRole('menuitemradio')).map(
      (option) => option.textContent,
    );
    expect(offered).toContain('Resolved');
    expect(offered).toContain('Waiting on customer');
    expect(offered).not.toContain('Open'); // already open
    expect(offered).not.toContain('Merged'); // reached only by merging
    expect(offered).not.toContain('New'); // not an allowed move from open

    const resolved = screen.getByRole('menuitemradio', { name: 'Resolved' });
    resolved.focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Send reply and set Resolved' }));

    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body).toEqual({
        body: 'Fixed, thanks.',
        setStatus: 'resolved',
      });
    });
  });

  it('keeps the text and explains when the server refuses', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [ticket1],
      overrides: { 'POST /v1/tickets/:id/replies': apiError(409, 'invalid_transition') },
    });
    await openTicket();
    const box = await screen.findByRole('textbox', { name: 'Public reply' });
    await user.type(box, 'Do not lose me');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not send');
    expect(alert).toHaveTextContent('The ticket cannot move to that status from where it is now.');
    expect(box).toHaveValue('Do not lose me');
  });

  it('keeps an unsent draft when you move to another ticket and back', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openTicket();
    const box = await screen.findByRole('textbox', { name: 'Public reply' });
    await user.type(box, 'Half written');

    await user.click(await screen.findByRole('option', { name: /OPS-2/ }));
    await screen.findByRole('heading', { name: 'Export is slow', level: 3 });
    expect(await screen.findByRole('textbox', { name: 'Public reply' })).toHaveValue('');

    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    await screen.findByRole('heading', { name: 'Cannot log in', level: 3 });
    expect(await screen.findByRole('textbox', { name: 'Public reply' })).toHaveValue(
      'Half written',
    );
  });

  it('Escape leaves the box and hands the keyboard back to the queue', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openTicket();
    await user.click(await screen.findByRole('textbox', { name: 'Public reply' }));
    await user.keyboard('{Escape}');
    expect(document.getElementById('queue-listbox')).toHaveFocus();
  });

  it('C and N jump to the reply and note boxes', async () => {
    const user = userEvent.setup();
    workspaceApi();
    await openTicket();
    await screen.findByRole('textbox', { name: 'Public reply' });
    await user.click(screen.getByRole('option', { name: /OPS-1/ }));

    await user.keyboard('n');
    expect(await screen.findByRole('textbox', { name: 'Internal note' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.keyboard('c');
    expect(await screen.findByRole('textbox', { name: 'Public reply' })).toHaveFocus();
  });
});

/** Opens the template list in the composer toolbar and inserts one. */
async function pickTemplate(user: ReturnType<typeof userEvent.setup>, name: string) {
  const picker = await screen.findByRole('button', { name: 'Insert template' });
  await waitFor(() => {
    expect(picker).toBeEnabled();
  });
  await user.click(picker);
  await user.click(await screen.findByRole('option', { name }));
}

describe('composer: templates', () => {
  it('fills a template from the ticket and inserts it where the cursor is', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1] });
    await openTicket();
    const box = await screen.findByRole('textbox', { name: 'Public reply' });

    await pickTemplate(user, 'Ask for details');

    expect(box).toHaveValue(
      'Hello Riley Requester, about OPS-1: could you share more details? Alex Agent',
    );
    expect(screen.queryByText('Fill in the placeholders first')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled();
  });

  it('blocks sending while a placeholder has no value, and names it', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1] });
    await openTicket();
    await pickTemplate(user, 'Has a gap');

    expect(await screen.findByText('Fill in the placeholders first')).toBeVisible();
    expect(screen.getByText(/unknown\.thing/, { selector: 'div' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();

    // Writing over it clears the block.
    const box = screen.getByRole('textbox', { name: 'Public reply' });
    await user.clear(box);
    await user.type(box, 'Plain text');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled();
  });

  it('says when the intent has no templates', async () => {
    workspaceApi({
      tickets: [
        makeTicket(1, { intent: { id: uuid(701), key: 'billing', name: 'Billing question' } }),
      ],
    });
    await openTicket();
    const picker = await screen.findByRole('button', { name: /^(Insert template|No templates)/ });
    await waitFor(() => {
      expect(picker).toHaveTextContent('No templates for this intent');
    });
    expect(picker).toBeDisabled();
  });
});

describe('composer: internal notes', () => {
  it('switches to a note, which looks and reads differently, and posts it as a note', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket1],
      overrides: {
        'POST /v1/tickets/:id/notes': {
          status: 201,
          json: {
            message: makeMessage(60, ticket1, {
              direction: 'internal',
              visibility: 'internal',
              sender: { type: 'user', id: uuid(900), name: 'Alex Agent' },
            }),
            ticket: ticket1,
          },
        },
      },
    });
    await openTicket();
    await screen.findByRole('textbox', { name: 'Public reply' });

    await user.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByRole('radio', { name: 'Internal note' })).toBeChecked();
    // The banner, the lock, the muted surface and the dashed border all say "not sent".
    expect(screen.getByText('Internal note — not sent to the customer')).toBeVisible();
    expect(
      screen.getByRole('form', { name: 'Write a message' }).querySelector('[data-mode="note"]'),
    ).toHaveClass('border-dashed', 'bg-surface-muted');
    // No reply-only controls on a note.
    expect(screen.queryByRole('button', { name: /^Then set status:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert template' })).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Internal note' }), 'Check the SSO config');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByText('Note added.')).toBeVisible();
    expect(api.callsTo('/v1/tickets/OPS-1/notes', 'POST')[0]?.body).toEqual({
      body: 'Check the SSO config',
    });
    expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(0);
  });

  it('keeps the reply draft and the note draft apart', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1] });
    await openTicket();
    await user.type(
      await screen.findByRole('textbox', { name: 'Public reply' }),
      'for the customer',
    );
    await user.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByRole('textbox', { name: 'Internal note' })).toHaveValue('');
    await user.type(screen.getByRole('textbox', { name: 'Internal note' }), 'for the team');
    await user.click(screen.getByRole('radio', { name: 'Reply' }));
    expect(screen.getByRole('textbox', { name: 'Public reply' })).toHaveValue('for the customer');
  });
});

describe('composer: one box', () => {
  it('has a Reply / Internal note switch, a toolbar and the send button with its shortcut hint', async () => {
    workspaceApi({ tickets: [ticket1] });
    await openTicket();
    const form = await screen.findByRole('form', { name: 'Write a message' });
    expect(within(form).getByRole('radio', { name: 'Reply' })).toBeChecked();
    expect(within(form).getByRole('radio', { name: 'Internal note' })).not.toBeChecked();
    const toolbar = within(form).getByRole('group', { name: 'Composer tools' });
    expect(
      await within(toolbar).findByRole('button', { name: /^(Insert template|No templates)/ }),
    ).toBeInTheDocument();
    const send = within(form).getByRole('button', { name: 'Send reply' });
    // The Ctrl+Enter hint is decoration for the eye: it is not part of the button's name.
    expect(send.querySelector('kbd')?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Public reply' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Enter Meta+Enter',
    );
  });

  it('starts three rows tall and sets its height from the content', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket1] });
    await openTicket();
    const box = await screen.findByRole('textbox', { name: 'Public reply' });
    expect(box).toHaveAttribute('rows', '3');
    expect(box.style.height).toMatch(/^\d+px$/);
    await user.type(box, 'a');
    expect(box.style.height).toMatch(/^\d+px$/);
  });

  it('keeps attach as a placeholder that says "Coming in Phase 1" and does nothing; the AI lives in the brief', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({ tickets: [ticket1] });
    await openTicket();
    const attach = await screen.findByRole('button', { name: 'Attach a file' });
    expect(attach).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).toBeNull();
    const before = api.calls.length;
    await user.click(attach);
    expect(api.calls).toHaveLength(before);
  });

  it('puts a customer message into the reply as a quote from its hover action', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [ticket1],
      timelines: {
        'OPS-1': [makeMessage(1, ticket1, { bodyText: 'First line\nSecond line' })],
      },
    });
    const { conversation } = await openTicket();
    await user.click(await within(conversation).findByRole('button', { name: 'Quote in reply' }));
    const box = screen.getByRole('textbox', { name: 'Public reply' });
    expect(box).toHaveValue('> First line\n> Second line\n\n');
    await waitFor(() => {
      expect(box).toHaveFocus();
    });
  });

  it('does not offer Quote to someone who can only write notes', async () => {
    workspaceApi({
      tickets: [ticket1],
      overrides: {
        'GET /v1/auth/session': {
          json: {
            user: {
              id: uuid(900),
              email: 'x@example.com',
              name: 'Nora Notes',
              role: 'agent',
              orgId: null,
            },
            permissions: ['ticket.read', 'ticket.handle', 'auth.session.self'],
            sessionId: uuid(901),
            authMethod: 'dev',
            csrfToken: 'csrf',
            accessExpiresAt: '2026-11-02T03:15:00.000Z',
          },
        },
      },
    });
    const { conversation } = await openTicket();
    await within(conversation).findByRole('button', { name: 'Copy message' });
    expect(
      within(conversation).queryByRole('button', { name: 'Quote in reply' }),
    ).not.toBeInTheDocument();
  });
});

describe('ticket header', () => {
  it('has the key, the subject, status and priority pills and the actions', async () => {
    workspaceApi({ tickets: [makeTicket(1, { subject: 'Cannot log in', priority: 'P1' })] });
    const { conversation } = await openTicket();
    const heading = await within(conversation).findByRole('heading', {
      name: 'Cannot log in',
      level: 3,
    });
    const header = heading.closest('header');
    if (!header) throw new Error('header missing');
    expect(within(header).getByText('OPS-1')).toBeVisible();
    expect(within(header).getByText('Open').closest('[data-status="open"]')).toHaveClass(
      'rounded-full',
    );
    expect(header.querySelector('[data-severity="p1"]')).toHaveTextContent('P1 Critical');
    expect(within(header).getByRole('button', { name: 'Copy ticket key' })).toBeVisible();
  });

  it('resolves from the header and offers Undo, which reopens', async () => {
    const user = userEvent.setup();
    let current = makeTicket(1, { subject: 'Cannot log in' });
    const api = workspaceApi({
      tickets: [current],
      overrides: {
        'GET /v1/tickets/:id': () => ({ json: current }),
        'POST /v1/tickets/:id/status': ({ body }) => {
          current = { ...current, status: (body as { status: typeof current.status }).status };
          return { json: current };
        },
      },
    });
    const { conversation } = await openTicket();
    const resolve = await within(conversation).findByRole('button', { name: 'Resolve' });
    await waitFor(() => {
      expect(resolve).toBeEnabled();
    });
    await user.click(resolve);
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')[0]?.body).toEqual({
        status: 'resolved',
      });
    });
    expect(await screen.findByText('Status set to Resolved')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/status', 'POST')[1]?.body).toEqual({ status: 'open' });
    });
  });

  it('does not offer Resolve to someone who cannot handle tickets', async () => {
    workspaceApi({ role: 'client', tickets: [makeClientTicket(1)] });
    const { conversation } = await openTicket('OPS-1');
    await within(conversation).findByRole('heading', { level: 3 });
    expect(within(conversation).queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});

describe('composer: permissions and closed tickets', () => {
  it('a customer can only reply: no note toggle, no templates, no status change', async () => {
    const user = userEvent.setup();
    const clientTicket = makeClientTicket(1);
    const api = workspaceApi({
      role: 'client',
      tickets: [clientTicket],
      overrides: {
        'POST /v1/tickets/:id/replies': {
          status: 201,
          json: {
            message: makeMessage(70, clientTicket),
            ticket: clientTicket,
          },
        },
      },
    });
    await openTicket('OPS-1');
    const box = await screen.findByRole('textbox', { name: 'Public reply' });

    expect(screen.queryByRole('radio', { name: 'Internal note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Then set status:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Your message is added to this ticket and the support team is notified.'),
    ).toBeVisible();
    // Reference data only staff may read is never requested.
    expect(api.callsTo('/v1/ticket-workflow')).toHaveLength(0);
    expect(api.callsTo('/v1/queues')).toHaveLength(0);

    await user.type(box, 'Any update?');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body).toEqual({
        body: 'Any update?',
      });
    });
  });

  it('a user who can handle but not reply sees only the note composer', async () => {
    workspaceApi({
      tickets: [ticket1],
      overrides: {
        'GET /v1/auth/session': {
          json: {
            user: {
              id: uuid(900),
              email: 'x@example.com',
              name: 'Nora Notes',
              role: 'agent',
              orgId: null,
            },
            permissions: ['ticket.read', 'ticket.handle', 'auth.session.self'],
            sessionId: uuid(901),
            authMethod: 'dev',
            csrfToken: 'csrf',
            accessExpiresAt: '2026-11-02T03:15:00.000Z',
          },
        },
      },
    });
    await openTicket();
    expect(await screen.findByRole('textbox', { name: 'Internal note' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Public reply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('turns the composer off for a closed ticket', async () => {
    workspaceApi({ tickets: [makeTicket(1, { status: 'closed' })] });
    await openTicket();
    expect(await screen.findByText('This ticket is closed')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Public reply' })).not.toBeInTheDocument();
  });
});
