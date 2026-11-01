# Starter metrics (T-205a)

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
