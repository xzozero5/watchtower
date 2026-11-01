import { line } from '@watchtower/channels';

import type { ApiConfig } from '../config/config.js';

/** DI token of the LINE Login provider. Tests replace it with a `FakeLineLoginProvider` they control. */
export const LINE_LOGIN_PROVIDER = Symbol('LINE_LOGIN_PROVIDER');

/**
 * The provider this instance uses, or null when LINE Login is not available:
 *  - `LINE_LOGIN_FAKE_ENABLED=true` (an explicit opt-in that the config guard refuses in production,
 *    with LINE Login credentials set, or off a loopback APP_URL): a fake that approves at once as a
 *    synthetic LINE user. Nothing leaves the machine.
 *  - anything else: null. A live provider (LINE's authorization endpoint and token verification)
 *    is not implemented; it needs a LINE Login channel and an approved network destination
 *    (`[ASK-HUMAN]`, PRD section 11), so the routes answer 503 instead of pretending.
 */
export function lineLoginProviderFor(
  config: Pick<ApiConfig, 'NODE_ENV' | 'LINE_LOGIN_FAKE_ENABLED'>,
): line.LineLoginProvider | null {
  // NODE_ENV is checked again here although the guard already refuses the combination at boot.
  return config.LINE_LOGIN_FAKE_ENABLED && config.NODE_ENV !== 'production'
    ? new line.FakeLineLoginProvider({
        autoConsent: {
          userId: 'Umock00000000000000000000000000001',
          displayName: 'Mock LINE user',
        },
      })
    : null;
}
