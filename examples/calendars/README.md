# Example business calendars

`th-public-holidays-2026-2027.json` is the holiday list the **development seed** (`pnpm db:seed`)
loads into the `Bangkok office hours` calendar (Monday to Friday 09:00 to 18:00, `Asia/Bangkok`).

**`[VERIFY]` example data, not an official list.** It was written from general knowledge of the Thai
public holiday pattern. Before it drives a real SLA, check every date against the official
announcement of the Thai Cabinet (Royal Gazette) and the Bank of Thailand holiday table. Entries with
`"status": "unverified"` follow the lunar calendar or are substitution days that depend on a late
decision, and the 2027 list had not been announced when the file was written `[UNVERIFIED]`.

A production instance starts with no holidays (PO decision 15, `[ASSUMED]`): the seed refuses to run
there without an explicit flag, and the application never reads this directory.

File shape (checked by `loadHolidayFile` in `@watchtower/db`): `_meta.status` must contain the
`[VERIFY]` tag, `calendar` names the calendar and its IANA time zone, and every holiday has a real
`date` (`YYYY-MM-DD`, no duplicates), a `name` and a `status` of `verify` or `unverified`.
