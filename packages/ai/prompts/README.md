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

T-301 adds `grader.v1.md` (a resolved ticket's facts in, a cited verdict out: `verified|contained|assumed`, draft
verdict and quality, policy violations, KB gap; `{{language}}` slot). The class the model proposes is capped in code
by what the facts support (`capResolutionClass`), so a prompt change cannot make `verified` easier to reach. The eval
runner (`evals/runner`) can run any case at every version of a prompt (`--all-versions`).

T-303c adds `investigator.v3.md` (v2 plus a `{{procedure_checks}}` slot: the questions of the published procedure, and the extra
`checkAnswers` key of the answer; empty without a procedure) and `drafter.v2.md` (v1 plus a `{{guidelines}}` slot: the team's reply
guidelines and the topics it must not mention, placed after every rule and saying they rank below the rules, the disclosure level and
the evidence; empty without a procedure). The slot text goes through the redaction session like every other slot value (N4).

T-303b adds `procedure_compiler.v1.md` (the plain-language procedure of an intent in, the strict step list of ADR-026 out, plus what
the model had to guess). The text is redacted first; the steps are checked by the Zod schema in `@watchtower/shared` and by the domain,
and a person confirms them: the agent only drafts.
