import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWorkspace } from '@/test-utils';
import { makeMessage, makeTicket } from '@/test/fixtures';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

// T-114a C-3: an inbound email whose sender the mail server did not authenticate says so.
const ticket = makeTicket(1, { subject: 'Printer is down', channel: 'gmail' });
const mail = (senderAuth: 'pass' | 'fail' | 'none') =>
  makeMessage(1, ticket, {
    channel: 'gmail',
    direction: 'inbound',
    bodyText: 'The printer is down.',
    bodyHtml: '<p>The printer is down.</p>',
    emailMeta: {
      from: { address: 'sam@example.org', name: 'Sam Customer' },
      to: [{ address: 'help@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Printer is down',
      senderAuth,
    },
    createdAt: '2026-11-02T03:00:00.000Z',
  });

async function open(senderAuth: 'pass' | 'fail' | 'none') {
  workspaceApi({ tickets: [ticket], timelines: { 'OPS-1': [mail(senderAuth)] } });
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  renderWorkspace();
  await screen.findByRole('textbox', { name: 'Public reply' });
}

describe('unauthenticated sender badge', () => {
  it.each(['fail', 'none'] as const)('shows the badge when senderAuth is %s', async (value) => {
    await open(value);
    expect(await screen.findByTestId('unauthenticated-sender')).toHaveTextContent(
      'Unauthenticated sender',
    );
  });

  it('shows nothing when the sender passed', async () => {
    await open('pass');
    await screen.findAllByText('Sam Customer');
    expect(screen.queryByTestId('unauthenticated-sender')).toBeNull();
  });
});
