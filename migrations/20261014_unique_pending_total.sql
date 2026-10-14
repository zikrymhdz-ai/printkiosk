-- 20261014_unique_pending_total.sql
-- Stop two pending jobs ever sharing a payment amount again.
--
-- assignUniqueMatchAmount() reads which totals are already taken and the caller
-- then inserts. Those two steps are not atomic, so two uploads about a second
-- apart both saw RM0.29 free and both took it:
--
--   PRN-20261014-D660  member  total 0.29
--   PRN-20261014-55C8  member  total 0.29
--   PRN-20261014-A11D  guest   total 0.29
--   PRN-20261014-679E  guest   total 0.29
--
-- Real money then arrived for RM0.29 and could not be attributed to a job, so
-- both payments were parked for staff review while the customers waited at a
-- kiosk that never printed.
--
-- A partial unique index makes the collision impossible instead of unlikely,
-- and upload.js retries with the next free slot when it hits a conflict.
--
-- Run STEP 1, resolve the leftover jobs by hand, then run STEP 2.

-- ---------------------------------------------------------------------------
-- STEP 1: retire abandoned jobs.
--
-- Anything unpaid, still 'pending', and older than 24 hours can no longer be
-- settled by any payment -- the match window is 60 minutes. Those jobs are
-- leftovers from testing and abandoned uploads, and every one of them is
-- holding a payment slot hostage to the jobs that follow it.
--
-- The 24-hour cutoff is deliberate. An earlier version of this migration used
-- 60 minutes, which would have swept up four jobs that two real RM0.29
-- payments are currently parked against, silently orphaning that money.
-- Do not lower it without checking payment_review_queue first.
-- ---------------------------------------------------------------------------
UPDATE print_jobs
   SET status = 'cancelled',
       print_pin = NULL
 WHERE status = 'pending'
   AND paid = false
   AND created_at < now() - interval '24 hours';

-- ---------------------------------------------------------------------------
-- STEP 2: enforce uniqueness. Run this AFTER clearing any duplicate left over
-- from step 1, otherwise it fails with a duplicate-key error.
--
-- Excluded: zero-price jobs. They are fully covered by coins and are
-- auto-confirmed immediately after insert, so two of them briefly coexist by
-- design and must not count as a collision.
--
-- Remaining duplicates should only be jobs whose money actually arrived.
-- Settle them in Admin > Transactions (Mark Paid on the ones that were paid,
-- Delete the rest) and run this again.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_pending_total_unique
  ON print_jobs (total_price)
  WHERE status = 'pending' AND paid = false AND total_price > 0;
