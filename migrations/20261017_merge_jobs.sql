-- 20261017_merge_jobs.sql
-- When several uploaded files are merged into ONE print job, keep a record of
-- which original job rows were combined, so the kiosk and audit can trace a
-- merged document back to its sources.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS origin_job_ids JSONB NULL;

-- Index so the dashboard can list merged jobs and their parts quickly.
CREATE INDEX IF NOT EXISTS print_jobs_origin_job_ids_idx
  ON print_jobs USING GIN (origin_job_ids);

-- After deploying, confirm:
--   SELECT job_id, origin_job_ids, total_price, status FROM print_jobs
--    WHERE origin_job_ids IS NOT NULL;
