-- 20261015_printer_diagnostics.sql
-- Keep the reason the printer status could not be read.
--
-- print-worker.py has always worked out WHY a read failed - "ipptool not
-- installed", "ipptool exit 1: connect: Connection refused", "reachable, but no
-- toner attributes in the response" - and has always sent it as `error` in the
-- report-supplies payload.
--
-- printer.js never stored it. It read body.alert (a CUPS stop reason, which
-- only exists when the printer IS reachable) and silently dropped body.error,
-- so the one message that actually explains an unreachable printer went
-- nowhere. The kiosk could only ever say "Status unknown - printer not
-- reporting", which gives staff nothing to act on.
--
-- printer_target records the queue/URI the worker is pointed at, so "not
-- reporting" can be distinguished from "pointing at the wrong address" -
-- which is exactly the situation after the printer moved to a new location.

ALTER TABLE printer_status
  ADD COLUMN IF NOT EXISTS printer_error  text,
  ADD COLUMN IF NOT EXISTS printer_target text;

-- Seed the target from the current queue name so the field is populated before
-- the worker next reports.
UPDATE printer_status
   SET printer_target = 'Brother'
 WHERE printer_target IS NULL;

-- ---------------------------------------------------------------------------
-- After the next supply poll, verify the reason is being kept:
--
--   SELECT status, printer_target, printer_error, last_checked
--     FROM printer_status;
--
-- printer_error should be NULL while the printer is reachable, and hold the
-- concrete failure reason when it is not. If printer_error stays NULL while
-- status is 'unknown', the worker is not reporting at all - a different problem
-- from the printer being unreachable.
-- ---------------------------------------------------------------------------