// Clearing a customer's jobs must cost a fixed number of round trips, not four
// per job.
//
// Measured against the live site on 2026-10-27, before this was fixed:
//
//   10 jobs  ->  7.0 s
//   16 jobs  -> 10.7 s
//   30 jobs  -> 21.3 s
//
// handleClearJobs called handleDeleteJob() once per job, and each of those
// validated the session, read the row, patched it and deleted its stored object
// - sequentially. The cost was linear and had no ceiling, so a customer with a
// few months of history could outlast the function timeout. Netlify answers a
// timed-out function with an HTML error page, `r.json()` throws, and the page
// reported "Could not reach the server" - after it had already cleared half the
// list.
//
// This runs the real handleClearJobs with a recording supabaseRequest.
//
// Run: node scripts/check-bulk-clear-batch.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/data.js'), 'utf8');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- lift the real handler out, with recording dependencies ---------------
function load(jobs, opts) {
  opts = opts || {};
  const start = src.indexOf('function clearableReason');
  const end = src.indexOf('async function handleSubmitReport');
  if (start < 0 || end < 0) throw new Error('could not locate the clear handlers in data.js');

  const harness = [
    'const CLEAR_BATCH = ' + (/const CLEAR_BATCH = (\d+);/.exec(src) || [, '100'])[1] + ';',
    'function storageTargetOf(p) {',
    '  if (!p || !String(p).includes("/storage/v1/object/")) return null;',
    '  const parts = String(p).split("/storage/v1/object/")[1].split("/");',
    '  if (parts[0] === "public") return { bucket: parts[1], path: parts.slice(2).join("/") };',
    '  return { bucket: parts[0], path: parts.slice(1).join("/") };',
    '}',
    'const json = (o, c) => ({ statusCode: c || 200, body: JSON.stringify(o) });',
    'const err = (m, c) => ({ statusCode: c || 400, body: JSON.stringify({ error: m }) });',
    'const calls = [];',
    'const jobs = JSON.parse(' + JSON.stringify(JSON.stringify(jobs)) + ');',
    'const storage = [];',
    'let inFlight = 0; let peak = 0;',
    'const UID = ' + JSON.stringify(opts.uid || 'user-1') + ';',
    'const patchFailsAt = ' + JSON.stringify(opts.patchFailsAt === undefined ? null : opts.patchFailsAt) + ';',
    'async function validateSession() { return { users: { id: UID, role: "customer" } }; }',
    'async function supabaseStorageDelete(bucket, p) {',
    '  storage.push(bucket + "/" + p);',
    '  inFlight++; peak = Math.max(peak, inFlight);',
    '  await new Promise((r) => setTimeout(r, 5));',
    '  inFlight--;',
    '  return { error: false };',
    '}',
    'async function supabaseRequest(method, endpoint, body) {',
    '  calls.push({ method, endpoint, body });',
    '  if (method === "GET") return { data: jobs, error: null };',
    '  if (method === "PATCH") {',
    '    const m = /job_id=in\\.\\(([^)]*)\\)/.exec(endpoint);',
    '    const ids = m ? m[1].split(",").map(decodeURIComponent) : [];',
    '    if (patchFailsAt !== null && calls.filter(c => c.method === "PATCH").length > patchFailsAt) {',
    '      return { error: true, message: "boom" };',
    '    }',
    '    return { error: false, data: ids.map(id => ({ job_id: id })), http_code: 200 };',
    '  }',
    '  return { error: false, data: [] };',
    '}',
    src.slice(start, end),
    'return { handleClearJobs, calls, storage, peak: () => peak };',
  ].join('\n');

  // eslint-disable-next-line no-new-func
  return new Function(harness)();
}

function job(n, extra) {
  return Object.assign({
    job_id: 'PRN-TEST-' + n,
    status: 'pending',
    paid: false,
    print_pin: null,
    file_path: 'https://x.supabase.co/storage/v1/object/public/print-jobs/p' + n + '/f.pdf',
  }, extra || {});
}

async function clear(h, body) {
  const res = await h.handleClearJobs({ body: JSON.stringify(body || { confirm: true }) });
  return { res, body: JSON.parse(res.body), patches: h.calls.filter(c => c.method === 'PATCH') };
}

async function main() {
  // --- 1. ONE WRITE FOR THIRTY JOBS ------------------------------------
  const jobs = Array.from({ length: 30 }, (_, i) => job(i));
  let h = load(jobs);
  let r = await clear(h);
  ok(r.res.statusCode === 200, 'a 30-job clear succeeds');
  ok(r.patches.length === 1,
     'it takes ONE PATCH for 30 jobs (' + r.patches.length + '); it used to be four round trips each');
  ok(r.body.cleared.length === 30, 'and reports all 30 as cleared');
  ok(/user_id=eq\./.test(r.patches[0].endpoint),
     'the write is scoped to the caller: ' + r.patches[0].endpoint);
  ok(r.patches[0].body.cleared_at, 'a cleared row is stamped cleared_at, as the single-job path does');
  ok(r.patches[0].body.print_pin === null, 'and its PIN is dropped');

  // --- 2. STORED FILES GO IN PARALLEL ----------------------------------
  ok(h.storage.length === 30, 'all 30 stored objects are deleted');
  await new Promise(res => setTimeout(res, 40));
  ok(h.peak() > 1, 'the storage deletes overlap instead of one after another (peak ' + h.peak() + ')');

  // --- 3. THE SAME RULES AS THE SINGLE-JOB PATH ------------------------
  h = load([
    job(1, { status: 'completed', paid: true }),                    // printed: clear
    job(2, { status: 'pending', paid: true }),                      // paid, awaiting print: keep
    job(3, { status: 'printing', paid: true, print_pin: '4821' }),  // still collectable: keep
    job(4, { status: 'failed', paid: true }),                       // needs staff: keep
    job(5, { status: 'pending', paid: false, print_pin: '4821' }),  // never paid: clear
  ]);
  r = await clear(h);
  ok(r.body.cleared.length === 2
     && r.body.cleared.indexOf('PRN-TEST-1') !== -1
     && r.body.cleared.indexOf('PRN-TEST-5') !== -1,
     'only the genuinely clearable jobs are written (' + r.body.cleared.join(',') + ')');
  ok(r.patches[0].endpoint.includes('PRN-TEST-1')
     && !r.patches[0].endpoint.includes('PRN-TEST-2'),
     'and the kept jobs are not in the where-clause at all');
  ok(r.body.kept.length === 3, 'the three kept jobs come back with their reasons');

  // --- 4. A DRY RUN STILL WRITES NOTHING -------------------------------
  h.calls.length = 0;
  r = await clear(h, {});
  ok(r.patches.length === 0, 'a dry run performs no PATCH');
  ok(r.body.dry_run === true, 'and says it was a dry run');
  ok(r.body.clearable.length === 2, 'while still reporting what would go');

  // --- 5. A FAILING LATER CHUNK REPORTS WHAT IT DID --------------------
  // 150 jobs is two chunks; the second one fails. Telling the customer "nothing
  // was deleted" would be a lie - the first 100 are gone.
  const many = Array.from({ length: 150 }, (_, i) => job(i));
  h = load(many, { patchFailsAt: 1 });
  r = await clear(h);
  ok(r.res.statusCode === 502, 'a failed later chunk is an error, not a success');
  ok(r.body.cleared.length === 100,
     'and it reports the 100 it really cleared (got ' + r.body.cleared.length + ')');
  ok(/Cleared 100 of 150/.test(r.body.error || ''),
     'naming the split rather than claiming nothing happened: ' + (r.body.error || ''));

  // --- 6. CHUNKING IS BOUNDED ------------------------------------------
  h = load(many);
  r = await clear(h);
  ok(r.patches.length === 2, '150 jobs take 2 writes, not 150 (' + r.patches.length + ')');
  ok(r.body.cleared.length === 150, 'and every one is reported');

  if (failed) { console.log('  -> failed'); process.exit(1); }
  console.log('  ok      clearing jobs costs one write, not four round trips per job');
}

main();
