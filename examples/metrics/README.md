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
  `PRODUCT_MOCK_ADMIN_PASSWORD=<letters and digits> PRODUCT_MOCK_RO_PASSWORD=<12+ letters and digits> docker compose --profile product-mock up product-mock-init`
  starts `product-mock-db`, a Postgres server **of its own** with a memory limit (`mem_limit: 512m`; a statement
  that eats memory takes down this container, not the Watchtower database, T-207a C-1), and in it creates
  `product_mock`, the login `product_mock_ro` (`NOINHERIT`) and the group `product_mock_ro_reader` (which holds
  the column grants), loads the files above, and exits. Point the api and worker at it with
  `PRODUCT_DB_URL=postgres://product_mock_ro:<that password>@localhost:5433/product_mock`
  (inside compose the host is `product-mock-db`, port 5432). A statement of a person's own (ad-hoc data) stays
  off until `PRODUCT_DB_ADHOC_ENABLED=true`. Empty `PRODUCT_DB_URL` = the data tool has no database. Outside a
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
   `SELECT` and nothing more: no temporary tables, nothing created. A role can always change its own
   defaults, so the one that runs the statement is not the login that can. The personal columns
   (`display_name`, `contact_email`, `submitted_by`) are not granted.
5. **Functions are revoked by kind, not by name** (a denylist of names kept losing): every volatile
   `pg_catalog` function except `random`, `gen_random_uuid`, `clock_timestamp`, `timeofday`, and the whole
   families of advisory locks, logical decoding and WAL, notify, file reads, large objects, transaction ids,
   dblink, backend control, sleeps and `set_config`. Operators, casts and aggregates stay (they must).
6. **Resource limits no statement can raise**: `work_mem=16MB`, `temp_file_limit=64MB` on the login, and a byte
   cap on what the executor reads (stops at 1 MB with `truncated`, drops the connection at 16 MB).
7. **A self-check**: `hardeningProblems()` asks what the reader can still do. While it names anything,
   ad-hoc statements answer 503 and only saved templates run. A real product database (T-208) whose owner
   does not allow these revokes is used that way; see ADR-016, items 5c and 5d.

On top of that, in code (a courtesy and a second layer, not the barrier):

8. Result columns are shown only if they are on the allow-list (`DATA_COLUMN_ALLOW_LIST`, plus the
   `allowedColumns` of the saved template); any other column comes back null and is listed in `masked`.
9. Text in results goes through the redactor before it is stored on an evidence card or reaches a model (N4).
10. Only `SELECT` / `WITH ... SELECT` pass the text check. `EXTERNAL_QUERY` is refused (po decision 2).
11. A statement of your own (`investigate.adhoc`) is for lead and head. A saved template is edited by head and audited.

## Starter metrics (T-205a)

Examples of the metric definitions a head configures (PRD R-8.1). Nothing here is real: the SQL reads a
stand-in schema, `product_mock`, defined in `product_mock.sql`, and the organizations are whatever ids you
give it. A real deployment writes its own templates for its own product database and does not use these.

| File | What it is |
|---|---|
| `metrics.json` | the definitions: key, name, declared dimensions, unit, refresh interval, anomaly rule, and the template file |
| `*.sql` | the templates. Read-only, one `SELECT`, the window bound as `$1` (from) and `$2` (to) |
| `product_mock.sql` | the stand-in product schema and `product_mock.seed(orgs)`, which fills eight days of runs and gives the second organization an anomaly in the last complete hour |

The rules a template follows (the worker refuses anything else, and says why on the metric):

- it returns `ts` (an hour boundary), `value`, and **exactly** the dimensions the definition declares; an extra
  column or a missing one refuses the whole run;
- the dimension `org` carries an organization id; any other dimension value goes through the redactor before it is stored;
- values arrive only as the bound `$1` and `$2`, never inside the SQL text;
- only a head (`metric.manage`) can create or change one, and a change to the SQL is audited with the hash of
  the old and the new text.

A fresh series raises nothing until it has seven days of history, so the first week after a metric is created is quiet by design.
