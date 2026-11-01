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

- **docker compose**: the `product-mock-init` one-shot creates `product_mock` and the login
  `product_mock_ro` on the same Postgres server, loads the three files above, and exits. Point the api
  and worker at it with `PRODUCT_DB_URL=postgres://product_mock_ro:product_mock_ro@postgres:5432/product_mock`
  (from the host: `localhost:5432`). Empty `PRODUCT_DB_URL` = the data tool has no database.
- **tests**: `createProductMockDatabase` (`@watchtower/db/testing`) makes a throwaway copy with a
  random read-only login, using the same files.

A database named `product_mock` is treated as **sandbox** data: results are labelled mock (N5).

## Guardrails (T-203c)

1. The login can read columns, not tables; personal columns are not granted.
2. Every statement runs in a `READ ONLY` transaction with its own `statement_timeout`, and at most
   `maxRows + 1` rows are read (the cap is 500).
3. Result columns are shown only if they are on the allow-list (`DATA_COLUMN_ALLOW_LIST`, plus the
   `allowedColumns` of the saved template); any other column comes back null and is listed in `masked`.
4. Text in results goes through the redactor before it is stored on an evidence card or reaches a model (N4).
5. Only `SELECT` / `WITH ... SELECT`. `EXTERNAL_QUERY` is refused (po decision 2).
6. A statement of your own (`investigate.adhoc`) is for lead and head. A saved template is edited by head and audited.
