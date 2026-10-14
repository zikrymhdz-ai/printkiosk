-- 20261014_print_lifecycle.sql
-- Customer-triggered printing lifecycle.
--
-- Design: the printer NEVER prints on its own. A job only reaches the
-- worker after the customer taps "Done / Collect" at the kiosk, which
-- moves it ready_to_print -> print_requested.
--
-- Safe to re-run.

-- 1. Widen the status CHECK constraint so the new states are allowed.
--    (Only these values were in use before: pending, ready_to_print,
--     printing, completed, refund_issued.)
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;

ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_status_check CHECK (
    status IN (
      'pending',          -- created, awaiting payment
      'ready_to_print',   -- PAID, waiting for the customer to choose/collect
      'print_requested',  -- customer clicked collect -> worker will print this
      'printing',         -- worker claimed it; job is at the printer
      'completed',        -- printed successfully
      'failed',           -- worker gave up; needs a staff member
      'superseded',       -- test data / voided; will never print
      'refund_issued',
      'cancelled'
    )
  );

-- 2. Lifecycle timestamps and diagnostics
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_requested_at   timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_claimed_at     timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_started_at     timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_completed_at   timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_error          text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_attempts       integer NOT NULL DEFAULT 0;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_by             text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_page_verified  boolean;

-- 3. Partial index: the worker only ever polls for 'print_requested',
--    so this stays tiny no matter how many old jobs accumulate.
CREATE INDEX IF NOT EXISTS print_jobs_print_requested_idx
  ON print_jobs (print_requested_at)
  WHERE status = 'print_requested';

-- 4. Partial index for the stuck-job watchdog.
CREATE INDEX IF NOT EXISTS print_jobs_printing_idx
  ON print_jobs (print_claimed_at)
  WHERE status = 'printing';

-- 5. Normalise any pre-existing rows so nothing fires unexpectedly.
UPDATE print_jobs
   SET print_attempts = 0
 WHERE print_attempts IS NULL;