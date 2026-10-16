-- 20261016_printer_status_poll_interval.sql
--
-- The dashboard could tell whether a printer reading was fresh only by
-- hardcoding a guess. admin.html treated anything under 15 minutes as current,
-- while the worker only reported every PRINT_SUPPLY_SECONDS (300 by default).
-- So the two numbers had no relationship: change the interval in the Pi's env
-- file and the dashboard silently starts calling stale readings "fresh", with
-- nothing in the database recording what to expect.
--
-- That is how a reading could sit in admin for 25 hours behind a confident
-- ONLINE badge. The dashboard had no way to know the worker had stopped
-- reporting at all, because "how often should I be hearing from it" was never
-- stored anywhere.
--
-- The worker now reports its own interval with each poll, so freshness is
-- computed from what the worker actually promised rather than a constant
-- baked into the dashboard.
--
-- Safe to re-run.

ALTER TABLE printer_status
  ADD COLUMN IF NOT EXISTS poll_interval integer;

-- A recorded promise with no reading behind it is worse than none, so start
-- NULL and let the first real poll fill it in.
UPDATE printer_status SET poll_interval = NULL WHERE poll_interval IS NULL;

COMMENT ON COLUMN printer_status.poll_interval IS
  'Seconds between the worker''s printer polls, self-reported. Null until the '
  'worker has checked in at least once. Used to decide whether a reading is '
  'stale; never displayed as a supply level.';