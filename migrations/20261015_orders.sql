-- 20261015_orders.sql
-- Give a multi-file upload a real identity, so one payment can be attributed to
-- the whole order.
--
-- The problem this solves. Uploading N files created N separate print_jobs, but
-- the customer pays ONCE for the combined total. Matching compared the payment
-- against a single job's total_price, so a two-file order of RM0.41 + RM1.11 =
-- RM1.52 matched no job at all and was reported "no_match": the customer paid
-- and received no PIN.
--
-- A subset search was added as a workaround, but it was unreliable:
--   - session_id is generated fresh per job, so a guest's files were never
--     recognised as belonging to one order and could never be combined
--   - it needed a 5-file cap purely to bound the combinatorics, so orders of
--     6+ files failed anyway
--   - two different combinations can sum to the same amount, which is
--     unresolvable without guessing
--
-- order_id is the fix. Every file in one upload batch is stamped with the same
-- order_id, and order_total records exactly what the customer must pay for the
-- whole order. Matching then becomes an equality test on order_total: no search,
-- no ambiguity, no cap, and it works the same for guests and members.
--
-- order_total is NOT simply the sum of the job totals. Two different orders
-- could coincidentally sum to the same amount, so after summing, a small unique
-- offset is added to make the order total distinct among live unpaid orders --
-- the same trick already used per job, applied one level up.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS order_id   text,
  ADD COLUMN IF NOT EXISTS order_total numeric;

-- Matching looks up orders by their total, so that needs an index.
CREATE INDEX IF NOT EXISTS print_jobs_order_total_idx
  ON print_jobs (order_total)
  WHERE order_total IS NOT NULL;

-- Fetches every file in an order when settling it.
CREATE INDEX IF NOT EXISTS print_jobs_order_id_idx
  ON print_jobs (order_id)
  WHERE order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Jobs created before this migration have no order_id and are treated as
-- single-file orders in their own right, so existing single-file payments keep
-- matching with no backfill.
--
-- After deploying, confirm a fresh multi-file order:
--
--   SELECT order_id, count(*), min(order_total) AS total, array_agg(status)
--     FROM print_jobs
--    WHERE order_id IS NOT NULL
--    GROUP BY order_id;
--
-- Every row of an order should share one order_id and one order_total, and the
-- total should equal what the customer was told to pay.
-- ---------------------------------------------------------------------------