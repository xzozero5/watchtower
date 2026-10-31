/** Channel types from the data model (PRD section 7, channel_account.type). */
export const CHANNEL_TYPES = ['gmail', 'line', 'portal', 'discord', 'webhook'] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type IntegrationMode = 'mock' | 'live';

/**
 * An integration runs live only when every credential it needs is present. Empty or partial
 * configuration falls back to mock, so a local run can never reach a real service by accident.
 */
export function resolveIntegrationMode(
  credentials: readonly (string | undefined)[],
): IntegrationMode {
  if (credentials.length === 0) return 'mock';
  const complete = credentials.every((value) => value !== undefined && value.trim() !== '');
  return complete ? 'live' : 'mock';
}
