-- 20261016_print_cleared_at.sql
--
-- Deleting a job from "My Print Jobs" did not delete it. Clearing marks the row
-- completed and nulls its PIN, which is indistinguishable from a job that really
-- did print - so the customer's own list, which is served by get-all-jobs
-- precisely so they can see finished work, handed the cleared job straight back.
-- Press Delete selected, watch the row stay, and conclude nothing was deleted.
--
-- get-jobs already hid it, because that query excludes completed. The list the
-- customer actually reads is get-all-jobs, and it has no way to tell a cleared
-- job from a printed one.
--
-- This records the distinction explicitly, so both queries can act on it. Staff
-- still see everything in admin: a cleared job is evidence, not something to
-- erase, and the watcher still needs to see the payment that may be in flight.
--
-- Safe to re-run.

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

COMMENT ON COLUMN print_jobs.cleared_at IS
  'When the customer cleared this job from their own list. Set only by an '
  'explicit clear, never by printing. Lets get-jobs and get-all-jobs hide it '
  'from the customer while admin and the watcher keep seeing it.';