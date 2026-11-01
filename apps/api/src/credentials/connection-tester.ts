import { Injectable } from '@nestjs/common';
import {
  INTEGRATION_CATALOG,
  INTEGRATION_KEYS,
  integrationFields,
  isIntegrationComplete,
  type IntegrationDefinition,
  type IntegrationKey,
} from '@watchtower/shared';

/** The values a check runs with, by field name. Never log or return them. */
export type TesterConfig = Readonly<Record<string, string>>;

export interface TestOutcome {
  readonly ok: boolean;
  /** A non-secret identity (bot name, mailbox address). Null when the check has none to show. */
  readonly identity: string | null;
  /** Plain language. Must not contain any value from the config. */
  readonly message: string;
}

/**
 * The "test connection" hook of one adapter (T-116b onwards: T-102, T-103, T-104, T-105, T-106f).
 * `fake` always works offline and is what runs while the live flag is off, which is the default.
 * `live` is the adapter's real check; it is only reached when `CREDENTIAL_LIVE_TEST_ENABLED=true`
 * (an `[ASK-HUMAN]` decision: it needs real credentials and a network destination).
 */
export interface ConnectionTester {
  readonly integration: IntegrationKey;
  fake(config: TesterConfig): TestOutcome | Promise<TestOutcome>;
  live?(config: TesterConfig, signal: AbortSignal): Promise<TestOutcome>;
}

export interface FakeTesterOptions {
  /** At least one of these fields must be set, instead of every required field. */
  readonly anyOf?: readonly string[];
}

/**
 * The offline check: are the fields the integration needs present? No network, no clock, no
 * randomness. The identity is `mock:<integration>` so nobody mistakes it for a real service.
 */
export function createFakeTester(
  integration: IntegrationKey,
  options: FakeTesterOptions = {},
): ConnectionTester {
  const fields = integrationFields(integration);
  return {
    integration,
    fake(config) {
      const present = (name: string): boolean => (config[name] ?? '') !== '';
      const alternatives = (INTEGRATION_CATALOG[integration] as IntegrationDefinition).alternatives;
      if (alternatives !== undefined && options.anyOf === undefined) {
        // More than one way to connect: complete when every field of one way is set.
        if (isIntegrationComplete(integration, present)) {
          return {
            ok: true,
            identity: `mock:${integration}`,
            message:
              'Mock check passed: the required fields are set. Nothing was sent to the service.',
          };
        }
        const ways = Object.values(alternatives).map((set) =>
          set.map((name) => fields[name]?.label ?? name).join(' + '),
        );
        return {
          ok: false,
          identity: null,
          message: `Set every field of one way: ${ways.join(' or ')}.`,
        };
      }
      const missing =
        options.anyOf === undefined
          ? Object.entries(fields)
              .filter(([name, definition]) => definition.required && !present(name))
              .map(([, definition]) => definition.label)
          : options.anyOf.some(present)
            ? []
            : options.anyOf.map((name) => fields[name]?.label ?? name);
      if (missing.length > 0) {
        return {
          ok: false,
          identity: null,
          message:
            options.anyOf === undefined
              ? `Missing: ${missing.join(', ')}.`
              : `Set at least one of: ${missing.join(', ')}.`,
        };
      }
      return {
        ok: true,
        identity: `mock:${integration}`,
        message: 'Mock check passed: the required fields are set. Nothing was sent to the service.',
      };
    },
  };
}

/**
 * Where adapters plug their check in. Every integration of the catalog starts with the offline
 * fake; an adapter module replaces it from `onModuleInit` with `registry.register(tester)`.
 */
@Injectable()
export class ConnectionTesterRegistry {
  private readonly testers = new Map<IntegrationKey, ConnectionTester>();

  constructor() {
    for (const key of INTEGRATION_KEYS) {
      this.testers.set(
        key,
        createFakeTester(
          key,
          key === 'ai' ? { anyOf: ['anthropicApiKey', 'vertexProjectId'] } : {},
        ),
      );
    }
  }

  register(tester: ConnectionTester): void {
    this.testers.set(tester.integration, tester);
  }

  get(integration: IntegrationKey): ConnectionTester {
    const tester = this.testers.get(integration);
    if (tester === undefined) throw new Error(`no connection tester for ${integration}`);
    return tester;
  }
}
