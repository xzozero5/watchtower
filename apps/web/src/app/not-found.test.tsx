import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeSession } from '@/test/fixtures';
import { apiError, mockApi } from '@/test/mock-api';
import { renderApp } from '@/test-utils';

import NotFoundPage from './not-found';

vi.mock('next/image', () => ({
  default: () => null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('not found page', () => {
  it('sends a signed-in staff member back to the queue', async () => {
    mockApi({ 'GET /v1/auth/session': { json: makeSession('agent') } });
    renderApp(<NotFoundPage />);
    const link = await screen.findByRole('link', { name: 'Back to the queue' });
    expect(link).toHaveAttribute('href', '/');
  });

  it('sends a visitor with no staff session to the help portal', async () => {
    mockApi({ 'GET /v1/auth/session': apiError(401, 'unauthenticated', 'Sign in') });
    renderApp(<NotFoundPage />);
    const link = await screen.findByRole('link', { name: 'Go to the help portal' });
    expect(link).toHaveAttribute('href', '/portal');
    expect(screen.queryByRole('link', { name: 'Back to the queue' })).not.toBeInTheDocument();
  });
});
