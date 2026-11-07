-- 20261101_face_snapshot.sql
-- The kiosk records a snapshot for unknown captures as well as matched ones, so
-- the admin can see who stood at the camera instead of only reading "Unknown".
--
-- The column was introduced by 20261010_face_log_kiosk_control.sql. This
-- re-asserts it, so a database that was created by an earlier version of that
-- migration still stores pictures rather than silently dropping them (the
-- backend falls back to a picture-less row when the column is missing).

ALTER TABLE face_detections
  ADD COLUMN IF NOT EXISTS face_snapshot TEXT;
