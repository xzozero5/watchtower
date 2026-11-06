/** Exact, bounded structured questions; free-form requests always go to the guarded LLM path. */
export function factsOnlyCall(
  text: string,
): { tool: string; input: Record<string, unknown> } | null {
  const question = text
    .trim()
    .replace(/[?？]$/, '')
    .toLowerCase();
  if (['my work', 'my tickets', 'งานของฉัน'].includes(question))
    return { tool: 'search_tickets', input: { assignee: 'me', limit: 5 } };
  if (['sla risks', 'what is at sla risk', 'อะไรเสี่ยง sla'].includes(question))
    return { tool: 'search_tickets', input: { slaState: ['at_risk', 'breached'], limit: 5 } };
  if (['team status', 'สถานะทีม', 'กะนี้มีใคร'].includes(question))
    return { tool: 'team_status', input: {} };
  if (["who's overloaded", 'team load', 'ใครงานล้น'].includes(question))
    return { tool: 'team_load', input: {} };
  if (['open incidents', 'incident ที่เปิดอยู่'].includes(question))
    return { tool: 'incident_search', input: { open: true, limit: 20 } };
  return null;
}

/** Only resolved, visible chips enter here. No selection can cause more than two internal reads. */
export function prefetchCalls(
  refs: readonly {
    kind: string;
    id: string;
    label: string;
    summaryTool?: 'handoff_get' | 'handoff_incoming_get';
  }[],
) {
  return refs
    .flatMap<{ tool: string; input: Record<string, unknown> }>((ref) => {
      switch (ref.kind) {
        case 'org':
          return [{ tool: 'org_get', input: { id: ref.id } }];
        case 'intent':
          return [{ tool: 'intent_get', input: { id: ref.id } }];
        case 'service':
          return [{ tool: 'service_get', input: { id: ref.id } }];
        case 'handoff':
          return [{ tool: ref.summaryTool ?? 'handoff_get', input: { id: ref.id } }];
        case 'ticket':
          return [{ tool: 'summarize_ticket', input: { ticket: ref.label } }];
        case 'incident':
          return [{ tool: 'incident_get', input: { incident: ref.id } }];
        case 'alert':
          return [{ tool: 'alert_get', input: { alert: ref.id } }];
        case 'conversation':
          return [{ tool: 'conversation_get', input: { id: ref.id } }];
        case 'kb_article':
          return [{ tool: 'kb_get', input: { id: ref.id } }];
        default:
          return [];
      }
    })
    .slice(0, 2);
}
