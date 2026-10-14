-- 20261014_printer_status_nullable.sql
--
-- Two separate blockers stopped printer_status from ever recording "we could
-- not read the printer":
--
--   1. toner_* / paper_level are NOT NULL, so the only writable value is a
--      number. There was no way to express "no reading".
--   2. the status CHECK constraint allowed only
--      ('online','offline','jam_minor','jam_major'). Verified by probing the
--      live table: 'low' and 'unknown' are both rejected with 23514.
--
-- Together these mean the UI could only ever show a number and a status the
-- printer had told us about, which is why hand-entered 100%s sat there for
-- two days being presented as live readings.
--
-- Safe to re-run.

-- 1. Allow "no reading available".
ALTER TABLE printer_status ALTER COLUMN toner_black   DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN toner_cyan    DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN toner_magenta DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN toner_yellow  DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN paper_level   DROP NOT NULL;

-- 2. Allow the two states the backend actually produces.
--    'low'      -> printer reported, but a toner is at or below 15%
--    'unknown'  -> printer could not be read at all
ALTER TABLE printer_status DROP CONSTRAINT IF EXISTS printer_status_status_check;
ALTER TABLE printer_status
  ADD CONSTRAINT printer_status_status_check CHECK (
    status IN ('online', 'offline', 'jam_minor', 'jam_major', 'low', 'unknown')
  );

-- 3. Start honest rather than inheriting the stale hand-entered values.
--    Null means "no reading"; a number means the printer reported it.
UPDATE printer_status
   SET status = 'unknown',
       toner_black = NULL, toner_cyan = NULL,
       toner_magenta = NULL, toner_yellow = NULL;
