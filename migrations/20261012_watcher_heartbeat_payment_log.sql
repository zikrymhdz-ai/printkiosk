SELECT
  'EXISTS'  AS status, 'watcher_heartbeats'   AS table_name, '' AS note
WHERE to_regclass('public.watcher_heartbeats') IS NOT NULL
UNION ALL
SELECT 'EXISTS', 'payment_log', ''
WHERE to_regclass('public.payment_log') IS NOT NULL
UNION ALL
SELECT 'EXISTS', 'payment_review_queue', ''
WHERE to_regclass('public.payment_review_queue') IS NOT NULL;

-- ============ PART 2 - create anything missing ============
-- Statements are idempotent (IF NOT EXISTS), so re-running is harmless.

CREATE TABLE IF NOT EXISTS public.watcher_heartbeats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  watcher_id TEXT DEFAULT 'watcher-1',
  app_version TEXT,
  listening BOOLEAN NOT NULL DEFAULT FALSE,
  access_granted BOOLEAN NOT NULL DEFAULT FALSE,
  notifications_seen INTEGER NOT NULL DEFAULT 0,
  payments_matched INTEGER NOT NULL DEFAULT 0,
  queued_pending INTEGER NOT NULL DEFAULT 0,
  last_post TEXT,
  detail TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS watcher_heartbeats_seen_at_idx
  ON public.watcher_heartbeats (seen_at DESC);

CREATE TABLE IF NOT EXISTS public.payment_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_name TEXT,
  title TEXT,
  raw_text TEXT,
  gate_text TEXT,
  amount NUMERIC,
  amount_raw TEXT,
  reference TEXT,
  incoming BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'seen',
  job_id TEXT,
  detail TEXT,
  client_ref TEXT,
  posted_at TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_log_seen_at_idx
  ON public.payment_log (seen_at DESC);
CREATE INDEX IF NOT EXISTS payment_log_status_idx
  ON public.payment_log (status);

-- Retried notifications must not create duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS payment_log_client_ref_unique
  ON public.payment_log (client_ref)
  WHERE client_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.payment_review_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  amount NUMERIC,
  amount_raw TEXT,
  payer_name TEXT,
  reference TEXT,
  raw_text TEXT,
  candidate_jobs TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_job TEXT,
  resolved_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payment_review_status_idx
  ON public.payment_review_queue (status, created_at DESC);

-- ============ PART 3 - proof it worked ============
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('watcher_heartbeats','payment_log','payment_review_queue'))
    AS created,
  (SELECT count(*) FROM public.watcher_heartbeats)   AS watcher_rows,
  (SELECT count(*) FROM public.payment_log)          AS log_rows,
  (SELECT count(*) FROM public.payment_review_queue) AS review_rows,
  current_database() AS project_db;
