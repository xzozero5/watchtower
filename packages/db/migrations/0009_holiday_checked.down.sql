-- Reverts 0009. Lossy on purpose: the check state (who checked which date, and when) is dropped, and
-- every holiday goes back to {"date", "name"}. Apply 0009 again and every date is unchecked.
UPDATE business_calendar
   SET holidays = (
         SELECT COALESCE(jsonb_agg(
                  jsonb_build_object('date', element -> 'date', 'name', element -> 'name')
                  ORDER BY position
                ), '[]'::jsonb)
           FROM jsonb_array_elements(business_calendar.holidays) WITH ORDINALITY AS item (element, position)
       )
 WHERE jsonb_typeof(holidays) = 'array'
   AND jsonb_array_length(holidays) > 0;
