-- 20261014_paper_remaining.sql
-- Make "paper left" a derived fact instead of a hand-typed number.
--
-- The problem: printer_status.paper_level was never measured. Nothing in
-- print-worker.py queries paper, because there is no standard IPP attribute
-- for "sheets remaining in the tray" -- most drivers only report which trays
-- are loaded. The only writer was the admin set-levels override, so the value
-- 50 sitting in the table was typed by a person, and the customer-facing
-- "Paper tray" bar was displaying it as though the printer had reported it.
--
-- The approach: count what actually came out of the tray.
--
--   remaining = paper_capacity - SUM(pages * copies)
--               over jobs completed since the last refill
--
-- pages and copies already exist on print_jobs, and print_completed_at is set
-- by the worker only when CUPS confirms the job reached 'completed', so this
-- counts real paper. Deriving it on read instead of decrementing a stored
-- counter means it cannot drift out of sync with reality: if a job is deleted
-- or a reprint is voided, the number corrects itself.
--
-- It is still an ESTIMATE, not a sensor. Two known causes of drift:
--   - a jammed or cancelled sheet may leave the tray without a completed job
--   - duplex/manual-feed paper is not counted at all
-- So it is deliberately stored alongside paper_derived so the UI can be honest
-- about what the number is.

-- Capacity of the main tray in A4. The HL-L3240CDW takes 250 sheets; override
-- per machine if you fit a different tray.
ALTER TABLE printer_status
  ADD COLUMN IF NOT EXISTS paper_capacity  integer NOT NULL DEFAULT 250,
  ADD COLUMN IF NOT EXISTS paper_refilled_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS paper_derived    boolean NOT NULL DEFAULT true;

-- Live stop reason reported by CUPS (Paper jam, Out of paper, Printer stopped).
-- printer_alert() already parses these, but only used them at submit time and
-- after an abort, so the kiosk never showed them.
ALTER TABLE printer_status
  ADD COLUMN IF NOT EXISTS printer_alert text;

-- Start from a full tray rather than inheriting the invented 50%.
UPDATE printer_status
   SET paper_capacity   = 250,
       paper_refilled_at = now(),
       paper_level      = 100
 WHERE paper_level IS NULL OR paper_level <> 100;

-- ---------------------------------------------------------------------------
-- Verify. Expect 250 - (pages printed since the refill marker) and the total
-- should agree with the kiosk's "sheets left".
--
--   SELECT p.paper_capacity,
--          p.paper_refilled_at,
--          COALESCE(SUM(j.pages * j.copies), 0) AS used,
--          p.paper_capacity - COALESCE(SUM(j.pages * j.copies), 0) AS remaining
--     FROM printer_status p
--     LEFT JOIN print_jobs j
--       ON j.status = 'completed'
--      AND j.print_completed_at > p.paper_refilled_at
--    GROUP BY p.paper_capacity, p.paper_refilled_at;
-- ---------------------------------------------------------------------------