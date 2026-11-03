import { describe, expect, it } from 'vitest';

import { ProviderUnavailableError } from '../audited.js';
import { ProviderError } from '../providers/sdk.js';
import { failedFor } from './common.js';

describe('failedFor (ADR-019 offline classification)', () => {
  it('maps the bridge "offline" answer to provider_offline', () => {
    const error = new ProviderError('claude-cli', 'offline', 503, true);
    expect(failedFor(error)).toEqual({ status: 'failed', reason: 'provider_offline' });
  });

  it('keeps other provider errors and a missing setup apart from offline', () => {
    expect(failedFor(new ProviderError('claude-cli', 'busy', 429, true))).toEqual({
      status: 'failed',
      reason: 'provider_error',
    });
    expect(failedFor(new ProviderError('claude-cli', 'BridgeUnreachable', null, true))).toEqual({
      status: 'failed',
      reason: 'provider_error',
    });
    expect(failedFor(new ProviderUnavailableError('claude-cli: no token'))).toEqual({
      status: 'failed',
      reason: 'provider_unavailable',
    });
  });
});
