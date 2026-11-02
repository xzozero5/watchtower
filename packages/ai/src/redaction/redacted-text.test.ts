import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EmbeddingProvider, LlmProvider, LlmRequest, PromptRef } from '../contract.js';
import { createAuditedLlm } from '../audited.js';
import { mockSettings } from '../models.js';
import { MockEmbeddingProvider, MockLlmProvider } from '../providers/mock.js';
import { createRedactor } from './redactor.js';
import { loadPromptCatalog } from '../prompt-files.js';
import { parsePromptFile, PromptFileError, registerCatalogPrompt } from '../prompts.js';
import { joinRedacted, renderTrustedPrompt, type RedactedText } from './redacted-text.js';

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
      redaction: { report: () => ({ total: 0, byKind: {} }) },
    });
    return call.then(
      () => undefined,
      () => undefined,
    );
  });

  it('accepts what the redactor returns, and the type is not assignable back from string', () => {
    const redacted = redactor.session({ scope: 'ticket:test' }).redact('hello');
    expectTypeOf(redacted).toEqualTypeOf<RedactedText>();
    expectTypeOf<string>().not.toExtend<RedactedText>();
    expectTypeOf<RedactedText>().toExtend<string>();
    expectTypeOf<LlmRequest['system']>().toEqualTypeOf<RedactedText>();
    expectTypeOf<LlmRequest['messages'][number]['content']>().toEqualTypeOf<RedactedText>();
  });

  it('keeps redacted text redacted when joined', () => {
    const session = redactor.session({ scope: 'ticket:test' });
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

describe('renderTrustedPrompt', () => {
  const file = registerCatalogPrompt(
    parsePromptFile(
      't.v1.md',
      '---\nid: t\nversion: 1\n---\nnew_customer_issue {{ who }} / {{who}}\n{{list}}',
    ),
  );
  const names = createRedactor({ names: () => ['Smoke Customer'] });
  const start = () => names.session({ scope: 'x' });

  it('leaves template text alone and redacts every slot value', () => {
    const out = renderTrustedPrompt(file, { who: 'Smoke Customer', list: '-' }, start());
    expect(out).toBe('new_customer_issue [NAME_1] / [NAME_1]\n-');
    expectTypeOf(out).toEqualTypeOf<RedactedText>();
  });

  it('keeps a valid { key } part verbatim and redacts text and invalid keys', () => {
    const out = renderTrustedPrompt(
      file,
      {
        who: 'x',
        list: ['* ', { key: 'new_customer_issue' }, ': Smoke Customer ', { key: 'Smoke Customer' }],
      },
      start(),
    );
    expect(out).toBe('new_customer_issue x / x\n* new_customer_issue: [NAME_1] [NAME_1]');
  });

  it('throws on a missing slot value', () => {
    expect(() => renderTrustedPrompt(file, { who: 'x' }, start())).toThrow(PromptFileError);
  });

  it('refuses a literal, a copy or an unregistered parse (nothing else can become trusted text)', () => {
    const text = '---\nid: t\nversion: 1\n---\na@b.com';
    for (const forged of [
      { ref: file.ref, body: 'a@b.com' },
      { ...file },
      parsePromptFile('t.v1.md', text),
    ]) {
      expect(() => renderTrustedPrompt(forged, { who: 'x', list: 'y' }, start())).toThrow(
        PromptFileError,
      );
    }
  });

  it('cannot be edited after loading: changing the body of a catalog prompt throws', () => {
    const prompt = loadPromptCatalog().latest('summarizer');
    expect(() => {
      (prompt as { body: string }).body = 'a@b.com';
    }).toThrow(TypeError);
    expect(() => {
      (prompt.ref as { hash: string }).hash = 'x';
    }).toThrow(TypeError);
    expect(Object.isFrozen(prompt)).toBe(true);
  });

  it('keeps parsePromptFile and the registry off the package entry point', async () => {
    const entry = await import('../index.js');
    for (const name of ['parsePromptFile', 'registerCatalogPrompt', 'isCatalogPrompt']) {
      expect(name in entry).toBe(false);
    }
  });

  it('has no placeholder-shaped text in any prompt file (a file cannot pose as redactor output)', () => {
    const dir = fileURLToPath(new URL('../../prompts', import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/\[[A-Z_]+_\d+\]/);
    }
  });
});
