const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ninsrrallzwmkqyosqeu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pbnNycmFsbHp3bWtxeW9zcWV1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Mzg2MDk1MiwiZXhwIjoyMDk5NDM2OTUyfQ.JabQJz9kRWtZqY7FVJD14yOaKT0phfXTQekGUzYe5ZA';
const SUPABASE_REST_URL = SUPABASE_URL + '/rest/v1';

const SESSION_DURATION = 86400 * 7;

// How long a pending print job can still be matched to a payment by the watcher.
// Ten minutes is long enough for a customer to upload, pick a payment method and
// complete a transfer, and short enough that abandoned jobs stop squatting on the
// unique match-amount slots.
const JOB_PAYABLE_WINDOW_MIN = 10;

// Shared secret between the PrintKiosk Payment Watcher APK and this backend,
// used to sign server-side "payment detected" events (HMAC-SHA256).
const NOTIFICATION_SECRET = process.env.NOTIFICATION_SECRET || 'pk_notif_v3_fd3877b903677547e567f1d1f0cc68770df89598a5c7d09fe229d81d8dc4d37c';

// Shared secret between the Pi print worker and this backend. Deliberately has
// NO hardcoded fallback: a secret committed to git is how the watcher secret
// leaked before. If this is empty the worker endpoints refuse every request.
const PRINT_WORKER_SECRET = process.env.PRINT_WORKER_SECRET || '';

const PRICE_BW_PER_PAGE = 0.20;
const PRICE_COLOR_PER_PAGE = 1.10;
const PRICE_A3_MULTIPLIER = 2.0;
const PRICE_DOUBLE_SIDED_MULTIPLIER = 0.7;

// Bumped whenever the kiosk front-end changes. The kiosk compares this against
// the version it was loaded with and reloads itself, so an unattended screen
// never keeps running a stale copy of walkin.html.
const APP_VERSION = '2026.10.14-73';

const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || 'printkiosk.sender@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS || 'vewuljgrgldslwwv';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'PrintKiosk';
const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_CODE_TTL = 600;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token',
    'Content-Type': 'application/json'
  };
}

function json(data, statusCode = 200) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(data)
  };
}

function err(message, statusCode = 400) {
  return json({ error: message }, statusCode);
}

async function supabaseRequest(method, endpoint, data = null, params = {}) {
  let url = SUPABASE_REST_URL + endpoint;
  if (Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    url += '?' + qs;
  }

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const options = { method, headers };
  if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { parsed = text; }

    if (!response.ok) {
      const msg = (parsed && typeof parsed === 'object')
        ? (parsed.message || parsed.error || JSON.stringify(parsed))
        : (parsed || 'Unknown error');
      return { error: true, message: msg, http_code: response.status, data: parsed };
    }

    return { error: false, data: parsed, http_code: response.status };
  } catch (e) {
    return { error: true, message: e.message, http_code: 0 };
  }
}

function generateJobId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'PRN-' + date + '-' + rand;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateVerificationCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(VERIFICATION_CODE_LENGTH, '0');
}

function isValidGmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@gmail\.com$/i.test(email);
}

function isValidMalaysianPhone(phone) {
  const p = String(phone).replace(/[\s\-]/g, '');
  return /^(?:\+?60|0)?1[0-9]{8,9}$/.test(p);
}

function normalizePhone(phone) {
  const p = String(phone).replace(/[\s\-]/g, '');
  let m = p.match(/^0(1[0-9]{8,9})$/);
  if (m) return '+60' + m[1];
  m = p.match(/^(60)(1[0-9]{8,9})$/);
  if (m) return '+' + m[1] + m[2];
  m = p.match(/^\+?(6?0)?(1[0-9]{8,9})$/);
  if (m) return '+60' + m[2];
  return p;
}

// Minimal SMTP client (no dependencies) - sends via Gmail SMTP with STARTTLS
function smtpSend(to, subject, htmlBody) {
  return new Promise((resolve) => {
    if (!SMTP_USER || !SMTP_PASS) return resolve(false);

    const net = require('net');
    const tls = require('tls');

    const sock = net.connect(SMTP_PORT, SMTP_HOST);
    let conn = sock;
    let buffer = '';
    let queue = [];
    let settled = false;

    function done(result) {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      resolve(result);
    }

    function pump() {
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.trim() === '') continue;
        const next = queue.shift();
        if (next) next(line);
      }
    }

    function onData(d) { buffer += d.toString(); pump(); }

    sock.on('data', onData);
    sock.on('error', () => done(false));

    const TIMEOUT = 20000;

    // Write cmd and collect the full reply. Handles multi-line ("NNN-")
    // replies like EHLO by only ending when a line matches "NNN ".
    function exchange(cmd) {
      return new Promise((res) => {
        let reply = '';
        const timer = setTimeout(() => { done(false); res(''); }, TIMEOUT);
        const collect = (line) => {
          reply += line + '\n';
          if (/^[0-9]{3} /.test(line)) {
            clearTimeout(timer);
            res(reply.trim());
          } else {
            queue.unshift(collect);
          }
        };
        queue.unshift(collect);
        if (cmd) conn.write(cmd + '\r\n');
      });
    }

    async function run() {
      try {
        let r = await exchange('');

        r = await exchange('EHLO localhost');
        if (!/^250/.test(r)) return done(false);

        r = await exchange('STARTTLS');
        if (!/^220/.test(r)) return done(false);

        const secure = await new Promise((res, rej) => {
          const s = tls.connect({ socket: sock, servername: SMTP_HOST });
          s.once('secureConnect', () => res(s));
          s.once('error', rej);
        });
        secure.on('error', () => done(false));

        sock.removeListener('data', onData);
        conn = secure;
        secure.on('data', onData);

        r = await exchange('EHLO localhost');
        if (!/^250/.test(r)) return done(false);

        r = await exchange('AUTH PLAIN ' + Buffer.from('\0' + SMTP_USER + '\0' + SMTP_PASS).toString('base64'));
        if (!/^235\b/.test(r)) return done(false);

        r = await exchange('MAIL FROM:<' + SMTP_USER + '>');
        if (!/^250/.test(r)) return done(false);

        r = await exchange('RCPT TO:<' + to + '>');
        if (!/^250/.test(r)) return done(false);

        r = await exchange('DATA');
        if (!/^354/.test(r)) return done(false);

        const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ');
        const headers = 'From: ' + SMTP_FROM_NAME + ' <' + SMTP_USER + '>\r\n'
          + 'To: ' + to + '\r\n'
          + 'Subject: ' + cleanSubject + '\r\n'
          + 'MIME-Version: 1.0\r\n'
          + 'Content-Type: text/html; charset=UTF-8\r\n'
          + 'Date: ' + new Date().toUTCString() + '\r\n';

        const bodyData = String(htmlBody).replace(/\r\n\./g, '\r\n..').replace(/\n/g, '\r\n');
        r = await exchange(headers + '\r\n' + bodyData + '\r\n.');
        if (!/^250/.test(r)) return done(false);

        await exchange('QUIT');
        done(true);
      } catch (e) {
        done(false);
      }
    }

    run();
  });
}

async function sendVerificationEmail(to, code, name) {
  const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;">'
    + '<h2 style="color:#0f172a;margin:0 0 8px;">Verify your email</h2>'
    + '<p style="color:#475569;font-size:14px;">Hi ' + String(name).replace(/[<>&]/g, '') + ',</p>'
    + '<p style="color:#475569;font-size:14px;line-height:1.6;">Use the code below to complete your PrintKiosk registration. This code expires in 10 minutes.</p>'
    + '<div style="text-align:center;margin:24px 0;">'
    + '<span style="display:inline-block;font-size:28px;font-weight:700;letter-spacing:6px;color:#0f172a;background:#f1f5f9;padding:14px 24px;border-radius:10px;">' + code + '</span>'
    + '</div>'
    + '<p style="color:#94a3b8;font-size:12px;">If you did not request this, you can safely ignore this email.</p>'
    + '</div>';

  return smtpSend(to, 'PrintKiosk - Verify your email', html);
}

async function validateSession(event) {
  const headers = event.headers || {};
  const token = headers['x-session-token'] || headers['X-Session-Token'] || '';

  if (!token) return null;

  const result = await supabaseRequest('GET', '/sessions', null, {
    'session_token': 'eq.' + token,
    'select': '*,users(id,name,email,role,coins)'
  });

  if (result.error || !result.data || result.data.length === 0) return null;

  const session = result.data[0];
  if (new Date(session.expires_at) < new Date()) {
    await supabaseRequest('DELETE', '/sessions', null, { 'session_token': 'eq.' + token });
    return null;
  }

  return session;
}

function calculatePrice(pages, colorMode, paperSize, sides, copies) {
  const pagePrice = colorMode === 'color' ? PRICE_COLOR_PER_PAGE : PRICE_BW_PER_PAGE;
  const sizeMultiplier = paperSize === 'a3' ? PRICE_A3_MULTIPLIER : 1.0;
  const sidesMultiplier = sides === 'double' ? PRICE_DOUBLE_SIDED_MULTIPLIER : 1.0;
  const effectivePages = pages * sidesMultiplier;
  const pricePerCopy = effectivePages * pagePrice * sizeMultiplier;
  const total = pricePerCopy * copies;
  return Math.round(total * 100) / 100;
}

// Payment-watch matching only sees the amount (DuitNow QR carries no job reference).
// If two unpaid jobs have the identical amount, one paying customer's money could
// mark the *other* job paid (free print). We therefore nudge every concurrent
// same-priced job by one cent so each payment maps to exactly one job.
//
// The slots run in blocks of ten, matching how the amounts actually read. For a
// base of RM0.20 the first block is 0.20-0.29 (offset 0-9), the next is
// 0.30-0.39 (offset 10-19), then 0.40-0.49, and so on. Offsets are handed out
// in order, so it is a simple ascending walk.
//
// Previously the walk stopped after ten offsets, so an eleventh concurrent
// same-priced job in the payable window had no slot at all and was handed the
// top one as "crowded" - which collides with the job that legitimately held
// it. That is precisely what produced the queue of identical RM0.29 jobs this
// whole fee scheme exists to prevent.
//
// Only jobs still inside the payable window compete for a slot; abandoned rows
// past it are ignored rather than squatting on one.
const MAX_MATCH_OFFSETS = 50;

// Pick the lowest offset whose total is not already taken. Shared by jobs and
// by orders, so an order total is allocated exactly the way a job total is.
function pickFreeOffset(baseCents, used, maxOffsets) {
  const limit = maxOffsets || MAX_MATCH_OFFSETS;
  for (let k = 0; k < limit; k++) {
    const cents = baseCents + k;
    if (!used.has(cents)) return { offset: k, cents: cents };
  }
  return null;
}

async function assignUniqueMatchAmount(basePrice) {
  const baseCents = Math.round(basePrice * 100);
  if (baseCents <= 0) return { total: 0, fee: 0, base: 0 };

  const cutoff = new Date(Date.now() - JOB_PAYABLE_WINDOW_MIN * 60 * 1000).toISOString();

  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'paid': 'eq.false',
    'status': 'eq.pending',
    'select': 'total_price',
    'created_at': 'gte.' + cutoff,
    'limit': '500'
  });

  const used = new Set();
  if (!result.error && Array.isArray(result.data)) {
    for (const j of result.data) {
      const v = parseFloat(j.total_price);
      if (!Number.isNaN(v)) used.add(Math.round(v * 100));
    }
  }

  const free = pickFreeOffset(baseCents, used);
  if (free) {
    return { total: free.cents / 100, fee: free.offset / 100, base: baseCents / 100 };
  }

  // Every slot is genuinely live. Hand out the top one and let the backend route
  // the payment to staff review rather than silently confirming the newest job,
  // which would release the wrong customer's document.
  return { total: (baseCents + MAX_MATCH_OFFSETS - 1) / 100, fee: (MAX_MATCH_OFFSETS - 1) / 100, base: baseCents / 100, crowded: true };
}

// Orders need the same treatment one level up.
//
// A one-file order is already unique because its job total is, so it keeps that
// figure unchanged. A multi-file order sums to something that is NOT guaranteed
// to be unique: {0.20, 0.30} and {0.50} both total RM0.50, and a payment of
// RM0.50 could then settle either order. So after summing, the lowest free
// offset is added to make the ORDER total distinct among live orders.
//
// usedOrderTotals must contain every order total currently awaiting payment,
// including single-file ones.
function assignUniqueOrderTotal(sumOfJobTotals, usedOrderTotals) {
  const baseCents = Math.round(sumOfJobTotals * 100);
  if (baseCents <= 0) return { total: 0, fee: 0, base: 0 };

  const used = new Set();
  for (const v of (usedOrderTotals || [])) {
    const n = Math.round(parseFloat(v) * 100);
    if (!Number.isNaN(n)) used.add(n);
  }

  // A single-file order is its own unique total already; don't add a fee the
  // customer was never quoted.
  if (used.size === 0) {
    return { total: baseCents / 100, fee: 0, base: baseCents / 100 };
  }

  const free = pickFreeOffset(baseCents, used);
  if (free) {
    return { total: free.cents / 100, fee: free.offset / 100, base: baseCents / 100 };
  }
  return { total: (baseCents + MAX_MATCH_OFFSETS - 1) / 100, fee: (MAX_MATCH_OFFSETS - 1) / 100, base: baseCents / 100, crowded: true };
}

// Allocates a unique fee and inserts the job, retrying if another upload took
// the same slot in between.
//
// Reading "which totals are taken" and then inserting is not atomic, so two
// uploads a second apart both saw 0.29 free and both used it. Four jobs ended
// up priced identically, which made the incoming payments ambiguous -- real
// money arrived and could not be matched to a job, so it was parked for staff
// while the customer stood at a kiosk that never printed.
//
// The database enforces uniqueness (see migration 20261014_unique_pending_total);
// this loop handles the resulting conflict by moving to the next free slot.
async function createJobWithUniqueFee(jobData, extendedFields) {
  const attempts = 12;

  for (let i = 0; i < attempts; i++) {
    const pricing = await assignUniqueMatchAmount(jobData.__basePrice);
    const row = Object.assign({}, jobData, extendedFields, {
      total_price: pricing.total,
      base_price: pricing.base,
      match_fee: pricing.fee
    });
    delete row.__basePrice;

    const result = await supabaseRequest('POST', '/print_jobs', row);
    if (!result.error) return { result: result, pricing: pricing };

    // 23505 = unique_violation: someone claimed this exact total first.
    const text = JSON.stringify(result.data || '');
    if (text.includes('23505') || text.includes('duplicate key')) continue;

    return { result: result, pricing: pricing };
  }

  return { result: { error: true, message: 'Could not reserve a unique payment amount' }, pricing: null };
}

async function supabaseStorageUpload(bucket, path, fileBuffer, contentType) {
  const url = SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + path;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': contentType || 'application/octet-stream',
    'x-upsert': 'true'
  };
  try {
    const response = await fetch(url, { method: 'POST', headers, body: fileBuffer });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
    if (!response.ok) {
      return { error: true, message: (typeof parsed === 'object' ? (parsed.message || parsed.error || JSON.stringify(parsed)) : parsed), http_code: response.status };
    }
    return { error: false, data: parsed, http_code: response.status };
  } catch(e) {
    return { error: true, message: e.message, http_code: 0 };
  }
}

async function supabaseStorageSignedUrl(bucket, path) {
  const url = SUPABASE_URL + '/storage/v1/object/upload/sign/' + bucket + '/' + path;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };
  try {
    const response = await fetch(url, { method: 'POST', headers });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
    if (!response.ok) {
      return { error: true, message: (typeof parsed === 'object' ? (parsed.message || parsed.error || JSON.stringify(parsed)) : parsed), http_code: response.status };
    }
    const relUrl = (typeof parsed === 'object' && parsed) ? (parsed.url || parsed.signedUrl || '') : '';
    if (!relUrl) {
      return { error: true, message: 'No upload URL returned from storage', http_code: 500 };
    }
    return { error: false, data: parsed, uploadUrl: SUPABASE_URL + '/storage/v1' + relUrl, http_code: response.status };
  } catch(e) {
    return { error: true, message: e.message, http_code: 0 };
  }
}

const EXT_MIME_MAP = {
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png'
};

async function supabaseStorageDelete(bucket, path) {
  const url = SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + encodeURIComponent(path);
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };
  try {
    const response = await fetch(url, { method: 'DELETE', headers });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
    if (!response.ok) {
      return { error: true, message: (typeof parsed === 'object' ? (parsed.message || parsed.error || JSON.stringify(parsed)) : parsed), http_code: response.status };
    }
    return { error: false, data: parsed, http_code: response.status };
  } catch(e) {
    return { error: true, message: e.message, http_code: 0 };
  }
}

function parseMultipartFormData(bodyOrBuffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return { fields: {}, file: null };
  const boundary = boundaryMatch[1];
  const delimiter = '--' + boundary;
  const body = Buffer.isBuffer(bodyOrBuffer) ? bodyOrBuffer.toString('binary') : String(bodyOrBuffer);
  const parts = body.split(delimiter).slice(1);
  const fields = {};
  let file = null;
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (part.startsWith('--\r\n') || part.startsWith('--\n')) break;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerSection = part.substring(0, headerEnd);
    let content = part.substring(headerEnd + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    const nameMatch = headerSection.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const filenameMatch = headerSection.match(/filename="([^"]*)"/i);
    if (filenameMatch) {
      const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
      file = { name: fieldName, filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: Buffer.from(content, 'binary') };
    } else {
      fields[fieldName] = content.trim();
    }
  }
  return { fields, file };
}

// Constant-time string comparison. A plain `!==` lets an attacker recover a
// secret one character at a time by measuring how long the rejection takes.
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, SUPABASE_REST_URL,
  SESSION_DURATION, PRICE_BW_PER_PAGE, PRICE_COLOR_PER_PAGE,
  PRICE_A3_MULTIPLIER, PRICE_DOUBLE_SIDED_MULTIPLIER, ALLOWED_EXTENSIONS,
  NOTIFICATION_SECRET, PRINT_WORKER_SECRET, APP_VERSION, JOB_PAYABLE_WINDOW_MIN,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM_NAME,
  VERIFICATION_CODE_LENGTH, VERIFICATION_CODE_TTL,
  corsHeaders, json, err, supabaseRequest, generateJobId, safeEqual,
  generateSessionToken, validateSession, calculatePrice, assignUniqueMatchAmount, createJobWithUniqueFee, assignUniqueOrderTotal, pickFreeOffset, MAX_MATCH_OFFSETS,
  generateVerificationCode, isValidGmail, isValidMalaysianPhone,
  normalizePhone, sendVerificationEmail, smtpSend,
  supabaseStorageUpload, supabaseStorageSignedUrl, supabaseStorageDelete, parseMultipartFormData, EXT_MIME_MAP
};
