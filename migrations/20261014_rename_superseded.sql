-- 20261014_rename_superseded.sql
-- "superseded" was an internal placeholder meaning "voided, will never print".
-- It leaked into customer-facing screens as a word nobody understands, and it
-- was missing from the customer's visible-status list, so paid jobs simply
-- vanished from their history instead of showing an explanation.
--
-- Renamed to "cancelled": standard, plain, and honest about the consequence.
-- Safe to re-run.

-- 1. Move any existing rows.
UPDATE print_jobs SET status = 'cancelled' WHERE status = 'superseded';

-- 2. Drop the old value from the allowed set so it cannot come back.
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_status_check CHECK (
    status IN (
      'pending',          -- created, awaiting payment
      'ready_to_print',   -- PAID, waiting for the customer to choose/collect
      'print_requested',  -- customer tapped collect -> worker will print this
      'printing',         -- worker claimed it; job is at the printer
      'completed',        -- printed successfully
      'failed',           -- worker gave up; needs a staff member
      'cancelled',        -- will not print (was 'superseded')
      'refund_issued',
      'partially_completed'
    )
  );

-- 3. Voided jobs must not keep a live PIN. lookup-pin only excluded
-- 'completed' and 'refund_issued', so every PIN on a cancelled job still
-- resolved at the kiosk and walked the customer into a dead end.
UPDATE print_jobs SET print_pin = NULL WHERE status = 'cancelled';
