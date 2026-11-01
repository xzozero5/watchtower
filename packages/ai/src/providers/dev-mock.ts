import { hashLlmInput } from '../hash.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../contract.js';
import { MockLlmProvider, type MockRule } from './mock.js';

/**
 * The mock provider of `AI_PROVIDER=mock` for dev and e2e: it answers the real prompts
 * (`classifier`, `summarizer`) with plausible Thai or English JSON, so the whole pipeline (agents,
 * `ai_run`, `ai_ticket_insight`, the AI brief in the web) can be exercised with no key and no
 * network. It is not a model: the answer is a pure function of the prompt id and the redacted
 * input (the same input hash always gives the same answer), built from a small keyword table. Every
 * `ai_run` it produces says `provider: mock` and a model id that starts with `mock`.
 *
 * Exact answers for given inputs can be pinned with `rules` (same shape as `MockLlmProvider`).
 */

export interface DevMockOptions {
  readonly rules?: readonly MockRule[];
}

const THAI = /[฀-๿]/;

/** Keyword groups: words a customer might use (English and Thai) and the intent words they point at. */
const TOPICS: readonly {
  readonly words: readonly string[];
  readonly intentWords: readonly string[];
  readonly escalate: boolean;
}[] = [
  {
    words: [
      'password',
      'login',
      'log in',
      'sign in',
      'locked',
      'รหัสผ่าน',
      'เข้าสู่ระบบ',
      'ล็อกอิน',
      'ล็อก',
    ],
    intentWords: ['access', 'password', 'login', 'account', 'auth'],
    escalate: false,
  },
  {
    words: ['invoice', 'bill', 'payment', 'refund', 'ใบแจ้งหนี้', 'ชำระ', 'เงิน', 'คืนเงิน'],
    intentWords: ['billing', 'invoice', 'payment', 'finance'],
    escalate: false,
  },
  {
    words: [
      'error',
      'bug',
      'crash',
      'outage',
      'down',
      'timeout',
      'ขัดข้อง',
      'ล่ม',
      'ใช้งานไม่ได้',
      'ผิดพลาด',
      'ช้า',
    ],
    intentWords: ['incident', 'outage', 'bug', 'error', 'broken', 'down'],
    escalate: true,
  },
  {
    words: ['report', 'export', 'data', 'รายงาน', 'ข้อมูล'],
    intentWords: ['report', 'data', 'export'],
    escalate: false,
  },
  {
    words: ['request', 'access', 'permission', 'ขอ', 'สิทธิ์'],
    intentWords: ['request', 'permission', 'access'],
    escalate: false,
  },
];

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** A number in 0..1 taken from the input hash, so variety is deterministic. */
function unit(hash: string, offset: number): number {
  return parseInt(hash.slice(offset * 2, offset * 2 + 2), 16) / 255;
}

function between(hash: string, offset: number, low: number, high: number): number {
  return Math.round((low + unit(hash, offset) * (high - low)) * 100) / 100;
}

function intentsOf(system: string): { key: string; name: string }[] {
  const found: { key: string; name: string }[] = [];
  for (const line of system.split('\n')) {
    const match = /^\* ([a-z][a-z0-9_.-]*): (.*)$/.exec(line);
    if (match?.[1] !== undefined) found.push({ key: match[1], name: match[2] ?? '' });
  }
  return found;
}

function classify(request: LlmRequest, hash: string): string {
  const text = (request.messages[0]?.content ?? '').toLowerCase();
  const thai = THAI.test(text);
  const intents = intentsOf(request.system);

  let best: { key: string; hits: string[]; score: number } | undefined;
  for (const intent of intents) {
    const haystack = `${intent.key} ${intent.name}`.toLowerCase();
    const hits: string[] = [];
    for (const topic of TOPICS) {
      if (!topic.intentWords.some((word) => haystack.includes(word))) continue;
      hits.push(...topic.words.filter((word) => text.includes(word)));
    }
    // The intent's own words count too.
    for (const word of haystack.split(/[^a-z0-9฀-๿]+/)) {
      if (word.length >= 4 && text.includes(word)) hits.push(word);
    }
    if (hits.length > 0 && (best === undefined || hits.length > best.score)) {
      best = { key: intent.key, hits: [...new Set(hits)], score: hits.length };
    }
  }

  const noise = /unsubscribe|newsletter|promotion|โปรโมชัน/.test(text);
  const reply = /^subject:\s*(re|ตอบกลับ)\s*:/m.test(text);
  const type = noise ? 'noise' : reply ? 'reply_to_existing' : 'new_customer_issue';

  if (best === undefined) {
    return JSON.stringify({
      type,
      intentKey: null,
      confidence: between(hash, 0, 0.2, 0.45),
      reason: thai ? 'ไม่พบคำที่ตรงกับหัวข้อใดชัดเจน' : 'No clear match with any listed intent.',
    });
  }
  const shown = best.hits.slice(0, 2).join(', ');
  return JSON.stringify({
    type,
    intentKey: best.key,
    confidence: between(hash, 1, 0.62, 0.93),
    reason: thai
      ? `ข้อความมีคำว่า ${shown} ซึ่งตรงกับหัวข้อนี้`
      : `Mentions "${shown}", which matches this intent.`,
  });
}

function summarize(request: LlmRequest, hash: string): string {
  const raw = request.messages[0]?.content ?? '';
  const lower = raw.toLowerCase();
  const thai = THAI.test(raw);
  const turns = [...raw.matchAll(/^\[(customer|staff|note)\] (.*)$/gm)];
  const first = turns.find((turn) => turn[1] === 'customer')?.[2] ?? '';
  const last = turns.at(-1);
  const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '';
  const line = (first || subject).replaceAll(/\s+/g, ' ').trim();
  const summary =
    line.length > 110 ? `${line.slice(0, 107)}...` : line || (thai ? 'ไม่มีเนื้อหา' : 'No content');

  const escalate = TOPICS.filter((topic) => topic.escalate).some((topic) =>
    topic.words.some((word) => lower.includes(word)),
  );
  const done = /thank|resolved|solved|ขอบคุณ|เรียบร้อย|แก้ไขแล้ว/.test(
    last?.[2]?.toLowerCase() ?? '',
  );
  const waiting = last?.[1] === 'staff';

  let nextStep: { kind: string; label: string };
  if (waiting) {
    nextStep = { kind: 'wait_customer', label: thai ? 'รอลูกค้าตอบกลับ' : 'Wait for the customer' };
  } else if (done) {
    nextStep = { kind: 'resolve', label: thai ? 'ปิดเรื่องนี้' : 'Resolve the ticket' };
  } else if (escalate && unit(hash, 2) > 0.25) {
    nextStep = {
      kind: 'escalate_dev',
      label: thai ? 'ส่งต่อให้ทีมพัฒนาตรวจสอบ' : 'Ask an engineer to look',
    };
  } else {
    nextStep = { kind: 'reply', label: thai ? 'ตอบลูกค้า' : 'Reply to the customer' };
  }
  return JSON.stringify({ summary, nextStep });
}

export class DevMockLlmProvider implements LlmProvider {
  readonly kind = 'mock';
  private readonly pinned: MockLlmProvider;

  constructor(options: DevMockOptions = {}) {
    // `strict` makes the pinned provider throw when no rule matches, which is how we know to fall through.
    this.pinned = new MockLlmProvider({ rules: options.rules ?? [], strict: true });
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    try {
      return await this.pinned.generate(request);
    } catch {
      // No rule for this prompt and input: answer from the keyword table.
    }
    const hash = hashLlmInput(request);
    let text: string;
    switch (request.prompt.id) {
      case 'classifier':
        text = classify(request, hash);
        break;
      case 'summarizer':
        text = summarize(request, hash);
        break;
      default:
        text = `[mock:${request.prompt.id}:${hash.slice(0, 8)}]`;
    }
    const input = request.system + request.messages.map((message) => message.content).join('');
    return {
      text,
      finishReason: 'stop',
      usage: { inputTokens: approxTokens(input), outputTokens: approxTokens(text) },
      model: request.model,
    };
  }
}
