# Prompts

Versioned prompt files for the agents (ADR-008). One file per prompt version:

```
<id>.v<version>.md        e.g. classifier.v1.md
```

Each file starts with front matter that repeats the id and version:

```
---
id: classifier
version: 1
---
<prompt body, with {{slot}} placeholders>
```

Rules:

- A change of behaviour is a **new version file**, not an edit. Old versions stay so past `ai_run`
  rows still point at text that exists.
- The `hash` stored in `ai_run` is the sha256 of the whole file content (`parsePromptFile`), so
  even a whitespace edit is visible.
- A prompt body is rendered with `renderPrompt`, and the **rendered text must go through the
  redactor** before it reaches a provider (slot values can carry PII).
- No customer data, internal URLs or company-specific procedure text in these files (N1).

The first prompts (`classifier`, `summarizer`) arrive with T-106e.
