-- 20261028_push_subscriptions.sql
-- Web Push subscriptions (one row per browser/device endpoint).
--
-- The endpoint is unique on its own: each browser install gets exactly one
-- push endpoint, and re-enabling must update that row rather than add another.
-- user_id still scopes reads/deletes so one account cannot touch another's
-- device.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions (user_id);

-- Matches the rest of this dev-stage schema, where RLS is disabled and the
-- service key is used only from Netlify Functions.
ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;

-- After running, confirm:
--   SELECT user_id, count(*) FROM push_subscriptions GROUP BY user_id;
