// A job that can never print must be parked, not retried for ever.
//
// Seen live on 2026-10-27: a paid job whose stored file had already been
// deleted (it "completed" once, so deleteJobFile removed it) was claimed,
// failed to download, reported failed... and put straight back in the queue.
// Fifteen attempts in 90 seconds, print_attempts still 0, status flipping
// between 'printing' and 'print_requested'.
//
// Cause: reportPrint computed the attempt number from body.attempts but never
// wrote it back, so the next claim re-read 0 and every report computed
// used = 1. The retry cap could not be reached. The kiosk showed "printing"
// until it gave up, while the worker hammered storage with the same 400.
//
// This runs the real reportPrint with a recording supabaseRequest.
//
// Run: node scripts/check-print-retry.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const src = read('netlify/functions/printer.js');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- the cap is one number, shared with the worker's default ---------------
const capMatch = src.match(/const MAX_PRINT_ATTEMPTS = (\d+);/);
ok(!!capMatch, 'there is a single named retry cap');
const CAP = capMatch ? Number(capMatch[1]) : 0;
ok(CAP === 3, 'the cap matches the worker\'s PRINT_MAX_ATTEMPTS default (3): ' + CAP);

const workerSrc = read('pi/print-worker.py');
ok(/PRINT_MAX_ATTEMPTS",\s*"3"/.test(workerSrc),
   'and the worker really defaults to 3 attempts');

// --- lift the real function out and give it recording dependencies --------
const start = src.indexOf('async function reportPrint');
const end = src.indexOf('// Remove the stored file');
if (start < 0 || end < 0) throw new Error('could not locate reportPrint in printer.js');

function load() {
  const harness = [
    'const PRINT_OUTCOMES = ["completed", "failed"];',
    'const MAX_PRINT_ATTEMPTS = ' + CAP + ';',
    'const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;',
    'const json = (o, c) => ({ statusCode: c || 200, body: JSON.stringify(o) });',
    'const err = (m, c) => ({ statusCode: c || 400, body: JSON.stringify({ error: m }) });',
    'const calls = [];',
    'let deleted = [];',
    'async function supabaseRequest(method, p, body) {',
    '  calls.push({ method, path: p, body });',
    '  return { data: [{}], error: null };',
    '}',
    'async function deleteJobFile(id) { deleted.push(id); }',
    src.slice(start, end),
    'return { reportPrint, calls, deleted };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(harness)();
}

const UUID = '11111111-2222-3333-4444-555555555555';

async function report(attempts, error) {
  const h = load();
  const res = await h.reportPrint({
    body: JSON.stringify({
      job_id: UUID, public_id: 'PRN-TEST', outcome: 'failed',
      error, attempts,
    }),
  });
  const patch = (h.calls.find(c => c.method === 'PATCH') || {}).body || {};
  const alert = h.calls.find(c => c.path === '/alerts');
  return { res, patch, alert, calls: h.calls };
}

async function main() {
  const FLAKY = 'download failed: <urlopen error timed out>';

  // --- 1. THE COUNT IS PERSISTED ------------------------------------
  // Without this the cap is unreachable, whatever the cap is.
  let r = await report(1, FLAKY);
  ok(r.patch.print_attempts === 1,
     'the attempt number is written back (got ' + JSON.stringify(r.patch.print_attempts) + ')');
  ok(r.patch.status === 'print_requested',
     'a transient failure with retries left is re-queued');
  ok(!r.alert, 'and does not raise an alert yet');

  r = await report(2, FLAKY);
  ok(r.patch.print_attempts === 2, 'the second attempt is recorded as 2');
  ok(r.patch.status === 'print_requested', 'and still retries');

  // --- 2. THE CAP IS ACTUALLY REACHED -------------------------------
  r = await report(CAP, FLAKY);
  ok(r.patch.status === 'failed',
     'the last allowed attempt parks the job as failed');
  ok(!!r.alert, 'and raises a print_failed alert for staff');
  ok(r.patch.print_completed_at, 'and stamps when it gave up');

  r = await report(CAP + 1, FLAKY);
  ok(r.patch.status === 'failed', 'nothing beyond the cap is re-queued');

  // --- 3. A PERMANENT FAILURE IS NOT RETRIED ------------------------
  // The whole live case: the stored file is gone. Retrying downloads the same
  // 400 every 5 seconds and the kiosk waits for a job that cannot happen.
  const GONE = 'download failed: HTTP Error 400: Bad Request';
  r = await report(1, GONE);
  ok(r.patch.status === 'failed',
     'a missing/expired stored file is parked on the first report, not retried');
  ok(r.patch.print_error === GONE, 'and the reason is kept for staff');
  ok(!!r.alert, 'and staff are told about it');

  // A 404 from storage is the same answer.
  r = await report(1, 'download failed: HTTP Error 404: Not Found');
  ok(r.patch.status === 'failed', 'a 404 on the stored file is permanent too');

  // --- 4. A REAL PRINT IS UNCHANGED ---------------------------------
  const h = load();
  await h.reportPrint({
    body: JSON.stringify({ job_id: UUID, public_id: 'PRN-TEST', outcome: 'completed', page_verified: true }),
  });
  const done = (h.calls.find(c => c.method === 'PATCH') || {}).body || {};
  ok(done.status === 'completed', 'a completed job is recorded as completed');
  ok(done.print_error === null, 'with no error');
  ok(done.print_page_verified === true, 'and the page check is kept');
  ok(h.deleted.length === 1,
     'and only THEN is the stored file removed, once');

  // --- 5. BAD INPUT IS STILL REFUSED --------------------------------
  const bad = load();
  const res = await bad.reportPrint({ body: JSON.stringify({ job_id: 'nope', outcome: 'failed' }) });
  ok(res.statusCode === 400, 'an invalid job id is still rejected');
  ok(bad.calls.length === 0, 'without touching the database');

  if (failed) { console.log('  -> failed'); process.exit(1); }
  console.log('  ok      a job that cannot print is parked, not retried for ever');
}

main();
