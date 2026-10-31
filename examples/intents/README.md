# Starter intents

One JSON file per intent, the taxonomy of PRD section 3.1 (`[ASSUMED]`: each deployment refines it
after its first two weeks of real tickets). The files are examples, not a product decision.

They are loaded into the `intent` table by `seedIntents()` in `@watchtower/db` (called by the seed
script, T-008). Loading never overwrites an intent that already exists, so edits made in a running
instance survive a re-seed. The app code does not read these files and does not hard-code any key.

Fields: `key` (lower snake_case, unique), `name`, `description`, `typicalEvidence`,
`defaultPriority` (`P1` to `P4`), `allowedTools`, `replyTemplates`. There is deliberately no
autonomy stage: every intent starts at stage 2, draft-for-approval (N3), and only the AI autonomy
endpoints change it.
