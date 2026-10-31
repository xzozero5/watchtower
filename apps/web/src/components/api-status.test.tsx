import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';

import { ApiStatus } from './api-status';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiStatus', () => {
  it('shows a checking state first, then online when /health answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderApp(<ApiStatus />, { apiUrl: 'http://api.test:4000' });

    expect(screen.getByText('Checking API')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveAttribute('data-state', 'success');
    });
    expect(screen.getByText('API online')).toBeVisible();
    // The URL comes from the runtime config, not from a build-time constant.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test:4000/health');
  });

  it('says so, in words, when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderApp(<ApiStatus />);
    expect(await screen.findByText('API unreachable')).toBeVisible();
    expect(screen.getByTestId('api-status')).toHaveAttribute('data-state', 'error');
  });

  it('treats an error response as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 503 })));
    renderApp(<ApiStatus />);
    expect(await screen.findByText('API unreachable')).toBeVisible();
  });

  it('uses Thai when the app language is Thai', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    renderApp(<ApiStatus />, { locale: 'th' });
    expect(await screen.findByText('API ทำงานปกติ')).toBeVisible();
  });
});
