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
-- Run the steps in order. Step 3 fails until step 2 has cleared every
-- duplicate, which is the point of doing it in this order.

-- ---------------------------------------------------------------------------
-- STEP 1: retire genuinely abandoned jobs.
--
-- Unpaid, still 'pending', and older than 24 hours. The match window is 60
-- minutes, so nothing older than that can ever be settled by a payment. These
-- are leftovers from testing and abandoned uploads, and every one of them is
-- holding a payment slot hostage to the jobs that follow it.
--
-- The 24-hour cutoff is deliberate. An earlier version used 60 minutes, which
-- would have swept up four jobs that two real RM0.29 payments are parked
-- against, silently orphaning that money. Do not lower it without checking
-- payment_review_queue first.
-- ---------------------------------------------------------------------------
UPDATE print_jobs
   SET status = 'cancelled',
       print_pin = NULL
 WHERE status = 'pending'
   AND paid = false
   AND created_at < now() - interval '24 hours';

-- ---------------------------------------------------------------------------
-- STEP 2: clear the duplicates that step 1 deliberately left alone.
--
-- After step 1 the outstanding conflicts are:
--
--   RM 0.20 x2   PRN-20261014-7238 (member, 151 min)
--                PRN-20261014-53C2 (guest,   22 min)
--   RM 0.29 x4   PRN-20261014-D660  member
--                PRN-20261014-55C8  member
--                PRN-20261014-A11D  guest
--                PRN-20261014-679E  guest
--
-- RM 0.20 -- 7238 is 151 minutes old and unpaid, so it is outside the match
-- window and cannot be claimed by any payment. Safe to retire. 53C2 is only
-- 22 minutes old and may still be paid, so it stays; cancelling only 7238
-- leaves a single 0.20 job and no conflict.
--
-- RM 0.29 -- TWO REAL PAYMENTS ARE PARKED IN payment_review_queue AGAINST FOUR
-- UNPAID JOBS. This is ambiguous on purpose: there is no way to tell from the
-- database which two jobs the money belongs to, and guessing would either
-- orphan RM0.29 or print the wrong customer's document. This step is left
-- commented out because it is a business decision, not a migration.
--
-- Settle these in Admin > Transactions (Mark Paid the two that were actually
-- paid, Delete the other two), or reply with which two job IDs were paid and
-- let the cleanup be scripted. Only then run step 3.
-- ---------------------------------------------------------------------------

-- Safe, no money attached, outside the match window:
-- UPDATE print_jobs SET status = 'cancelled', print_pin = NULL
--  WHERE job_id = 'PRN-20261014-7238' AND status = 'pending' AND paid = false;

-- Requires a decision first -- see above:
-- UPDATE print_jobs SET status = 'cancelled', print_pin = NULL
--  WHERE job_id IN ('PRN-20261014-XXXX','PRN-20261014-YYYY')
--    AND status = 'pending' AND paid = false;

-- Confirm nothing is left before continuing:
--   SELECT total_price, count(*), array_agg(job_id ORDER BY created_at)
--     FROM print_jobs
--    WHERE status = 'pending' AND paid = false AND total_price > 0
--    GROUP BY total_price HAVING count(*) > 1;
-- Expect zero rows.

-- ---------------------------------------------------------------------------
-- STEP 3: enforce uniqueness.
--
-- Excluded: zero-price jobs. They are fully covered by coins and are
-- auto-confirmed immediately after insert, so two of them briefly coexist by
-- design and must not count as a collision.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_pending_total_unique
  ON print_jobs (total_price)
  WHERE status = 'pending' AND paid = false AND total_price > 0;

-- If this still fails with a duplicate-key error, run the verification query
-- above: there is another duplicate group that has not been listed here.