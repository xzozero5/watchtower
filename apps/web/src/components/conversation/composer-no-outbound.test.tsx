import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPendingSends } from '@/lib/outbound/pending-sends';
import { resetPreferencesCache } from '@/lib/preferences';
import { renderWorkspace } from '@/test-utils';
import { makeTicket } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  resetPendingSends();
  localStorage.clear();
  resetPreferencesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(locale: 'en' | 'th' = 'en') {
  window.history.replaceState(null, '', '/?ticket=OPS-1');
  renderWorkspace({ locale });
  await screen.findByRole('form', { name: locale === 'en' ? 'Write a message' : 'เขียนข้อความ' });
}

describe('a ticket whose channel has no outbound', () => {
  it.each(['phone', 'walk_in', 'chat', 'other'] as const)(
    'turns Reply off up front on %s, says why and opens on Note',
    async (channel) => {
      workspaceApi({ tickets: [makeTicket(1, { channel })] });
      await open();
      expect(screen.queryByRole('radio', { name: 'Reply' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
      expect(screen.getByTestId('reply-off')).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId('no-outbound')).toHaveTextContent(
        "replies can't be sent from here. Record what you told the customer as an internal note.",
      );
      expect(screen.getByRole('textbox', { name: 'Internal note' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add note' })).toBeVisible();
    },
  );

  it('says it in Thai', async () => {
    workspaceApi({ tickets: [makeTicket(1, { channel: 'phone' })] });
    await open('th');
    expect(screen.getByTestId('no-outbound')).toHaveTextContent('ส่งคำตอบจากที่นี่ไม่ได้');
  });

  it('keeps Reply on a channel that can send', async () => {
    workspaceApi({ tickets: [makeTicket(1, { channel: 'gmail' })] });
    await open();
    expect(screen.queryByTestId('reply-off')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Public reply' })).toBeVisible();
  });
});

describe('a send the api refuses', () => {
  it("shows the api's own message when it explains itself", async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [makeTicket(1, { channel: 'gmail' })],
      overrides: {
        'POST /v1/tickets/:id/replies': apiError(
          422,
          'validation_failed',
          'The reply is longer than the channel allows.',
        ),
      },
    });
    await open();
    await user.type(screen.getByRole('textbox', { name: 'Public reply' }), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The reply is longer than the channel allows.',
      );
    });
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  it('uses the generic line only when the api said nothing useful', async () => {
    const user = userEvent.setup();
    workspaceApi({
      tickets: [makeTicket(1, { channel: 'gmail' })],
      overrides: { 'POST /v1/tickets/:id/replies': { status: 500, json: {} } },
    });
    await open();
    await user.type(screen.getByRole('textbox', { name: 'Public reply' }), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByText(/Something went wrong/)).toBeVisible();
  });
});
