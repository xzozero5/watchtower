import { Module } from '@nestjs/common';
import { DevMockLlmProvider, type LlmProvider } from '@watchtower/ai';
import type { Database } from '@watchtower/db';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { AI_RUNTIME, API_LLM, createApiAiRuntime } from './ai-runtime.js';
import { AiSummaries } from './ai-summaries.service.js';

/**
 * The AI layer of the api (ADR-017): one audited, guarded, redacting runtime shared by the assistant
 * and by the AI summaries of the daily brief and the handoff. Tests replace `API_LLM` to count or fail
 * model calls.
 */
@Module({
  providers: [
    {
      provide: API_LLM,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): LlmProvider | null =>
        config.AI_PROVIDER === 'mock' ? new DevMockLlmProvider() : null,
    },
    {
      provide: AI_RUNTIME,
      inject: [APP_CONFIG, DATABASE, LOGGER, API_LLM],
      useFactory: (
        config: ApiConfig,
        database: Database,
        logger: AppLogger,
        llm: LlmProvider | null,
      ) => createApiAiRuntime({ config, database, logger, llm }),
    },
    AiSummaries,
  ],
  exports: [AI_RUNTIME, API_LLM, AiSummaries],
})
export class AiRuntimeModule {}
