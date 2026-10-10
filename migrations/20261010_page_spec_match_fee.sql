-- Migration: page-range selection + unique payment-match amount
-- Run once in Supabase Dashboard -> SQL Editor.
-- Safe to re-run (IF NOT EXISTS guards).

-- 1) Which pages the customer asked to print (e.g. '1,3,5' or '1-4' or 'all')
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS page_spec TEXT;

-- 2) Price before any coin discount (the printable amount)
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS base_price DECIMAL(10,2);

-- 3) Extra few sen added so two same-priced jobs never share a payable amount
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS match_fee DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Backfill existing rows: treat current total_price as the base, fee 0
UPDATE print_jobs
   SET base_price = total_price
 WHERE base_price IS NULL;

-- Record which page-selection scheme produced these rows
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS selection_mode TEXT NOT NULL DEFAULT 'all';