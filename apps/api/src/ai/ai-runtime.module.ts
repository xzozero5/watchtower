import { Module } from '@nestjs/common';
import type { AiCredentialReader, LlmProvider } from '@watchtower/ai';
import type { CredentialStore, Database } from '@watchtower/db';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { AI_RUNTIME, API_LLM, createApiAiRuntime } from './ai-runtime.js';
import { AiSummaries } from './ai-summaries.service.js';
import { StaffNames } from './staff-names.service.js';

/** The `ai` integration of the credential store: the environment first, then the database (ADR-012). */
function storeCredentials(store: CredentialStore): AiCredentialReader {
  return {
    read: async () => {
      const fields = await store.resolve('ai');
      const text = (name: string): string | undefined => {
        const value = fields[name]?.value.trim();
        return value === undefined || value === '' ? undefined : value;
      };
      return {
        anthropicApiKey: text('anthropicApiKey'),
        vertexProjectId: text('vertexProjectId'),
        vertexLocation: text('vertexLocation'),
      };
    },
  };
}

/**
 * The AI layer of the api (ADR-023): one audited, guarded, redacting runtime shared by the assistant
 * and by the AI summaries of the daily brief and the handoff. `API_LLM` is an override point only
 * (tests replace it to count or fail model calls); null means "build the provider `AI_PROVIDER` selects".
 */
@Module({
  imports: [CredentialsModule],
  providers: [
    { provide: API_LLM, useValue: null },
    {
      provide: AI_RUNTIME,
      inject: [APP_CONFIG, DATABASE, LOGGER, API_LLM, CREDENTIAL_STORE],
      useFactory: (
        config: ApiConfig,
        database: Database,
        logger: AppLogger,
        llm: LlmProvider | null,
        store: CredentialStore,
      ) =>
        createApiAiRuntime({ config, database, logger, llm, credentials: storeCredentials(store) }),
    },
    StaffNames,
    AiSummaries,
  ],
  exports: [AI_RUNTIME, API_LLM, AiSummaries, StaffNames],
})
export class AiRuntimeModule {}
