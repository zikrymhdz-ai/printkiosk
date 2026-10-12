-- Migration: payment watcher liveness + full notification log
-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.
--
-- Why: the watcher is the only thing that can turn a real DuitNow payment into a
-- confirmed print job. If it silently dies (Android revoking notification access,
-- the listener being unbound, the phone losing internet) payments are still taken
-- at the counter but never auto-confirmed, so staff find out far too late.
-- watcher_heartbeats lets admin prove the app is alive; payment_log records EVERY
-- watched notification, matched or not, so the real TnG wording can be inspected
-- and the parser corrected against evidence instead of guesses.

-- ---------- 1. Watcher liveness ----------
CREATE TABLE IF NOT EXISTS watcher_heartbeats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  watcher_id TEXT DEFAULT 'watcher-1',
  app_version TEXT,
  -- true once NotificationListenerService.onListenerConnected has fired
  listening BOOLEAN NOT NULL DEFAULT FALSE,
  -- true when Android still lists this package as an allowed listener
  access_granted BOOLEAN NOT NULL DEFAULT FALSE,
  -- counts of what the app has done since boot / since the last flush
  notifications_seen INTEGER NOT NULL DEFAULT 0,
  payments_matched INTEGER NOT NULL DEFAULT 0,
  -- how many notifications are waiting in the offline retry queue
  queued_pending INTEGER NOT NULL DEFAULT 0,
  -- last HTTP outcome, e.g. 'ok', '401 invalid signature', 'network'
  last_post TEXT,
  detail TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS watcher_heartbeats_seen_at_idx
  ON watcher_heartbeats (seen_at DESC);

-- ---------- 2. Every watched notification ----------
CREATE TABLE IF NOT EXISTS payment_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_name TEXT,
  title TEXT,
  -- full combined notification text, exactly as the app read it
  raw_text TEXT,
  -- the subset used for the money-in decision (no decoration lines)
  gate_text TEXT,
  amount NUMERIC,
  -- the exact amount string that was signed, for auditing
  amount_raw TEXT,
  reference TEXT,
  -- did isIncomingPayment() accept it?
  incoming BOOLEAN NOT NULL DEFAULT FALSE,
  -- what the app decided to do with it
  status TEXT NOT NULL DEFAULT 'seen',
  -- which job it ended up confirming, when it did
  job_id TEXT,
  -- why it was rejected / failed, for the admin to act on
  detail TEXT,
  -- client-generated id so a retried notification cannot double-insert
  client_ref TEXT,
  posted_at TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_log_seen_at_idx
  ON payment_log (seen_at DESC);
CREATE INDEX IF NOT EXISTS payment_log_client_ref_idx
  ON payment_log (client_ref);
CREATE INDEX IF NOT EXISTS payment_log_status_idx
  ON payment_log (status);

-- The retry queue can deliver the same notification twice (response lost, app
-- killed mid-request). Reject the duplicate rather than logging it twice.
ALTER TABLE payment_log DROP CONSTRAINT IF EXISTS payment_log_client_ref_key;
CREATE UNIQUE INDEX IF NOT EXISTS payment_log_client_ref_unique
  ON payment_log (client_ref) WHERE client_ref IS NOT NULL;

-- ---------- 3. Manual confirmation queue ----------
-- When auto-matching is ambiguous the payment is parked here for staff instead of
-- being force-matched onto the newest job (which would release the wrong
-- customer's document).
CREATE TABLE IF NOT EXISTS payment_review_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  amount NUMERIC,
  amount_raw TEXT,
  payer_name TEXT,
  reference TEXT,
  raw_text TEXT,
  -- comma separated job_id list that matched, for the staff member to choose from
  candidate_jobs TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_job TEXT,
  resolved_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payment_review_status_idx
  ON payment_review_queue (status, created_at DESC);