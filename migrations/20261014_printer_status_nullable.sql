-- 20261014_printer_status_nullable.sql
-- printer_status.toner_* are NOT NULL, which makes it impossible to record
-- "we could not read the printer" -- only a number. That is why a printer
-- that stopped reporting kept showing its last hand-entered values (100%
-- across the board) rather than admitting it was unknown.
--
-- null now means "no reading available"; a number means the printer reported
-- it. Safe to re-run.

ALTER TABLE printer_status ALTER COLUMN toner_black   DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN toner_cyan    DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN toner_magenta DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN toner_yellow  DROP NOT NULL;
ALTER TABLE printer_status ALTER COLUMN paper_level   DROP NOT NULL;

-- Start from a clean, honest slate rather than the stale hand-entered values.
UPDATE printer_status
   SET status = 'unknown',
       toner_black = NULL, toner_cyan = NULL,
       toner_magenta = NULL, toner_yellow = NULL;
