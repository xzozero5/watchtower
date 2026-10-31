import { describe, expect, it } from 'vitest';

import { promptRefSchema } from './contract.js';
import { parsePromptFile, PromptFileError, renderPrompt } from './prompts.js';

const FILE = `---
id: classifier
version: 2
---
Classify the message from {{ customer }}.
Language: {{language}}
`;

describe('prompt files', () => {
  it('parses id, version and a content hash', () => {
    const parsed = parsePromptFile('classifier.v2.md', FILE);
    expect(promptRefSchema.parse(parsed.ref)).toEqual(parsed.ref);
    expect(parsed.ref).toMatchObject({ id: 'classifier', version: 2 });
    expect(parsed.body).toBe('Classify the message from {{ customer }}.\nLanguage: {{language}}');
  });

  it('changes the hash on any edit, even whitespace, and ignores line-ending style for parsing', () => {
    const base = parsePromptFile('classifier.v2.md', FILE).ref.hash;
    expect(parsePromptFile('classifier.v2.md', `${FILE} `).ref.hash).not.toBe(base);
    expect(parsePromptFile('classifier.v2.md', FILE.replaceAll('\n', '\r\n')).body).toBe(
      parsePromptFile('classifier.v2.md', FILE).body,
    );
  });

  it('rejects a file whose name and front matter disagree', () => {
    expect(() => parsePromptFile('classifier.v3.md', FILE)).toThrow(PromptFileError);
    expect(() => parsePromptFile('summarizer.v2.md', FILE)).toThrow(PromptFileError);
  });

  it('rejects bad names and missing front matter', () => {
    expect(() => parsePromptFile('classifier.md', FILE)).toThrow(PromptFileError);
    expect(() => parsePromptFile('classifier.v0.md', FILE)).toThrow(PromptFileError);
    expect(() => parsePromptFile('classifier.v2.md', 'no front matter')).toThrow(PromptFileError);
  });

  it('renders slots and refuses unknown ones', () => {
    const { body } = parsePromptFile('classifier.v2.md', FILE);
    expect(renderPrompt(body, { customer: 'X', language: 'th' })).toBe(
      'Classify the message from X.\nLanguage: th',
    );
    expect(() => renderPrompt(body, { customer: 'X' })).toThrow(PromptFileError);
  });
});
