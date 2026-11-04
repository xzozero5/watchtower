import { Inject, Injectable } from '@nestjs/common';
import {
  CONFIGURABLE_AGENTS,
  UNCONFIGURED_MODEL,
  type AiSettingsConfig,
  buildAiSettings,
  resolveModel,
} from '@watchtower/ai';
import type { AiModelMapping } from '@watchtower/shared';

import { APP_CONFIG } from '../config/config.js';

/**
 * Which model each AI agent uses (T-301c), read from the same environment the runtime reads
 * (`buildAiSettings`), so the card cannot disagree with what the worker and the api call. Read-only:
 * the mapping is changed in the environment, not here. Holds no secret: model ids are settings.
 */
@Injectable()
export class AiModelsService {
  constructor(@Inject(APP_CONFIG) private readonly config: AiSettingsConfig) {}

  read(): AiModelMapping {
    const { settings } = buildAiSettings(this.config);
    const agents = CONFIGURABLE_AGENTS.map((agent) => {
      const resolved = resolveModel(settings, agent);
      const source =
        settings.agentModels[agent] !== undefined
          ? ('alias' as const)
          : settings.agentTiers[agent] !== undefined
            ? ('tier' as const)
            : ('default' as const);
      const configured = resolved.model !== UNCONFIGURED_MODEL;
      return {
        agent,
        tier: resolved.tier,
        model: configured ? resolved.model : null,
        source,
        priced: configured && Object.hasOwn(settings.prices, resolved.model),
      };
    });
    const model = (name: string) => agents.find((row) => row.agent === name)?.model ?? null;
    const grader = model('grader');
    return {
      provider: this.config.AI_PROVIDER,
      agents,
      graderIndependent: grader !== null && grader !== model('drafter'),
    };
  }
}
