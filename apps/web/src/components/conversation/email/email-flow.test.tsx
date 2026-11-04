import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPendingSends } from '@/lib/outbound/pending-sends';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderApp, renderWorkspace } from '@/test-utils';
import { makeMessage, makeScheduledReply, makeTicket } from '@/test/fixtures';
import { workspaceApi } from '@/test/scenarios';

import { Timeline } from '../timeline';
import { emailDraftStore } from './email-composer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  resetPendingSends();
  localStorage.clear();
  resetPreferencesCache();
  emailDraftStore.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ticket = makeTicket(1, { subject: 'Printer is down', channel: 'gmail' });
const at = (minutes: number) =>
  new Date(Date.parse('2026-11-02T03:00:00.000Z') + minutes * 60_000).toISOString();

const customerMail = makeMessage(1, ticket, {
  channel: 'gmail',
  bodyText: 'The printer is down.\n\nOn Mon, Alex wrote:\n> earlier',
  bodyHtml:
    '<div>The printer is down.</div><div><div>On Mon, Alex &lt;alex@example.com&gt; wrote:<br></div><blockquote>earlier text</blockquote></div>',
  emailMeta: {
    from: { address: 'sam@example.org', name: 'Sam Customer' },
    to: [{ address: 'help@example.com' }],
    cc: [{ address: 'boss@example.org', name: 'Boss' }],
    bcc: [],
    subject: 'Printer is down',
  },
  createdAt: at(0),
});
const teamMail = makeMessage(2, ticket, {
  channel: 'gmail',
  direction: 'outbound',
  sender: { type: 'user', id: '0b1b6f2e-0000-4000-8000-000000000001', name: 'Alex Agent' },
  bodyText: 'We are on it.',
  bodyHtml: '<p>We are on it.</p>',
  emailMeta: {
    to: [{ address: 'sam@example.org', name: 'Sam Customer' }],
    cc: [],
    bcc: [],
    subject: 'Re: Printer is down',
  },
  createdAt: at(10),
});
const newest = makeMessage(3, ticket, {
  channel: 'gmail',
  bodyText: 'Any news?',
  bodyHtml: '<p>Any news?</p>',
  emailMeta: {
    from: { address: 'sam@example.org', name: 'Sam Customer' },
    to: [],
    cc: [],
    bcc: [],
    subject: 'Re: Printer is down',
  },
  createdAt: at(30),
});

describe('an email thread in the timeline', () => {
  it('opens the newest mail and keeps older ones to a line each, with the subject on top', () => {
    renderApp(<Timeline entries={[customerMail, teamMail, newest]} />);
    expect(screen.getByRole('heading', { name: 'Printer is down' })).toBeVisible();
    expect(screen.getByText('3 messages')).toBeVisible();
    const cards = screen.getAllByRole('article');
    expect(cards.map((card) => card.getAttribute('data-email'))).toEqual([
      'collapsed',
      'collapsed',
      'expanded',
    ]);
    // The mail body is an isolated, script-less frame.
    const frame = within(cards[2] as HTMLElement).getByTitle(/Email from Sam Customer/);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('Any news?');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
  });

  it('expands an older mail on click and Expand all opens the rest', async () => {
    const user = userEvent.setup();
    renderApp(<Timeline entries={[customerMail, teamMail, newest]} />);
    await user.click(screen.getByRole('button', { name: 'Expand message from Alex Agent' }));
    expect(screen.getAllByRole('article').map((c) => c.getAttribute('data-email'))).toEqual([
      'collapsed',
      'expanded',
      'expanded',
    ]);
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(
      screen.getAllByRole('article').every((c) => c.getAttribute('data-email') === 'expanded'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(
      screen.getAllByRole('article').every((c) => c.getAttribute('data-email') === 'collapsed'),
    ).toBe(true);
  });

  it('trims the quoted history until asked, and shows To / Cc in the details', async () => {
    const user = userEvent.setup();
    renderApp(<Timeline entries={[customerMail]} />);
    const frame = () => screen.getByTitle(/Email from Sam Customer/).getAttribute('srcdoc') ?? '';
    expect(frame()).toContain('The printer is down.');
    expect(frame()).not.toContain('earlier text');
    await user.click(screen.getByRole('button', { name: 'Show trimmed content' }));
    expect(frame()).toContain('earlier text');

    await user.click(screen.getByRole('button', { name: /: Show details$/ }));
    expect(screen.getByText('Boss <boss@example.org>')).toBeVisible();
    expect(screen.getByText('<sam@example.org>')).toBeVisible();
  });

  it('keeps a text-only mail as text, never as html', () => {
    const plain = makeMessage(5, ticket, { channel: 'gmail', bodyText: '<b>not bold</b>' });
    renderApp(<Timeline entries={[plain]} />);
    expect(screen.getByText('<b>not bold</b>')).toBeVisible();
    expect(screen.queryByTitle(/Email from/)).toBeNull();
  });

  it('leaves other channels as they were', () => {
    const portal = makeMessage(6, makeTicket(2), { bodyText: 'From the portal' });
    renderApp(<Timeline entries={[portal]} />);
    expect(screen.getByText('From the portal')).toBeVisible();
    expect(screen.queryByText(/messages$/)).toBeNull();
  });
});

describe('the email composer', () => {
  async function open() {
    window.history.replaceState(null, '', '/?ticket=OPS-1');
    renderWorkspace();
    return screen.findByRole('textbox', { name: 'Public reply' });
  }

  it('fills in To and Subject from the thread and sends HTML with the recipients', async () => {
    const user = userEvent.setup();
    const api = workspaceApi({
      tickets: [ticket],
      timelines: { 'OPS-1': [customerMail] },
      overrides: {
        // Built when answered: the 5 s hold starts then, not when the test is set up.
        'POST /v1/tickets/:id/replies': () => ({
          status: 201,
          json: { message: makeScheduledReply(60, ticket, 5000), ticket },
        }),
      },
    });
    const editor = await open();
    expect(screen.getByTestId('email-composer')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Remove sam@example.org' })).toBeVisible();
    expect(screen.getByLabelText('Subject')).toHaveValue('Re: Printer is down');
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();

    // Reply all offers the other people on the mail, not the writer's own address.
    await user.click(screen.getByRole('button', { name: 'Reply all' }));
    expect(screen.getByRole('button', { name: 'Remove boss@example.org' })).toBeVisible();

    editor.innerHTML = '<p>Fixed <b>now</b>.</p>';
    fireEvent.input(editor);
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => {
      expect(api.callsTo('/v1/tickets/OPS-1/replies', 'POST')).toHaveLength(1);
    });
    const body = api.callsTo('/v1/tickets/OPS-1/replies', 'POST')[0]?.body as {
      body: string;
      email: {
        to: { address: string }[];
        cc: { address: string }[];
        subject: string;
        bodyHtml: string;
      };
    };
    expect(body.body).toContain('Fixed now.');
    expect(body.body).toContain('> The printer is down.');
    expect(body.email.to.map((a) => a.address)).toEqual(['sam@example.org']);
    expect(body.email.cc.map((a) => a.address)).toEqual(['help@example.com', 'boss@example.org']);
    expect(body.email.subject).toBe('Re: Printer is down');
    expect(body.email.bodyHtml).toContain('<b>now</b>');
    expect(body.email.bodyHtml).toContain('<blockquote>');
  });

  it('refuses to send with nobody in To, and says so by the field', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket], timelines: { 'OPS-1': [customerMail] } });
    const editor = await open();
    await user.click(await screen.findByRole('button', { name: 'Remove sam@example.org' }));
    editor.innerHTML = '<p>Hello</p>';
    fireEvent.input(editor);
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    await user.type(screen.getByLabelText('To'), 'not-an-address,');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"not-an-address" is not an email address',
    );
  });

  it('shows the finished mail in a preview frame', async () => {
    const user = userEvent.setup();
    workspaceApi({ tickets: [ticket], timelines: { 'OPS-1': [customerMail] } });
    const editor = await open();
    editor.innerHTML = '<p>Preview me</p>';
    fireEvent.input(editor);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = screen.getByTitle('This is how the email will look');
    expect(frame.getAttribute('srcdoc')).toContain('Preview me');
    expect(frame.getAttribute('srcdoc')).toContain('<blockquote>');
  });

  it('keeps the plain composer on a LINE ticket', async () => {
    workspaceApi({ tickets: [makeTicket(1, { channel: 'line' })] });
    const box = await open();
    expect(box.tagName).toBe('TEXTAREA');
    expect(screen.queryByTestId('email-composer')).toBeNull();
  });
});
