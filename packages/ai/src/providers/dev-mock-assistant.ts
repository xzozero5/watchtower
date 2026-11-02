import type { LlmRequest } from '../contract.js';

/**
 * The offline stand-in for the assistant prompts (`assistant_plan`, `assistant_answer`) and for the
 * claim summaries (`claim_summary`). Like the rest of `DevMockLlmProvider` it is not a model: the
 * answer is a pure function of the redacted text it is given, built from keyword tables in English
 * and Thai, so the whole feature (tools, claims with evidence, proposals, `ai_run`) can be tested
 * and demonstrated with no key and no network. It follows the `language:` line of the context, so
 * a Thai screen gets Thai sentences from the facts the host wrote in Thai.
 */

const REF = /\b([A-Za-z][A-Za-z0-9]{1,9}-\d{1,15})\b/;

function between(text: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text);
  return match?.[1] ?? '';
}

function field(raw: string, name: string): string | undefined {
  return new RegExp(`^${name}: (.*)$`, 'm').exec(raw)?.[1]?.trim();
}

function firstSentence(text: string, max: number): string {
  const cut = text.split(/(?<=[.!?。])\s+/)[0] ?? text;
  return cut.length > max ? `${cut.slice(0, max - 3)}...` : cut;
}

const has = (text: string, pattern: RegExp): boolean => pattern.test(text);

interface PlannedCall {
  tool: string;
  input: Record<string, unknown>;
}

/** Step one: which tools. Only tools the system prompt lists are chosen, so a role never gets another's. */
export function assistantPlan(request: LlmRequest): string {
  const raw = request.messages[0]?.content ?? '';
  const available = new Set(
    [...request.system.matchAll(/^- ([a-z][a-z0-9_]*): /gm)].map((match) => match[1] ?? ''),
  );
  const text = between(raw, 'request');
  const lower = text.toLowerCase();
  const ticket = REF.exec(text)?.[1] ?? field(raw, 'ticket_in_view');
  const calls: PlannedCall[] = [];
  const add = (tool: string, input: Record<string, unknown>): void => {
    if (available.has(tool) && !calls.some((call) => call.tool === tool))
      calls.push({ tool, input });
  };

  if (has(lower, /overload|workload|busiest|heaviest|งานล้น|ใครงาน|ภาระงาน|งานเยอะ/)) {
    add('team_load', {});
  }
  if (has(lower, /on shift|who is (on|working)|team status|เข้ากะ|ใครอยู่เวร|สถานะทีม/)) {
    add('team_status', {});
  }
  if (has(lower, /\bsla\b|at risk|breach|เสี่ยง|เอสแอลเอ/)) {
    if (ticket !== undefined) add('explain_sla', { ticket });
    else add('search_tickets', { slaState: ['at_risk', 'breached'], limit: 5 });
  }
  if (has(lower, /\bkb\b|guide|runbook|how (do|to|can)|knowledge|คู่มือ|วิธี|บทความ/)) {
    add('kb_search', { query: text.slice(0, 200), limit: 4 });
  }
  if (has(lower, /investigat|\blogs?\b|trace|สืบสวน|ตรวจสอบ|ล็อก/) && ticket !== undefined) {
    add('investigate_run', { ticket });
  }
  if (has(lower, /summar|tl;?dr|recap|สรุป/)) {
    if (ticket !== undefined) add('summarize_ticket', { ticket });
    else add('search_tickets', { assignee: 'me', limit: 5 });
  }
  if (
    has(
      lower,
      /\bfind\b|search|similar|\bshow\b|\blist\b|ค้น|หา|คล้าย|แสดง|รายการ|my (next )?ticket|งานของฉัน|ถัดไป/,
    )
  ) {
    if (has(lower, /my (next )?ticket|งานของฉัน|ถัดไป/)) {
      add('search_tickets', { assignee: 'me', limit: 5 });
    } else {
      const query = text
        .replace(/\b(find|search|show|list|similar|tickets?|for|me|the|a)\b/gi, ' ')
        .trim();
      add(
        'search_tickets',
        query.length >= 3 ? { query: query.slice(0, 100), limit: 5 } : { limit: 5 },
      );
    }
  }
  // Asked about a ticket in view without a verb the table knows: read it.
  if (
    calls.length === 0 &&
    ticket !== undefined &&
    !has(lower, /assign|status|tag|note|draft|create|มอบหมาย|แท็ก|โน้ต|ร่าง/)
  ) {
    add('summarize_ticket', { ticket });
  }
  return JSON.stringify({ calls });
}

const STATUS_WORDS: readonly { pattern: RegExp; status: string }[] = [
  { pattern: /waiting on (the )?customer|รอลูกค้า/, status: 'waiting_on_customer' },
  { pattern: /waiting on (a )?dev|รอทีมพัฒนา|รอ dev/, status: 'waiting_on_dev' },
  { pattern: /\bre-?open\b|เปิดใหม่/, status: 'open' },
  { pattern: /\bresolve[d]?\b|แก้ไขแล้ว|แก้เสร็จ/, status: 'resolved' },
  { pattern: /\bclose[d]?\b|ปิดเรื่อง|ปิด ticket|ปิดเคส/, status: 'closed' },
];

function proposalsFor(raw: string, allowed: ReadonlySet<string>): unknown[] {
  const text = between(raw, 'request');
  const lower = text.toLowerCase();
  const ticket = REF.exec(text)?.[1] ?? field(raw, 'ticket_in_view');
  const out: unknown[] = [];

  if (allowed.has('assign') && ticket !== undefined) {
    if (has(lower, /\bunassign|ยกเลิกการมอบหมาย|ไม่มอบหมาย/)) {
      out.push({ kind: 'assign', ticket, assignee: null });
    } else {
      const who = /(?:assign|มอบหมาย|โอน)\b.*?(?:\bto\b|ให้)\s+(.+?)\s*[.!?]*$/i.exec(text)?.[1];
      if (who !== undefined) out.push({ kind: 'assign', ticket, assignee: who });
    }
  }
  if (allowed.has('status') && ticket !== undefined) {
    const hit = STATUS_WORDS.find((word) => word.pattern.test(lower));
    if (hit !== undefined) out.push({ kind: 'status', ticket, status: hit.status });
  }
  if (allowed.has('tag') && ticket !== undefined) {
    const remove =
      /remove tag\s+["']?([\w.-]+)/i.exec(text)?.[1] ?? /ลบแท็ก\s*([\w.-]+)/.exec(text)?.[1];
    const add =
      /\btag\b\s+(?:(?:this|it|ticket|with|as|[A-Za-z][A-Za-z0-9]{1,9}-\d+)\s+)*["']?([\w.-]+)/i.exec(
        text,
      )?.[1] ?? /แท็ก\s*([\w.-]+)/.exec(text)?.[1];
    if (remove !== undefined) out.push({ kind: 'tag', ticket, remove: [remove] });
    else if (add !== undefined && !/^(this|it|ticket|with|as)$/i.test(add)) {
      out.push({ kind: 'tag', ticket, add: [add] });
    }
  }
  if (allowed.has('note') && ticket !== undefined) {
    const body = /(?:\bnote|โน้ต)\s*[:：]\s*([\s\S]+)$/i.exec(text)?.[1]?.trim();
    if (body !== undefined && body !== '') out.push({ kind: 'note', ticket, body });
  }
  if (allowed.has('create_ticket')) {
    const english = /create (?:a )?ticket for (.+?)\s+(?:about|regarding|:)\s+(.+)$/i.exec(text);
    const thai = /เปิด ?ticket ให้\s*(.+?)\s+เรื่อง\s*(.+)$/.exec(text);
    const hit = english ?? thai;
    if (hit?.[1] !== undefined && hit[2] !== undefined) {
      out.push({
        kind: 'create_ticket',
        org: hit[1].trim(),
        subject: hit[2].trim().slice(0, 120),
        body: hit[2].trim(),
      });
    }
  }
  if (allowed.has('kb_draft')) {
    const title =
      /(?:draft|write) (?:a )?(?:kb|knowledge|article)(?: article)?\s*(?:about|on|:)\s*(.+)$/i.exec(
        text,
      )?.[1] ?? /เขียนบทความ(?:เรื่อง)?\s*(.+)$/.exec(text)?.[1];
    if (title !== undefined) {
      const clean = title.trim().slice(0, 100);
      out.push({
        kind: 'kb_draft',
        title: clean,
        bodyMd: `## ${clean}\n\nTODO: fill in the steps.`,
      });
    }
  }
  if (allowed.has('reply_draft') && ticket !== undefined) {
    if (has(lower, /(draft|write|prepare).{0,25}reply|ร่างคำตอบ|ร่างตอบ/)) {
      out.push({ kind: 'reply_draft', ticket });
    }
  }
  return out;
}

/** Step two: one claim per fact (up to the limit), citing it; proposals only for what was asked. */
export function assistantAnswer(request: LlmRequest): string {
  const raw = request.messages[0]?.content ?? '';
  const thai = field(raw, 'language') === 'th' || /Write in Thai/i.test(request.system);
  const limit = Number(/At most (\d+) claims/.exec(request.system)?.[1] ?? 5);
  const allowed = new Set(
    (/Allowed kinds in this conversation: ([a-z_, ]+)\./.exec(request.system)?.[1] ?? '')
      .split(',')
      .map((word) => word.trim())
      .filter((word) => word !== '' && word !== 'none'),
  );
  const facts = [...raw.matchAll(/^\[(e\d+)\] [a-z]+(?: \(mock data\))?: (.*)$/gm)].map(
    (match) => ({
      id: match[1] ?? '',
      text: (match[2] ?? '').replaceAll(/\s+/g, ' ').trim(),
    }),
  );
  const claims =
    facts.length > 0
      ? facts.slice(0, limit).map((fact) => ({
          text: firstSentence(fact.text, 200),
          evidenceIds: [fact.id],
        }))
      : [
          {
            text: has(between(raw, 'request').toLowerCase().trim(), /^(hi|hello|hey|สวัสดี)/)
              ? thai
                ? 'ถามเรื่อง ticket, SLA, ทีม หรือคู่มือได้เลย'
                : 'Ask me about tickets, SLA, the team or the knowledge base.'
              : thai
                ? 'ไม่พบข้อมูลที่เกี่ยวข้อง'
                : 'Nothing relevant was found.',
            evidenceIds: [] as string[],
          },
        ];
  return JSON.stringify({ claims, proposals: proposalsFor(raw, allowed) });
}

/** Claim summary: the first facts, one claim each, citing them. */
export function claimSummary(request: LlmRequest): string {
  const raw = request.messages[0]?.content ?? '';
  const limit = Number(/At most (\d+) claims/.exec(request.system)?.[1] ?? 5);
  const facts = [...raw.matchAll(/^\[(f\d+)\] [a-z]+(?: \(mock data\))?: (.*)$/gm)].map(
    (match) => ({
      id: match[1] ?? '',
      text: (match[2] ?? '').replaceAll(/\s+/g, ' ').trim(),
    }),
  );
  return JSON.stringify({
    claims: facts
      .slice(0, limit)
      .map((fact) => ({ text: firstSentence(fact.text, 200), factIds: [fact.id] })),
  });
}
