import { hashLlmInput } from '../hash.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../contract.js';
import { assistantAnswer, assistantPlan, claimSummary } from './dev-mock-assistant.js';
import { MockLlmProvider, type MockRule } from './mock.js';

/**
 * The mock provider of `AI_PROVIDER=mock` for dev and e2e: it answers the real prompts
 * (`classifier`, `summarizer`, `investigator`, `drafter`, `kb_author`) with plausible Thai or English JSON, so the whole pipeline (agents,
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

const PLACEHOLDER = /\[[A-Z][A-Z_]*_\d+\]/g;

interface MockEvidence {
  readonly id: string;
  readonly kind: string;
  readonly flags: string;
  readonly text: string;
}

function evidenceOf(raw: string): MockEvidence[] {
  return [...raw.matchAll(/^\[(ev-\d+)\] ([a-z]+)(?: \(([^)]*)\))?: (.*)$/gm)].map((match) => ({
    id: match[1] ?? '',
    kind: match[2] ?? '',
    flags: match[3] ?? '',
    text: (match[4] ?? '').replaceAll(/\s+/g, ' ').trim(),
  }));
}

function firstSentence(text: string, max: number): string {
  const cut = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return cut.length > max ? `${cut.slice(0, max - 3)}...` : cut;
}

/** Investigator: one finding per evidence card (up to four), citing it; the next step follows the kinds found. */
function investigate(request: LlmRequest, hash: string): string {
  const raw = request.messages[0]?.content ?? '';
  const thai = THAI.test(raw.split('<evidence>')[0] ?? '');
  const cards = evidenceOf(raw);
  const findings = cards.slice(0, 4).map((card) => ({
    text: firstSentence(
      `${card.flags.includes('mock') ? (thai ? 'ข้อมูลตัวอย่าง: ' : 'Example data: ') : ''}${card.text}`,
      200,
    ),
    evidenceIds: [card.id],
  }));
  const runbook = cards.find((card) => card.kind === 'kb');
  const system = cards.some((card) => card.kind === 'log' || card.kind === 'repo');
  const nextStep = system
    ? { kind: 'escalate_dev', label: thai ? 'ส่งต่อให้ทีมพัฒนาตรวจสอบ' : 'Ask an engineer to look' }
    : runbook !== undefined
      ? { kind: 'reply', label: thai ? 'ตอบลูกค้าตามคู่มือ' : 'Reply from the guide' }
      : { kind: 'other', label: thai ? 'อ่านเรื่องนี้' : 'Read the ticket' };
  return JSON.stringify({
    findings,
    likelyCause: null,
    confidence: cards.length === 0 ? 0 : between(hash, 4, 0.35, 0.8),
    openQuestions: [thai ? 'ยังไม่ทราบสาเหตุที่แน่ชัด' : 'The cause is not confirmed yet.'],
    nextStep,
    suggestedPriority: system
      ? {
          priority: 'P2',
          reason: thai ? 'พบ error ใน log ที่เกี่ยวข้อง' : 'Errors found in the related logs',
          confidence: 0.6,
        }
      : null,
  });
}

/** Drafter: a greeting, one fact per usable evidence card (cited), and a closing. */
function draft(request: LlmRequest, hash: string): string {
  const raw = request.messages[0]?.content ?? '';
  const thai = /write in thai/i.test(request.system);
  const restricted = /disclosure level: restricted/i.test(request.system);
  const usable = evidenceOf(raw).filter(
    (card) => !restricted || card.flags.includes('customer-safe'),
  );
  const sentences: { text: string; kind: string; evidenceIds: string[]; newParagraph: boolean }[] =
    [
      {
        text: thai
          ? 'สวัสดีครับ ขอบคุณที่แจ้งเรื่องให้เราทราบ'
          : 'Hello, thank you for contacting us.',
        kind: 'courtesy',
        evidenceIds: [],
        newParagraph: false,
      },
    ];
  for (const card of usable.slice(0, 2)) {
    sentences.push({
      text: firstSentence(card.text.replaceAll(PLACEHOLDER, thai ? 'ลูกค้า' : 'you'), 240),
      kind: 'fact',
      evidenceIds: [card.id],
      newParagraph: sentences.length === 1,
    });
  }
  // About one draft in five makes a claim with no evidence, which the reviewer sees marked as uncited.
  if (usable.length > 0 && unit(hash, 5) > 0.8) {
    sentences.push({
      text: thai ? 'เราคาดว่าจะแก้ไขได้ภายในวันนี้' : 'We expect this to be fixed today.',
      kind: 'fact',
      evidenceIds: [],
      newParagraph: false,
    });
  }
  sentences.push({
    text: thai
      ? 'หากมีข้อสงสัยเพิ่มเติม ตอบกลับข้อความนี้ได้เลยครับ'
      : 'If you have any questions, just reply to this message.',
    kind: 'courtesy',
    evidenceIds: [],
    newParagraph: true,
  });
  return JSON.stringify({ language: thai ? 'th' : 'en', sentences });
}

/** KB author: title from the subject, body from what staff wrote last; placeholders are left out. */
/**
 * The offline stand-in for the procedure compiler: a fixed, harmless example (two read-only tools and a
 * reply guideline). It does not read the text, and says so (N5), so nobody mistakes it for a compile.
 */
function compileProcedureExample(): string {
  return JSON.stringify({
    steps: {
      schemaVersion: 1,
      autosend: 'never',
      steps: [
        { kind: 'tool', id: 'kb', tool: 'kb_search' },
        { kind: 'tool', id: 'similar', tool: 'similar_tickets' },
        {
          kind: 'reply_guideline',
          id: 'tone',
          text: 'State what was checked and what is still unknown.',
          lang: 'en',
        },
      ],
    },
    assumptions: ['The offline mock provider wrote a fixed example; it did not read the text.'],
  });
}

function authorArticle(request: LlmRequest): string {
  const raw = request.messages[0]?.content ?? '';
  const thai = THAI.test(raw);
  const clean = (text: string): string =>
    text.replaceAll(PLACEHOLDER, thai ? 'ลูกค้า' : 'the customer');
  const subject = clean(/^Subject: (.*)$/m.exec(raw)?.[1] ?? '').trim();
  const turns = [...raw.matchAll(/^\[(customer|staff|note)\] (.*)$/gm)];
  const answer = turns.filter((turn) => turn[1] === 'staff').at(-1)?.[2];
  if (subject === '' || answer === undefined) {
    return JSON.stringify({ title: '', bodyMd: '', intentTags: [], kind: 'article' });
  }
  const ask = clean(turns.find((turn) => turn[1] === 'customer')?.[2] ?? subject);
  const heads = thai
    ? ['อาการ', 'สาเหตุ', 'วิธีแก้ไข', 'เมื่อไรควรส่งต่อ']
    : ['Symptoms', 'Cause', 'Resolution', 'When to escalate'];
  const section = (head: string | undefined, text: string): string => `## ${head ?? ''}\n\n${text}`;
  const bodyMd = [
    section(heads[0], firstSentence(ask, 300)),
    section(heads[1], thai ? 'ยังไม่ยืนยัน' : 'Not confirmed'),
    section(heads[2], `1. ${firstSentence(clean(answer), 400)}`),
    section(
      heads[3],
      thai ? 'หากยังไม่หาย ส่งต่อให้ทีมพัฒนา' : 'If it persists, ask an engineer to look.',
    ),
  ].join('\n\n');
  return JSON.stringify({ title: subject.slice(0, 100), bodyMd, intentTags: [], kind: 'article' });
}

/**
 * Grader: the class follows the facts (a survey that says resolved is `verified`, a staff reply with no
 * confirmation is `contained`, no reply is `assumed`); the draft is compared with the reply by the share
 * of words they have in common. Not a judgement of quality: a stand-in so the pipeline can be exercised.
 */
function gradeResolution(request: LlmRequest): string {
  const raw = request.messages[0]?.content ?? '';
  const thai = /Write in Thai/.test(request.system);
  const facts = [...raw.matchAll(/^\[f(\d+)\] (\w+): (.*)$/gm)].map((match) => ({
    id: `f${match[1] ?? ''}`,
    role: match[2] ?? '',
    text: match[3] ?? '',
  }));
  const find = (role: string) => facts.find((fact) => fact.role === role);
  const reply = facts.find((fact) => fact.role === 'staff_reply');
  const draftFact = find('ai_draft');
  const csat = find('csat');
  const kb = find('kb');
  let resolutionClass = 'contained';
  const cites: string[] = [];
  if (reply === undefined) resolutionClass = 'assumed';
  else cites.push(reply.id);
  if (csat !== undefined && /Resolved: yes/.test(csat.text)) {
    resolutionClass = 'verified';
    cites.push(csat.id);
  } else if (csat !== undefined && /Resolved: no/.test(csat.text)) {
    resolutionClass = 'assumed';
    cites.push(csat.id);
  }
  const wordsOf = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    );
  let draftVerdict = 'no_draft';
  let draftQuality = 0;
  if (draftFact !== undefined && reply !== undefined) {
    const a = wordsOf(draftFact.text);
    const b = wordsOf(reply.text);
    const shared = [...a].filter((word) => b.has(word)).length;
    const overlap = a.size + b.size - shared === 0 ? 0 : shared / (a.size + b.size - shared);
    draftQuality = Math.round(overlap * 100) / 100;
    draftVerdict = overlap >= 0.6 ? 'matches' : overlap >= 0.25 ? 'partial' : 'differs';
    cites.push(draftFact.id);
  } else if (draftFact !== undefined) {
    draftVerdict = 'differs';
  }
  const kbGap = reply !== undefined && kb !== undefined && /No knowledge base/.test(kb.text);
  const text =
    resolutionClass === 'verified'
      ? thai
        ? 'ลูกค้ายืนยันว่าแก้ไขได้แล้ว'
        : 'The customer confirmed the problem was solved.'
      : resolutionClass === 'contained'
        ? thai
          ? 'ทีมตอบแล้วและลูกค้าไม่ติดต่อกลับ แต่ยังไม่มีใครยืนยัน'
          : 'Staff answered and the customer did not come back, but nobody confirmed it.'
        : thai
          ? 'ยังไม่มีคำตอบจากทีมให้เรียนรู้'
          : 'There is no staff answer to learn from.';
  return JSON.stringify({
    resolutionClass,
    draftVerdict,
    draftQuality,
    policyViolations: [],
    kbGap,
    reasons: [{ text, factIds: cites.slice(0, 3) }],
  });
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
      case 'investigator':
        text = investigate(request, hash);
        break;
      case 'drafter':
        text = draft(request, hash);
        break;
      case 'kb_author':
        text = authorArticle(request);
        break;
      case 'grader':
        text = gradeResolution(request);
        break;
      case 'grader_pre_send':
        // A stand-in that finds nothing wrong. The grade it makes is flagged `mock`, and the gate never
        // lets a mock grade clear an automatic send, so this can only exercise the pipeline.
        text = JSON.stringify({ score: 0.9, violations: [] });
        break;
      case 'procedure_compiler':
        text = compileProcedureExample();
        break;
      case 'assistant_plan':
        text = assistantPlan(request);
        break;
      case 'assistant_answer':
        text = assistantAnswer(request);
        break;
      case 'claim_summary':
        text = claimSummary(request);
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
