-- 20261104_kiosk_live_frames.sql
--
-- Live camera on the admin overview.
--
-- The Pi has no inbound ports and Netlify is serverless, so there is no socket
-- to stream over. Instead the kiosk posts a small JPEG every ~1.5s and the
-- dashboard reads the newest one: a still frame repeating faster than the eye
-- reads as live, and - the part a video feed would make hard - every frame is
-- already a file the admin can download.
--
-- Retention is deliberately short. These are pictures of customers, so the
-- table only ever holds the last few minutes; the backend prunes on write.
--
-- Run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS kiosk_frames (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id TEXT NOT NULL DEFAULT 'kiosk-1',
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kiosk_frames_created_at_idx
  ON kiosk_frames (created_at DESC);

-- The switch that tells the kiosk to publish frames at all. Off by default:
-- a camera that starts broadcasting because a page was deployed is not a
-- decision a deploy should make.
ALTER TABLE kiosk_settings
  ADD COLUMN IF NOT EXISTS camera_stream_enabled BOOLEAN DEFAULT false;
