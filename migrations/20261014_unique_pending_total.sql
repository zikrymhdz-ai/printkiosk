-- 20261014_unique_pending_total.sql
-- Stop two pending jobs ever sharing a payment amount again.
--
-- assignUniqueMatchAmount() reads which totals are already taken and then the
-- caller inserts. That is not atomic, so two uploads about a second apart both
-- saw RM0.29 free and both used it. Four jobs ended up priced identically:
--
--   PRN-20261014-679E  guest   total 0.29
--   PRN-20261014-A11D  guest   total 0.29
--   PRN-20261014-55C8  member  total 0.29
--   PRN-20261014-D660  member  total 0.29
--
-- Real money then arrived for RM0.29 and could not be attributed, so both
-- payments were parked for staff review while the customers waited at a kiosk
-- that never printed.
--
-- A partial unique index makes the collision impossible instead of unlikely.
-- upload.js now retries with the next free slot when it hits a conflict.
--
-- Run the two steps in order. Safe to re-run step 2; step 1 is a one-off.

-- ---------------------------------------------------------------------------
-- STEP 1 (one-off): clear duplicate pending jobs so the index can be created.
--
-- Only jobs older than the 60-minute match window are cancelled. Those can no
-- longer be settled by a matching payment anyway, so leaving them pending just
-- holds a slot forever. Any duplicate created in the last hour is deliberately
-- left alone: it may correspond to real money sitting in the review queue, and
-- only staff can say which.
-- ---------------------------------------------------------------------------
UPDATE print_jobs a
   SET status = 'cancelled',
       print_pin = NULL
  FROM print_jobs b
 WHERE a.status = 'pending'
   AND b.status = 'pending'
   AND a.total_price = b.total_price
   AND a.total_price > 0
   AND a.job_id > b.job_id
   AND a.created_at < now() - interval '60 minutes';

-- ---------------------------------------------------------------------------
-- STEP 2: enforce uniqueness.
--
-- Excluded: zero-price jobs (fully covered by coins). They are auto-confirmed
-- immediately after insert, so two of them briefly coexist by design and must
-- not be treated as a collision.
--
-- If this fails with a duplicate-key error, there is a fresh collision still
-- inside the window. Resolve it in Admin > Transactions (Mark Paid or Delete)
-- and run it again.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_pending_total_unique
  ON print_jobs (total_price)
  WHERE status = 'pending' AND paid = false AND total_price > 0;
