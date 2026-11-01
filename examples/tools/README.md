# Tool fixtures

Example answers for the mock mode of the AI tools that reach systems outside Watchtower: GCP Logs
(`gcp_logs`), BigQuery or the product database (`bigquery_query`) and the repository (`repo_changes`).
The worker reads `fixtures.json` from the directory named by `AI_TOOL_FIXTURES_DIR` (repo checkout:
`examples/tools`) and registers the three stubs only when it is set. Every answer is labelled mock
and shown on the evidence card as `(mock data)`: it is an example of the shape of a real answer, not
a fact about any customer.

- `gcpLogs`: a scenario answers when the query contains one of its `keywords`.
- `bigquery`: a saved query template by name. Until a service catalog exists (Phase 2) the template
  name of a runbook step is the intent key.
- `repoChanges`: changes of a service, found by name (also the intent key for now).

An intent reaches a stub only when its `allowedTools` names it (`webhook_not_received`,
`upstream_timeout` and `processing_failure` do in `examples/intents/`).

No real company, host or person is named here (N1). The shape is `stubFixturesSchema` in
`packages/ai/src/toolkit/ports.ts`; the worker refuses to start on a file that does not match.
