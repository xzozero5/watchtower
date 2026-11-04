import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiOfflineBanner } from '@/components/ai-offline-banner';
import { ApiProvider } from '@/lib/api/api-context';
import { makeSession } from '@/test/fixtures';
import { mockApi, type MockHandler } from '@/test/mock-api';
import { renderApp } from '@/test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(status: MockHandler, locale: 'en' | 'th' = 'en') {
  const api = mockApi({
    'GET /v1/auth/session': { json: makeSession('agent') },
    'GET /v1/ai/status': status,
  });
  renderApp(
    <ApiProvider baseUrl="http://api.test">
      <AiOfflineBanner />
    </ApiProvider>,
    { locale },
  );
  return api;
}

describe('AiOfflineBanner (T-170)', () => {
  it('says the AI is offline and that work waits', async () => {
    const api = setup({ json: { status: 'offline', checkedAt: null } });
    const banner = await screen.findByTestId('ai-offline-banner');
    expect(banner).toHaveTextContent('AI is offline');
    expect(banner).toHaveTextContent('run again by itself');
    expect(api.callsTo('/v1/ai/status').length).toBeGreaterThanOrEqual(1);
  });

  it('speaks Thai', async () => {
    setup({ json: { status: 'offline', checkedAt: null } }, 'th');
    expect(await screen.findByText('AI ออฟไลน์อยู่')).toBeInTheDocument();
  });

  it.each(['online', 'disabled'] as const)('shows nothing while %s', async (status) => {
    const api = setup({ json: { status, checkedAt: null } });
    await waitFor(() => {
      expect(api.callsTo('/v1/ai/status').length).toBeGreaterThanOrEqual(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('ai-offline-banner')).toBeNull();
  });

  it('shows nothing when the status is unknown (the api answers an error)', async () => {
    const api = setup({ status: 500, json: { error: 'x' } });
    await waitFor(() => {
      expect(api.callsTo('/v1/ai/status').length).toBeGreaterThanOrEqual(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('ai-offline-banner')).toBeNull();
  });
});
