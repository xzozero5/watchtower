import { autonomyStatusTool } from './autonomy-status.tool.js';
import { ceoMetricsTool } from './ceo-metrics.tool.js';
import { configLookupTool } from './config-lookup.tool.js';
import { conversationGetTool, conversationSearchTool } from './conversation.tools.js';
import type { ModuleToolContext, ToolRegistrar } from './fact-kit.js';
import { kbGetTool } from './kb-get.tool.js';
import { opsMetricsTool } from './ops-metrics.tool.js';
import { performanceViewTool } from './performance-view.tool.js';
import { ticketTimelineTool } from './ticket-timeline.tool.js';

/**
 * The module read tools of T-404 (reports) and T-405 (conversations, KB, timeline, autonomy, config). Each registrar
 * calls `add` once, and `add` registers it only when `toolsFor(principal)` lists the name (deny by default).
 */
export function readModuleTools(ctx: ModuleToolContext): ToolRegistrar[] {
  return [
    opsMetricsTool(ctx),
    ceoMetricsTool(ctx),
    performanceViewTool(ctx),
    conversationSearchTool(ctx),
    conversationGetTool(ctx),
    kbGetTool(ctx),
    ticketTimelineTool(ctx),
    autonomyStatusTool(ctx),
    configLookupTool(ctx),
  ];
}
