import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EmbeddingProvider, LlmProvider, LlmRequest, PromptRef } from '../contract.js';
import { createAuditedLlm } from '../audited.js';
import { mockSettings } from '../models.js';
import { MockEmbeddingProvider, MockLlmProvider } from '../providers/mock.js';
import { createRedactor } from './redactor.js';
import { joinRedacted, type RedactedText } from './redacted-text.js';

const prompt: PromptRef = { id: 'classifier', version: 1, hash: 'b'.repeat(64) };
const redactor = createRedactor();

describe('RedactedText (N4 enforced by the compiler)', () => {
  it('rejects plain strings at every provider port', async () => {
    const llm: LlmProvider = new MockLlmProvider();
    const embedder: EmbeddingProvider = new MockEmbeddingProvider();
    const raw = 'my id is 1101700230673, mail a@b.com';

    // Each @ts-expect-error fails the typecheck if the line starts compiling, i.e. if a plain
    // string is ever accepted. The calls still run, because the brand is erased at runtime.
    await llm.generate({
      model: 'm',
      tier: 'light',
      prompt,
      // @ts-expect-error a plain string is not RedactedText
      system: raw,
      // @ts-expect-error a plain string is not RedactedText
      messages: [{ role: 'user', content: raw }],
    });
    await embedder.embed({
      model: 'm',
      // @ts-expect-error a plain string is not RedactedText
      values: [raw],
    });
    expect(true).toBe(true);
  });

  it('rejects plain strings at the audited entry point', () => {
    const llm = createAuditedLlm({
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: {},
      sink: { record: () => Promise.resolve() },
    });
    const call = llm.generate({
      agent: 'classifier',
      prompt,
      // @ts-expect-error a plain string is not RedactedText
      system: 'raw text',
      messages: [],
      redaction: { total: 0, byKind: {} },
    });
    return call.then(
      () => undefined,
      () => undefined,
    );
  });

  it('accepts what the redactor returns, and the type is not assignable back from string', () => {
    const redacted = redactor.session().redact('hello');
    expectTypeOf(redacted).toEqualTypeOf<RedactedText>();
    expectTypeOf<string>().not.toExtend<RedactedText>();
    expectTypeOf<RedactedText>().toExtend<string>();
    expectTypeOf<LlmRequest['system']>().toEqualTypeOf<RedactedText>();
    expectTypeOf<LlmRequest['messages'][number]['content']>().toEqualTypeOf<RedactedText>();
  });

  it('keeps redacted text redacted when joined', () => {
    const session = redactor.session();
    const joined = joinRedacted([session.redact('a@b.com'), session.redact('x')], '\n\n');
    expect(joined).toBe('[EMAIL_1]\n\nx');
    expectTypeOf(joined).toEqualTypeOf<RedactedText>();
    // @ts-expect-error a free-form separator could smuggle raw text in
    joinRedacted([joined], 'a@b.com');
  });

  it('is minted only by the redactor: no other source file imports mintRedacted', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && /\bmintRedacted\b/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path.slice(root.length));
        }
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual([
      join('redaction', 'redacted-text.test.ts'), // this file mentions the name
      join('redaction', 'redacted-text.ts'),
      join('redaction', 'redactor.ts'),
    ]);
  });

  it('is not exported from the package entry point', async () => {
    const entry = await import('../index.js');
    expect('mintRedacted' in entry).toBe(false);
  });
});
