-- Migration: kiosk heartbeat so the admin page can see live screen state
-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS kiosk_heartbeats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  kiosk_id TEXT DEFAULT 'kiosk-1',
  app_version TEXT,
  state TEXT,
  detail TEXT,
  last_log TEXT,
  face_lib BOOLEAN NOT NULL DEFAULT FALSE,
  camera BOOLEAN NOT NULL DEFAULT FALSE,
  camera_size TEXT,
  models_loaded BOOLEAN NOT NULL DEFAULT FALSE,
  cam_label TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kiosk_heartbeats_seen_at_idx
  ON kiosk_heartbeats (seen_at DESC);