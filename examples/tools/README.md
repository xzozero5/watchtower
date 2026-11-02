# Tool fixtures

Example answers for the mock mode of the tools that reach systems outside Watchtower: GCP Logging,
Cloud Monitoring, the product database and the repository host (T-203). The worker (the AI's tools)
and the api (the buttons a person presses) both read `fixtures.json` from the directory named by
`AI_TOOL_FIXTURES_DIR` (repo checkout: `examples/tools`) and build the fake clients of
`@watchtower/connectors` from it. Every answer is labelled mock and shown on the evidence card as
`(mock data)`: it is an example of the shape of a real answer, not a fact about any customer.

- `logs`: log lines. `agoMinutes` places a line relative to the moment of the query, so it stays inside
  the window whenever you run it. `labels` are what a template's filter can match
  (`labels.org_ref="..."`). **The messages carry fake personal data** (an e-mail address, a phone
  number) on purpose: the tests prove the redactor takes it out before a model or a stored card sees it (N4).
- `data`: rows by the **name of a saved query template**. The fake data client answers by that name and
  does not read the SQL (the SQL is checked by the guard and, against a real engine, by the
  `product_mock` database in `examples/metrics/`).
- `repo`: changes per repository (`owner/name`), `agoHours` before the query. Deploys are not here: they
  come from the `deploy` table.
- `services`: the service slugs the fake metrics client has numbers for (empty: every slug).

What a run asks is not in this file. The question is a **saved template**: a filter or one SELECT with
`{{name}}` placeholders, per intent (`POST /v1/tools/templates`, head only). An intent reaches a system
only when its `allowedTools` names it (`webhook_not_received`, `upstream_timeout` and `processing_failure`
do in `examples/intents/`) *and* it has a template for it.

No real company, host or person is named here (N1). The shape is `mockFixturesSchema` in
`packages/connectors/src/mock.ts`; the worker and the api refuse to start on a file that does not match.
