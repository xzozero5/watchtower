import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeProvider } from '@/lib/realtime/realtime-provider';
import { socketFactory } from '@/test/fake-socket';
import { renderApp } from '@/test-utils';

import { RailStatus } from './rail-status';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderStatus(expanded = true) {
  const sockets = socketFactory();
  const view = renderApp(
    <RealtimeProvider createSocket={sockets.create}>
      <RailStatus expanded={expanded} part="rows" />
      <RailStatus expanded={expanded} part="dot" />
    </RealtimeProvider>,
    { apiUrl: 'http://api.test:4000' },
  );
  return { ...view, sockets };
}

describe('RailStatus', () => {
  it('shows one quiet dot with a combined name when all is well, and no visible rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const view = renderStatus();
    await waitFor(() => {
      expect(view.sockets.sockets).toHaveLength(1);
    });
    await act(async () => {
      view.sockets.last.ready();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveAttribute('data-state', 'success');
    });
    await waitFor(() => {
      expect(screen.getByTestId('rail-status-dot')).toHaveAccessibleName(
        'Connected: live updates on, API online',
      );
    });
    // The words are still there for assistive technology and for the checks that read them.
    expect(screen.getByTestId('api-status').className).toContain('sr-only');
    expect(screen.getByTestId('live-status')).toBeInTheDocument();
  });

  it('shows a visible row with words, and no dot, when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderStatus();
    expect(await screen.findByText('API unreachable')).toBeVisible();
    expect(screen.getByTestId('api-status').className).not.toContain('sr-only');
    expect(screen.queryByTestId('rail-status-dot')).toBeNull();
  });
});
