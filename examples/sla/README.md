# Example SLA policies

`sla-policies.json` holds the three tier policies the **development seed** creates: Gold, Silver and
Standard (neutral names, N1). The numbers live here and in the seed only, never in application code
(PO decision 8, `[ASSUMED]`, awaiting owner review).

Decided by the PO: Gold P1 first response 15 min / resolution 4 h on a 24x7 clock; Silver P1 30 min /
8 h; Standard on business hours for every priority. Everything else (P2 to P4, the calendar of
Silver P1, all of Standard) is an `[ASSUMED]` sensible default.

Each policy names the business calendar it counts business time on; the seed creates `Bangkok office
hours` (with the holidays of `../calendars/`) and a `24x7` calendar. A target with `"calendar":
"24x7"` counts wall-clock minutes whatever the calendar says.

An existing policy of the same name or tier is left alone, so edits made in a running instance
survive a re-seed.
