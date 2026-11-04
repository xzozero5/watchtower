# Starter procedures

Templates for the procedure editor (T-303e, ADR-026). One JSON file each: a plain-language `sourceMd` and the `steps` it
compiles to. They are generic examples, not a product decision, and name no organization, customer or internal system (N1).

Fields: `key` (lower snake_case), `name`, `description`, `sourceMd` (at most 8 KB), `steps` (the `ProcedureSteps` of
`@watchtower/shared`: `schemaVersion: 1`, `autosend`, `steps`). A template uses only the tools every ticket has
(`kb_search`, `similar_tickets`, `org_context`) so it validates on any intent. `autosend` is `never`: a template cannot make a
draft go out by itself (ADR-026 section 5).

The web app carries a copy of these files (`apps/web/src/lib/admin/procedure-templates.ts`); a test keeps the two equal and
checks each file against the step schema. Starting from a template only fills a draft. A person still reads it, confirms it,
simulates it and publishes it.
