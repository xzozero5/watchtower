import { waitFor } from '@testing-library/react';
import { type Role, type TicketStatus } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSession } from '@/lib/auth/session';
import { renderApp } from '@/test-utils';
import { makeSession } from '@/test/fixtures';
import { mockApi } from '@/test/mock-api';

import { StatusLabel } from './status-label';

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe({ status }: { status: TicketStatus }) {
  // Wait for the session before drawing, as the auth gate does.
  return useSession().status === 'authenticated' ? <StatusLabel status={status} /> : null;
}

async function show(role: Role, status: TicketStatus, locale?: 'th') {
  mockApi({ 'GET /v1/auth/session': { json: makeSession(role) } });
  renderApp(<Probe status={status} />, locale ? { locale } : {});
  await waitFor(() => {
    expect(document.querySelector('[data-status], [data-customer-status]')).not.toBeNull();
  });
  return document.querySelector<HTMLElement>(
    '[data-status], [data-customer-status]',
  ) as HTMLElement;
}

describe('StatusLabel', () => {
  it('shows staff the internal status', async () => {
    const label = await show('agent', 'waiting_on_dev');
    expect(label).toHaveAttribute('data-status', 'waiting_on_dev');
    expect(label).toHaveTextContent('Waiting on developers');
  });

  it.each([
    ['new', 'Received'],
    ['triage', 'In progress'],
    ['open', 'In progress'],
    ['waiting_on_dev', 'In progress'],
    ['waiting_on_customer', 'Waiting for your reply'],
    ['resolved', 'Resolved'],
    ['closed', 'Closed'],
    ['merged', 'Merged'],
  ] as const)(
    'shows a customer user %s as "%s", the words of the portal',
    async (status, words) => {
      const label = await show('client', status);
      expect(label).toHaveAttribute('data-customer-status');
      expect(label).toHaveTextContent(words);
      expect(label.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    },
  );

  it('uses the Thai customer words too', async () => {
    const label = await show('client', 'waiting_on_customer', 'th');
    expect(label).toHaveTextContent('รอคำตอบจากคุณ');
  });
});
