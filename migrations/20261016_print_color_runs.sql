-- 20261016_print_color_runs.sql
--
-- A merged print job can hold colour and black-and-white pages together: a
-- customer who uploads one colour PDF and one B&W PDF now gets ONE document
-- rather than two. The price was already split per page from the request, so
-- they were charged correctly.
--
-- The PRINT was not. A combined job is submitted to CUPS as a single lp call
-- with one -o ColorModel, and the worker had only the job's overall color_mode,
-- which is 'color' whenever any page wanted colour. So the black-and-white pages
-- were printed in colour too.
--
-- color_pages is a COUNT, and a count cannot say which pages are greyscale -
-- which is the only thing that would let the worker print them that way. This
-- stores the LAYOUT instead: an ordered list of runs, in page order, each saying
-- which pages belong to one member file and whether that member wanted colour.
-- The worker turns that into one lp call per colour run with -o page-ranges,
-- so each group of pages is printed in its own mode with no rasterising and no
-- loss of vector quality.
--
-- NULL for any job that is a single colour mode, which is every job before
-- mixed-colour merging existed and every photo-only job.
--
-- Safe to re-run.

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_runs text;

COMMENT ON COLUMN print_jobs.color_runs IS
  'JSON array of {from,to,color} in page order, for a merged job holding more '
  'than one colour mode. Null when the whole document prints in one mode. Drives '
  'how the worker splits the job into per-colour CUPS submissions; never used for '
  'pricing, which is computed from the request.';