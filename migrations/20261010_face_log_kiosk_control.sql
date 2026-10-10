-- Migration: kiosk face-detection audit log + remote kiosk control
-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.

-- 1) Every face scan seen by the kiosk is recorded here (matched or unknown).
CREATE TABLE IF NOT EXISTS face_detections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  confidence DOUBLE PRECISION,
  kiosk_id TEXT DEFAULT 'kiosk-1',
  source TEXT DEFAULT 'kiosk',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS face_detections_created_at_idx
  ON face_detections (created_at DESC);

-- 2) Single-row table the admin uses to control the kiosk remotely.
CREATE TABLE IF NOT EXISTS kiosk_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  face_login_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_message TEXT DEFAULT 'Kiosk temporarily unavailable for maintenance. Please see staff.',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO kiosk_settings (id) VALUES ('default')
  ON CONFLICT (id) DO NOTHING;