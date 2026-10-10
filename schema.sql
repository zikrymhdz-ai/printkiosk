-- Smart 24/7 Printing Kiosk - Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor

-- Disable Row Level Security on all tables (dev environment)
ALTER TABLE IF EXISTS users DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS print_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS coin_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS printer_status DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS alerts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sessions DISABLE ROW LEVEL SECURITY;

-- 1. Users table
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  face_descriptor JSONB,
  pin_code TEXT,
  coins INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Print Jobs table
CREATE TABLE print_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id),
  session_id TEXT,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 1,
  page_spec TEXT,
  selection_mode TEXT NOT NULL DEFAULT 'all',
  color_mode TEXT NOT NULL DEFAULT 'bw' CHECK (color_mode IN ('bw', 'color')),
  paper_size TEXT NOT NULL DEFAULT 'a4' CHECK (paper_size IN ('a4', 'a3')),
  sides TEXT NOT NULL DEFAULT 'single' CHECK (sides IN ('single', 'double')),
  copies INTEGER NOT NULL DEFAULT 1,
  brightness INTEGER DEFAULT 0,
  contrast INTEGER DEFAULT 0,
  crop_mode TEXT DEFAULT 'none',
  finish TEXT DEFAULT 'none',
  total_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  base_price DECIMAL(10,2),
  match_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready_to_print','printing','completed','refund_issued')),
  paid BOOLEAN NOT NULL DEFAULT FALSE,
  payment_ref TEXT,
  print_pin TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Payments table
CREATE TABLE payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  print_job_id UUID REFERENCES print_jobs(id),
  user_id UUID REFERENCES users(id),
  amount DECIMAL(10,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'tng_qr',
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Coin Transactions table
CREATE TABLE coin_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  print_job_id UUID REFERENCES print_jobs(id),
  type TEXT NOT NULL CHECK (type IN ('earned','spent','bonus')),
  amount INTEGER NOT NULL,
  description TEXT,
  balance_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Printer Status table
CREATE TABLE printer_status (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  paper_level INTEGER NOT NULL DEFAULT 100 CHECK (paper_level >= 0 AND paper_level <= 100),
  toner_black INTEGER NOT NULL DEFAULT 100 CHECK (toner_black >= 0 AND toner_black <= 100),
  toner_cyan INTEGER NOT NULL DEFAULT 100 CHECK (toner_cyan >= 0 AND toner_cyan <= 100),
  toner_magenta INTEGER NOT NULL DEFAULT 100 CHECK (toner_magenta >= 0 AND toner_magenta <= 100),
  toner_yellow INTEGER NOT NULL DEFAULT 100 CHECK (toner_yellow >= 0 AND toner_yellow <= 100),
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','offline','jam_minor','jam_major')),
  jam_type TEXT,
  last_checked TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Alerts table
CREATE TABLE alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('paper_low','toner_low','paper_jam','print_complete','payment_received')),
  message TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Sessions table
CREATE TABLE sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_token TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_print_jobs_user_id ON print_jobs(user_id);
CREATE INDEX idx_print_jobs_status ON print_jobs(status);
CREATE INDEX idx_print_jobs_job_id ON print_jobs(job_id);
CREATE INDEX idx_payments_print_job_id ON payments(print_job_id);
CREATE INDEX idx_coin_transactions_user_id ON coin_transactions(user_id);
CREATE INDEX idx_sessions_token ON sessions(session_token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_alerts_is_read ON alerts(is_read);

-- Migration: Add columns if upgrading existing database
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN ('paper_low','toner_low','paper_jam','print_complete','payment_received','user_report'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS face_images JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_pin TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pin_expires_at TIMESTAMPTZ;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS crop_x DECIMAL(6,4) DEFAULT 0;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS crop_y DECIMAL(6,4) DEFAULT 0;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS crop_w DECIMAL(6,4) DEFAULT 1;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS crop_h DECIMAL(6,4) DEFAULT 1;

-- Insert default admin user (password: admin123)
INSERT INTO users (name, email, password_hash, role, coins, pin_code)
VALUES ('Admin', 'printkiosk.sender@gmail.com', '$2y$10$mxHDrdm.fwwLIgSPXlQa9ecZZyADCmvYfitVJ5vcYn7ZxAHYM6iIu', 'admin', 0, '0000');

-- Insert initial printer status
INSERT INTO printer_status (paper_level, toner_black, toner_cyan, toner_magenta, toner_yellow, status)
VALUES (100, 100, 100, 100, 100, 'online');
