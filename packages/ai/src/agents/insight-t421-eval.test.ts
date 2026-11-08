import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { numbersSubsetOfFacts, type InsightElementKey, type InsightFact } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { createAuditedLlm } from '../audited.js';
import type { AiRunRecord, LlmProvider, LlmRequest } from '../contract.js';
import { mockSettings } from '../models.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { createRedactor } from '../redaction/redactor.js';
import { ALLOW_ALL_GUARD } from '../test-guard.js';
import type { AgentDeps } from './common.js';
import { narrateElements, type InsightNarrationBatch } from './insight-narrate.js';

interface GoldenCaseInput {
  elements: Array<{
    key: string;
    scopeKey?: string;
    facts: Array<{
      id: string;
      kind: string;
      value: number | string;
      display: { th: string; en: string };
      ref?: { kind: string; id: string };
    }>;
  }>;
}

interface GoldenFile {
  cases: Array<{
    id: string;
    agent: string;
    description: string;
    input: GoldenCaseInput;
  }>;
}

function loadEvalCases(): GoldenFile['cases'] {
  const proposalPath = resolve(process.cwd(), '../../evals/proposals/insights.json');
  const goldenPath = resolve(process.cwd(), '../../evals/golden/insight_narrator.json');
  const path = existsSync(proposalPath) ? proposalPath : goldenPath;
  if (!existsSync(path)) {
    throw new Error(`Neither proposals nor golden insights eval file found at ${path}`);
  }
  const content = JSON.parse(readFileSync(path, 'utf8')) as GoldenFile;
  return content.cases.filter((c) => c.agent === 'insight_narrator');
}

function setupRig(answer: unknown) {
  const runs: AiRunRecord[] = [];
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    kind: 'mock',
    generate: (request) => {
      requests.push(request);
      const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
      return Promise.resolve({
        text,
        finishReason: 'stop',
        usage: { inputTokens: 15, outputTokens: 15 },
        model: request.model,
      });
    },
  };
  const deps: AgentDeps = {
    llm: createAuditedLlm({
      guard: ALLOW_ALL_GUARD,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: { mock: provider },
      sink: {
        record: (run) => {
          runs.push(run);
          return Promise.resolve({ id: '00000000-0000-4000-8000-000000000042' });
        },
      },
    }),
    redactor: createRedactor({ names: () => [] }),
    prompts: loadPromptCatalog(),
    guard: { check: () => Promise.resolve({ allowed: true }) },
  };
  return { deps, runs, requests };
}

describe('T-421 QA Gate: Eval / Hallucinated Number = 0 (AC-J18)', () => {
  const evalCases = loadEvalCases();

  it('loaded eval cases successfully with comprehensive coverage', () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(15);
  });

  describe('Adversarial Hallucinated Numbers Rejection (Arabic & Thai Numerals)', () => {
    it.each(evalCases)(
      'case $id: detects and rejects hallucinated numbers ($description)',
      (testCase) => {
        for (const element of testCase.input.elements) {
          const facts = element.facts as InsightFact[];
          if (facts.length === 0) continue;

          // Collect all legitimate numbers mentioned in facts
          const knownNumbers = new Set(
            facts.flatMap((f) => [String(f.value), ...Object.values(f.display)]),
          );

          // 1. Adversarial Arabic numeral definitely not in facts
          const fakeArabicNumber = '987654';
          expect(knownNumbers.has(fakeArabicNumber)).toBe(false);

          const arabicSentence = `สรุปมีปริมาณเกินเกณฑ์ ${fakeArabicNumber} รายการ`;
          const arabicCheck = numbersSubsetOfFacts(arabicSentence, facts);
          expect(
            arabicCheck.ok,
            `Arabic number ${fakeArabicNumber} must be flagged as unmatched`,
          ).toBe(false);
          expect(arabicCheck.unmatched).toContain(fakeArabicNumber);

          // 2. Adversarial Thai numeral definitely not in facts
          const fakeThaiNumber = '๙๘๗๖๕๔';
          const thaiSentence = `สรุปมีปริมาณเกินเกณฑ์ ${fakeThaiNumber} รายการ`;
          const thaiCheck = numbersSubsetOfFacts(thaiSentence, facts);
          expect(thaiCheck.ok, `Thai number ${fakeThaiNumber} must be flagged as unmatched`).toBe(
            false,
          );
          // The check converts Thai numerals to Arabic digits for comparison
          expect(thaiCheck.unmatched).toContain(fakeArabicNumber);

          // 3. Legitimate numbers from facts must pass
          for (const fact of facts) {
            if (typeof fact.value === 'number') {
              const validSentence = `ตัวเลขสถิติคือ ${String(fact.value)} รายการ`;
              const validCheck = numbersSubsetOfFacts(validSentence, [fact]);
              expect(
                validCheck.ok,
                `Legitimate fact number ${String(fact.value)} must be accepted`,
              ).toBe(true);
              expect(validCheck.unmatched).toEqual([]);
            }
          }
        }
      },
    );
  });

  describe('Validator 100% Rejection & Zero Hallucinated Numbers in Accepted Claims', () => {
    it('rejects 100% of LLM claims with hallucinated Arabic numbers and counts as rejected', async () => {
      const sampleCase = evalCases[0];
      if (!sampleCase) throw new Error('No eval cases');
      const elem = sampleCase.input.elements[0];
      if (!elem) throw new Error('No element');

      const factId = elem.facts[0]?.id;
      if (!factId) throw new Error('No fact');

      const hallucinatedArabic = {
        [elem.key]: {
          en: [
            {
              text: 'Tickets breached threshold by 999999 cases.',
              factIds: [factId],
            },
          ],
        },
      };

      const { deps } = setupRig(hallucinatedArabic);
      const batchInput: InsightNarrationBatch = {
        scope: 'insight:eval',
        elements: [
          {
            key: elem.key as never,
            scopeKey: elem.scopeKey ?? 'instance',
            facts: elem.facts as InsightFact[],
          },
        ],
        locales: ['en'],
      };

      const outcome = await narrateElements(deps, batchInput);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;

      // 100% rejected, 0 accepted claims
      expect(outcome.accepted[elem.key as InsightElementKey]?.en ?? []).toHaveLength(0);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]?.reason).toBe('number_not_in_facts');
    });

    it('rejects 100% of LLM claims with hallucinated Thai numerals (๑๒๓) and counts as rejected', async () => {
      const sampleCase = evalCases[0];
      if (!sampleCase) throw new Error('No eval cases');
      const elem = sampleCase.input.elements[0];
      if (!elem) throw new Error('No element');

      const factId = elem.facts[0]?.id;
      if (!factId) throw new Error('No fact');

      const hallucinatedThai = {
        [elem.key]: {
          th: [
            {
              text: 'พบจำนวนตั๋วที่มีปัญหา ๙๙๙๙๙๙ รายการ',
              factIds: [factId],
            },
          ],
        },
      };

      const { deps } = setupRig(hallucinatedThai);
      const batchInput: InsightNarrationBatch = {
        scope: 'insight:eval',
        elements: [
          {
            key: elem.key as never,
            scopeKey: elem.scopeKey ?? 'instance',
            facts: elem.facts as InsightFact[],
          },
        ],
        locales: ['th'],
      };

      const outcome = await narrateElements(deps, batchInput);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;

      // 100% rejected, 0 accepted claims
      expect(outcome.accepted[elem.key as InsightElementKey]?.th ?? []).toHaveLength(0);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]?.reason).toBe('number_not_in_facts');
    });

    it('confirms every accepted claim has evidence >= 1, uncited === false, and hallucinated numbers = 0', async () => {
      const sampleCase = evalCases[0];
      if (!sampleCase) throw new Error('No eval cases');
      const elem = sampleCase.input.elements[0];
      if (!elem) throw new Error('No element');

      const firstFact = elem.facts[0];
      if (!firstFact) throw new Error('No fact');

      const legitimateAnswer = {
        [elem.key]: {
          en: [
            {
              text: `Status reports ${String(firstFact.value)} items in total.`,
              factIds: [firstFact.id],
            },
          ],
        },
      };

      const { deps } = setupRig(legitimateAnswer);
      const batchInput: InsightNarrationBatch = {
        scope: 'insight:eval',
        elements: [
          {
            key: elem.key as never,
            scopeKey: elem.scopeKey ?? 'instance',
            facts: elem.facts as InsightFact[],
          },
        ],
        locales: ['en'],
      };

      const outcome = await narrateElements(deps, batchInput);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;

      const accepted = outcome.accepted[elem.key as InsightElementKey]?.en ?? [];
      expect(accepted.length).toBeGreaterThan(0);

      for (const claim of accepted) {
        expect(claim.factIds.length).toBeGreaterThanOrEqual(1);
        expect(claim.evidence.length).toBeGreaterThanOrEqual(1);
        expect((claim as { uncited?: boolean }).uncited).not.toBe(true);

        // Cited facts validation
        const citedFacts = elem.facts.filter((f) => claim.factIds.includes(f.id)) as InsightFact[];
        const numCheck = numbersSubsetOfFacts(claim.text, citedFacts);
        expect(numCheck.ok).toBe(true);
        expect(numCheck.unmatched).toEqual([]);
      }
    });
  });
});
