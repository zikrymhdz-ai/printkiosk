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
-- printer_target records the CUPS queue the worker is pointed at.
--
-- It is deliberately NOT seeded with 'Brother'. There are two Brother printers
-- on this network (HL-L3240CDW and DCP-T430W), so the brand identifies
-- neither, and writing it would look like a real answer while meaning nothing.
-- Leaving it NULL is honest: the worker fills it in from the queue it actually
-- uses, and alongside it reports the model string the printer itself returns
-- over IPP, which is the only unambiguous identity available.
--
-- printer_model / printer_uri are the fields worth reading on a dashboard:
-- which device is answering, and at what address.
ALTER TABLE printer_status
  ADD COLUMN IF NOT EXISTS printer_error  text,
  ADD COLUMN IF NOT EXISTS printer_target text,
  ADD COLUMN IF NOT EXISTS printer_model  text,
  ADD COLUMN IF NOT EXISTS printer_uri    text;

-- ---------------------------------------------------------------------------
-- After the next supply poll, verify identity and reason are being kept:
--
--   SELECT status, printer_model, printer_uri, printer_target, printer_error,
--          last_checked
--     FROM printer_status;
--
-- printer_model should be the real model string the printer reported, e.g.
-- "Brother HL-L3240CDW series". If it reads DCP-T430W, the worker is pointed at
-- the wrong machine and will say so via printer_error rather than reporting its
-- supplies as ours.
--
-- printer_error should be NULL while the printer is reachable, and hold the
-- concrete failure reason when it is not. If printer_error stays NULL while
-- status is 'unknown', the worker is not reporting at all - a different problem
-- from the printer being unreachable.
-- ---------------------------------------------------------------------------