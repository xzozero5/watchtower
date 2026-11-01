import { fireEvent, screen, within } from '@testing-library/react';
import type { TimelineEntry } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';
import { makeMessage, makeTicket, uuid } from '@/test/fixtures';

import { GROUP_WINDOW_MS, Timeline } from './timeline';

const ticket = makeTicket(1);
const at = (minutes: number) =>
  new Date(Date.parse('2026-11-02T03:00:00.000Z') + minutes * 60_000).toISOString();
const alex = { type: 'user' as const, id: uuid(900), name: 'Alex Agent' };
const sam = { type: 'user' as const, id: uuid(901), name: 'Sam Support' };
const riley = { type: 'contact' as const, id: uuid(600), name: 'Riley Requester' };

const reply = (n: number, minutes: number, sender = alex) =>
  makeMessage(n, ticket, {
    direction: 'outbound',
    sender,
    bodyText: `Reply ${String(n)}`,
    createdAt: at(minutes),
  });
const inbound = (n: number, minutes: number) =>
  makeMessage(n, ticket, {
    sender: riley,
    bodyText: `Question ${String(n)}`,
    createdAt: at(minutes),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Articles whose header is visible, that is, the first message of a block. */
const blockStarts = () =>
  screen
    .getAllByRole('article')
    .filter((article) => !article.querySelector('header')?.className.includes('sr-only'));

describe('timeline: grouping', () => {
  it('groups messages by the same author within five minutes under one name and avatar', () => {
    renderApp(<Timeline entries={[reply(1, 0), reply(2, 2), reply(3, 4)]} />);
    expect(blockStarts()).toHaveLength(1);
    expect(screen.getAllByRole('article')).toHaveLength(3);
    // Only the first message shows the author; the others keep a hidden header for screen readers.
    const [first, second] = screen.getAllByRole('article');
    expect(first?.querySelector('header')).not.toHaveClass('sr-only');
    expect(second?.querySelector('header')).toHaveClass('sr-only');
    expect(second).toHaveTextContent('Reply 2');
  });

  it('starts a new block after five minutes, for another author, or for another kind', () => {
    expect(GROUP_WINDOW_MS).toBe(5 * 60_000);
    renderApp(
      <Timeline
        entries={[
          reply(1, 0),
          reply(2, 6),
          reply(3, 7, sam),
          inbound(4, 8),
          makeMessage(5, ticket, {
            direction: 'internal',
            visibility: 'internal',
            sender: sam,
            bodyText: 'Note',
            createdAt: at(9),
          }),
        ]}
      />,
    );
    expect(blockStarts()).toHaveLength(5);
  });

  it('does not group across a system event', () => {
    const event: TimelineEntry = {
      kind: 'event',
      id: uuid(3000),
      ticketId: ticket.id,
      ticketKey: ticket.key,
      type: 'ticket.status_changed',
      actor: { type: 'user', id: alex.id, name: 'Alex Agent' },
      visibility: 'public',
      payload: { from: 'open', to: 'resolved' },
      createdAt: at(1),
    };
    renderApp(<Timeline entries={[reply(1, 0), event, reply(2, 2)]} />);
    expect(blockStarts()).toHaveLength(2);
  });
});

describe('timeline: sides and surfaces', () => {
  it('puts the customer on the left on a raised surface and the team on the right on a navy tint', () => {
    renderApp(<Timeline entries={[inbound(1, 0), reply(2, 1)]} />);
    const [customer, staff] = screen.getAllByRole('article');
    expect(customer).toHaveClass('bg-surface-muted');
    expect(customer?.closest('li')).not.toHaveClass('justify-end');
    expect(staff).toHaveClass('bg-primary-subtle');
    expect(staff?.closest('li')).toHaveClass('justify-end');
  });

  it('shows the author with an initials avatar, in the first message of a block', () => {
    renderApp(<Timeline entries={[reply(1, 0)]} />);
    const article = screen.getByRole('article');
    expect(within(article).getByText('Alex Agent')).toBeVisible();
    expect(article.querySelector('[data-hue]')).toHaveTextContent('AA');
  });
});

describe('timeline: events', () => {
  it('shows a system or AI event as one line, not a bubble, with the AI named', () => {
    const base = {
      kind: 'event' as const,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      visibility: 'public' as const,
      createdAt: at(0),
    };
    renderApp(
      <Timeline
        entries={[
          {
            ...base,
            id: uuid(3001),
            type: 'ticket.created',
            actor: { type: 'system', id: null, name: null },
            payload: {},
          },
          {
            ...base,
            id: uuid(3002),
            type: 'ticket.status_changed',
            actor: { type: 'ai', id: null, name: null },
            payload: { from: 'new', to: 'triage' },
          },
        ]}
      />,
    );
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByText('Ticket created')).toBeVisible();
    expect(screen.getByText(/Status changed from New to Triage/)).toHaveTextContent('by AI');
    const lines = screen.getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    // The AI is marked with the accent colour on its glyph, not with a sparkle.
    expect(lines[1]?.querySelector('svg')).toHaveClass('text-ai-accent');
    expect(lines[0]?.querySelector('svg')).not.toHaveClass('text-ai-accent');
  });
});

describe('timeline: time and actions', () => {
  it('shows how long ago (2m, 3h, 5d) and the exact date and time in a tooltip on focus', async () => {
    renderApp(<Timeline entries={[reply(1, 0)]} />);
    const time = screen.getAllByText(/^\d+[mhd]$|^now$/, { selector: 'time' })[0];
    if (!time) throw new Error('no time shown');
    expect(time).toHaveAttribute('dateTime', at(0));
    fireEvent.focus(time);
    fireEvent.pointerMove(time);
    fireEvent.mouseEnter(time);
    fireEvent.pointerEnter(time);
    const tip = await screen.findByRole('tooltip', undefined, { timeout: 2000 });
    expect(tip).toHaveTextContent(/Nov 2, 2026.*10:00/);
  });

  it('copies a message from its hover actions and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(<Timeline entries={[inbound(1, 0)]} canQuote={false} />);
    const group = screen.getByRole('group', { name: 'Message actions' });
    fireEvent.click(within(group).getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith('Question 1');
    expect(await screen.findByText('Message copied')).toBeVisible();
    // Reachable by keyboard: the group shows on focus-within.
    expect(group.className).toContain('focus-within:opacity-100');
    expect(group.className).toContain('group-hover/message:opacity-100');
  });

  it('offers Quote only to someone who may reply, and never on an internal note', () => {
    const onQuote = vi.fn();
    const note = makeMessage(2, ticket, {
      direction: 'internal',
      visibility: 'internal',
      sender: sam,
      bodyText: 'Team only',
      createdAt: at(1),
    });
    const { unmount } = renderApp(
      <Timeline entries={[inbound(1, 0), note]} canQuote onQuote={onQuote} />,
    );
    const quotes = screen.getAllByRole('button', { name: 'Quote in reply' });
    expect(quotes).toHaveLength(1);
    fireEvent.click(quotes[0] as HTMLElement);
    expect(onQuote).toHaveBeenCalledWith('Question 1');
    unmount();

    renderApp(<Timeline entries={[inbound(1, 0)]} canQuote={false} onQuote={onQuote} />);
    expect(screen.queryByRole('button', { name: 'Quote in reply' })).not.toBeInTheDocument();
  });
});
