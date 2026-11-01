# Metrics and the `product_mock` database

Examples of the product-data side of Watchtower (PRD R-5.2, R-9.x). **Invented data, not a fact about
any company** (N1). A deployment replaces all of it with its own database and queries.

| File | What it is |
|---|---|
| `product-mock.schema.sql` | Three tables of an imaginary product: `tenants`, `api_daily`, `jobs`. Two hold personal data on purpose (`display_name`, `contact_email`, `submitted_by`). |
| `product-mock.seed.sql` | Deterministic seed with days relative to today. Tenant `t-003` has an **anomaly** on its last two days (about a third of its webhook deliveries fail and slow down): T-205c needs one to find. |
| `product-mock.grants.sql` | The read-only login: `SELECT` on columns, personal ones left out. `__RO_ROLE__` is replaced by the role's name. |
| `webhook-failure-rate.sql`, `slowest-tenants.sql` | Example saved queries with `{{name}}` parameters (they become `$1..` bind parameters). |

## Where it lives

A database of its own, never inside the Watchtower database (so a bug in a query cannot reach
tickets):

- **docker compose** (behind a profile, never started by a plain `up`; no default password):
  `PRODUCT_MOCK_RO_PASSWORD=<12+ letters and digits> docker compose --profile product-mock up product-mock-init`
  creates `product_mock`, the login `product_mock_ro` (`NOINHERIT`) and the group `product_mock_ro_reader`
  (which holds the column grants) on the same Postgres server, loads the files above, and exits. Point the
  api and worker at it with `PRODUCT_DB_URL=postgres://product_mock_ro:<that password>@localhost:5432/product_mock`
  (inside compose the host is `postgres`). Empty `PRODUCT_DB_URL` = the data tool has no database. Outside a
  local run (`APP_URL` not localhost, or production) the config refuses a `PRODUCT_DB_URL` without a real
  password (16+ characters).
- **tests**: `createProductMockDatabase` (`@watchtower/db/testing`) makes a throwaway copy with a random
  login and reader, using the same files.

A database named `product_mock` is treated as **sandbox** data: results are labelled mock (N5).

## Guardrails (T-203c)

What keeps a person's statement read-only does not depend on reading it (ADR-016):

1. **One statement, by protocol**: every query goes by the extended protocol, which Postgres refuses to
   parse as more than one command (`ROLLBACK; BEGIN READ WRITE; INSERT` is a syntax error).
2. **A cursor**: the statement is the body of `DECLARE ... CURSOR FOR`, so only a `SELECT` is accepted,
   a trailing `--` comment cannot swallow anything we append, and `FETCH` reads at most `maxRows + 1`
   rows while reading (cap 500), not after the server has built the result.
3. **A `READ ONLY` transaction** with `statement_timeout` and `lock_timeout` set by us, plus read-only and
   time limits as session defaults at connection start.
4. **A role that can do nothing else**: the executor `SET LOCAL ROLE`s to `*_reader`, which has column-level
   `SELECT` and nothing more: no temporary tables, nothing created, no `set_config`, no `pg_sleep`, no
   `pg_cancel_backend`. A role can always change its own defaults, so the one that runs the statement is not
   the login that can. The personal columns (`display_name`, `contact_email`, `submitted_by`) are not granted.

On top of that, in code (a courtesy and a second layer, not the barrier):

5. Result columns are shown only if they are on the allow-list (`DATA_COLUMN_ALLOW_LIST`, plus the
   `allowedColumns` of the saved template); any other column comes back null and is listed in `masked`.
6. Text in results goes through the redactor before it is stored on an evidence card or reaches a model (N4).
7. Only `SELECT` / `WITH ... SELECT` pass the text check. `EXTERNAL_QUERY` is refused (po decision 2).
8. A statement of your own (`investigate.adhoc`) is for lead and head. A saved template is edited by head and audited.
