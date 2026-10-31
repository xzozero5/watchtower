import type { z } from 'zod';

import type {
  ScopedTools,
  ToolAllowRule,
  ToolCallRecord,
  ToolDefinition,
  ToolRegistry,
  ToolScope,
  ToolSummary,
} from './contract.js';
import { hashJson } from './hash.js';

export class ToolRegistryError extends Error {
  override readonly name: string = 'ToolRegistryError';
}
/** The tool is not on the allow-list for this agent, intent and stage (or does not exist). */
export class ToolNotAllowedError extends ToolRegistryError {
  override readonly name = 'ToolNotAllowedError';
}
export class ToolInputError extends ToolRegistryError {
  override readonly name = 'ToolInputError';
}
export class ToolOutputError extends ToolRegistryError {
  override readonly name = 'ToolOutputError';
}
/** The run used its call budget (N2: rate budget). */
export class ToolBudgetError extends ToolRegistryError {
  override readonly name = 'ToolBudgetError';
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,62}$/;
export const DEFAULT_MAX_TOOL_CALLS = 20;

/** Identity function that infers the schema types of a tool. */
export function defineTool<Input extends z.ZodType, Output extends z.ZodType>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function ruleAllows(rule: ToolAllowRule, scope: ToolScope): boolean {
  if (rule.agent !== '*' && rule.agent !== scope.agent) return false;
  if (rule.intent !== '*' && rule.intent !== scope.intent) return false;
  return rule.stages === undefined || rule.stages.includes(scope.stage);
}

/**
 * Registry with a deny-by-default allow-list. A tool is visible to the model, and callable, only
 * when a rule grants it to this agent, intent and stage. Inputs and outputs are validated with
 * the tool's Zod schemas on every call.
 */
export function createToolRegistry(allowList: readonly ToolAllowRule[]): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool) {
      if (!TOOL_NAME.test(tool.name)) {
        throw new ToolRegistryError(`Invalid tool name: ${tool.name}`);
      }
      // The type already says `readOnly: true`; this guards callers that bypass the types (N2).
      if ((tool as { readOnly?: unknown }).readOnly !== true) {
        throw new ToolRegistryError(`Tool ${tool.name} must be read-only (N2)`);
      }
      if (tools.has(tool.name))
        throw new ToolRegistryError(`Tool already registered: ${tool.name}`);
      tools.set(tool.name, tool);
    },

    scope(scope, options = {}): ScopedTools {
      const granted = new Set<string>();
      for (const rule of allowList) {
        if (!ruleAllows(rule, scope)) continue;
        for (const name of rule.tools) if (tools.has(name)) granted.add(name);
      }
      const maxCalls = options.maxCalls ?? DEFAULT_MAX_TOOL_CALLS;
      const records: ToolCallRecord[] = [];

      return {
        list(): ToolSummary[] {
          return [...granted].sort().map((name) => {
            const tool = tools.get(name);
            return { name, description: tool?.description ?? '' };
          });
        },

        async call(name, rawInput) {
          const started = Date.now();
          const record = (ok: boolean, errorCode: string | null): void => {
            records.push({
              name,
              inputHash: hashJson(rawInput),
              ok,
              latencyMs: Date.now() - started,
              errorCode,
            });
          };
          const fail = (error: ToolRegistryError): never => {
            record(false, error.name);
            throw error;
          };

          const tool = tools.get(name);
          if (tool === undefined || !granted.has(name)) {
            return fail(new ToolNotAllowedError(`Tool not allowed here: ${name}`));
          }
          if (records.length >= maxCalls) {
            return fail(new ToolBudgetError(`Tool call budget of ${String(maxCalls)} used`));
          }
          const input = tool.input.safeParse(rawInput);
          if (!input.success) return fail(new ToolInputError(`Invalid input for ${name}`));

          let result: unknown;
          try {
            result = await tool.execute(input.data, { ...scope, abortSignal: options.abortSignal });
          } catch (error) {
            record(false, error instanceof Error ? error.name : 'UnknownError');
            throw error;
          }
          const output = tool.output.safeParse(result);
          if (!output.success) return fail(new ToolOutputError(`Invalid output from ${name}`));

          record(true, null);
          return output.data;
        },

        calls() {
          return records;
        },
      };
    },
  };
}
