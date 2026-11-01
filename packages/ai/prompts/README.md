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

T-108 adds `investigator.v1.md` (evidence list in, cited report out), `drafter.v1.md` (one reply in the
customer's language, sentence by sentence, each with the evidence behind it; `{{language}}`,
`{{disclosure}}` and `{{note}}` slots) and `kb_author.v1.md` (a draft article from a resolved ticket).

Current prompts (T-106e): `classifier.v1.md` (type of message + intent + confidence, JSON answer) and
`summarizer.v1.md` (one-line summary + one next step, JSON answer). The agents in `src/agents/` load
the highest version through `loadPromptCatalog()`; `package.json` lists `prompts` in `files`, so a
deployed copy carries them. The `{{intents}}` slot of the classifier is filled from the instance's
own intent list at run time, so the file holds nothing organisation-specific.
