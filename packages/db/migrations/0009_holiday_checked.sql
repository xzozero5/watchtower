-- T-127: a check state per holiday of a business calendar (UI spec 18.9 H4, `[ASSUMED]` by the owner's
-- main thread). Public holidays come from example data or a person's import and are `[VERIFY]`
-- until someone compares each date with the official announcement.
--   Holidays stay in business_calendar.holidays (jsonb). Each element becomes
--     {"date": "2026-12-31", "name": "...", "checked": false, "checkedAt": null, "checkedBy": null}
--   This migration writes the three keys into every existing element, `checked` = false: nothing
--   that exists today has been checked by a person, whatever its origin. The api reads an element
--   without the keys as unchecked too, so rows written by older code stay valid.
--   Only the head's PATCH /v1/business-calendars/:id/holidays/:date sets `checked` true and fills
--   `checkedAt` / `checkedBy`; editing a calendar keeps the state of a holiday whose date and name
--   did not change and resets any other.
-- No new table, column or permission (sla.manage covers it). Reversible: see
-- 0009_holiday_checked.down.sql.

UPDATE business_calendar
   SET holidays = (
         SELECT COALESCE(jsonb_agg(
                  jsonb_build_object(
                    'date', element -> 'date',
                    'name', element -> 'name',
                    'checked', false,
                    'checkedAt', 'null'::jsonb,
                    'checkedBy', 'null'::jsonb
                  )
                  ORDER BY position
                ), '[]'::jsonb)
           FROM jsonb_array_elements(business_calendar.holidays) WITH ORDINALITY AS item (element, position)
       )
 WHERE jsonb_typeof(holidays) = 'array'
   AND jsonb_array_length(holidays) > 0;
