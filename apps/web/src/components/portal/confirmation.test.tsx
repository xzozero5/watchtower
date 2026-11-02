import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSubmitted } from '@/lib/portal/submitted-handoff';
import { renderApp } from '@/test-utils';
import { mockApi } from '@/test/mock-api';

import { Confirmation } from './confirmation';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/portal/submitted');
  mockApi({});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('portal confirmation', () => {
  it('shows the ticket number, the masked address and the SLA target, but no tracking link', () => {
    saveSubmitted({
      ticketKey: 'OPS-12',
      maskedEmail: 'a***@example.com',
      status: 'received',
      expectedFirstResponseAt: '2026-11-05T08:00:00.000Z',
    });
    renderApp(<Confirmation />);
    expect(
      screen.getByRole('heading', { name: 'We received your request OPS-12' }),
    ).toBeInTheDocument();
    expect(screen.getByText('We sent a tracking link to a***@example.com.')).toBeInTheDocument();
    expect(screen.getByText(/We aim to reply by .*3:00\s?PM/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Submit another request' })).toHaveAttribute(
      'href',
      '/portal',
    );
    expect(document.body.innerHTML).not.toContain('#token=');
  });

  it('copies the request number with a button, and keeps the long advice behind a hint', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    saveSubmitted({
      ticketKey: 'OPS-12',
      maskedEmail: 'a***@example.com',
      status: 'received',
      expectedFirstResponseAt: null,
    });
    renderApp(<Confirmation />);
    await user.click(screen.getByRole('button', { name: 'Copy the request number' }));
    expect(writeText).toHaveBeenCalledWith('OPS-12');
    expect(screen.queryByText(/Check your spam folder/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More about your request' }));
    expect(await screen.findByText(/Check your spam folder/)).toBeVisible();
  });

  it('leaves out the target when no SLA applies', () => {
    saveSubmitted({
      ticketKey: 'OPS-13',
      maskedEmail: 'b***@example.com',
      status: 'received',
      expectedFirstResponseAt: null,
    });
    renderApp(<Confirmation />);
    expect(screen.queryByText(/We aim to reply by/)).not.toBeInTheDocument();
    expect(screen.getByText('We usually reply within business hours.')).toBeInTheDocument();
  });

  it('shows what happens next on the page, not behind a hint', () => {
    saveSubmitted({
      ticketKey: 'OPS-12',
      maskedEmail: 'a***@example.com',
      status: 'received',
      expectedFirstResponseAt: '2026-11-05T08:00:00.000Z',
    });
    renderApp(<Confirmation />);
    expect(screen.getByRole('heading', { name: 'What happens next' })).toBeVisible();
    expect(screen.getByText('We received your request.')).toBeVisible();
    expect(screen.getByText('A person reviews it.')).toBeVisible();
    expect(screen.getByText(/We reply by email\. You can add details/)).toBeVisible();
    expect(screen.getByText(/We aim to reply by/)).toBeVisible();
    expect(screen.queryByText('We usually reply within business hours.')).not.toBeInTheDocument();
  });

  it('says there is nothing to show when opened directly', () => {
    renderApp(<Confirmation />);
    expect(screen.getByText('There is no request to show here.')).toBeInTheDocument();
  });

  it('is available in Thai', () => {
    saveSubmitted({
      ticketKey: 'OPS-12',
      maskedEmail: 'a***@example.com',
      status: 'received',
      expectedFirstResponseAt: null,
    });
    renderApp(<Confirmation />, { locale: 'th' });
    expect(screen.getByRole('heading', { name: 'เราได้รับคำขอ OPS-12 แล้ว' })).toBeInTheDocument();
  });
});
