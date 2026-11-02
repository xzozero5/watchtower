# @watchtower/connectors

Clients of systems outside Watchtower, read-only by type (N2, ADR-015). No database, no secret, no
network: a live adapter is a separate task per system (T-208, `[ASK-HUMAN]`).

| Folder | Interface | Method | Fake |
|---|---|---|---|
| `src/alerts/` | normalizers (pure) | `normalizeGcpAlert`, `normalizeAlertmanager` | fixtures in `__fixtures__/` |
| `src/logs/` | `LogsClient` | `listEntries` (one page = one request against the 60/min quota) | `FakeLogsClient` |
| `src/metrics/` | `MetricsClient` | `queryTimeSeries` | `FakeMetricsClient` |
| `src/data/` | `DataQueryClient` | `query` | `FakeDataQueryClient`; real Postgres via `createGuardedSqlClient` over an executor from `@watchtower/db` |
| `src/repo/` | `RepoClient` | `listChanges` | `FakeRepoClient` |

- **A method that writes does not type-check**: `src/clients.test.ts` fails to compile when an interface
  gains a method it does not list, and fails when a listed name starts with a write verb.
- **One contract for every implementation**: `src/clients.contract.ts` (excluded from the build). The
  fakes run it in `clients.test.ts`; a live adapter must pass the same suite before it is trusted.
- **Quota**: each fake takes `quotaPerMinute` and an injected `clock` and answers
  `ConnectorRateLimitedError` (429, `retryAfterMs`) past it. The budget that keeps Watchtower under the
  quota is not here: `apps/*` take a unit from `rate_budget_window` before they call (ADR-015 section 3).
- **Templates** (`src/templates.ts`): `{{name}}` becomes a quoted literal in a log filter and a bind
  parameter (`$1`) in SQL; values are plain text only. `validateTemplate` refuses a body that could never run.
- **Data guardrails** (`src/data/guard.ts`): reads only (`assertReadOnlySql`, `EXTERNAL_QUERY` off by a
  constant), row cap, timeout, result columns off the allow-list come back null and are listed in `masked`.
- **Mock mode** (`src/mock.ts`, `src/clients.ts`): the four fakes over `examples/tools/fixtures.json`,
  assembled the same way by the api and the worker.
