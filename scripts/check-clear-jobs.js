// Rules for what a customer is allowed to clear from their own job list.
//
// Carve-out: a PIN normally protects a document that can still be collected at
// the kiosk. It does NOT protect work that is already finished (printed or
// cancelled) or work that was never paid for - a PIN is assigned when the job is
// created, so every pending job has one, and collecting a document means paying
// for it. See the comments in clearableReason().
//
// The rule lives in two places on purpose:
//   - netlify/functions/data.js  clearableReason()  -> enforced
//   - website/customer.html      jobCanBeCleared()  -> draws the button
//
// This test RUNS both, instead of keeping a third hand-written copy. The copy
// that used to be here had drifted: it checked print_pin before status, so it
// asserted that a printed job with a leftover PIN could not be cleared - which
// is the opposite of what ships, and of what 28 of the live 65 rows needed.
// A mirror that is only compared against itself proves nothing.
//
// Run: node scripts/check-clear-jobs.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const backend = read('netlify/functions/data.js');
const page = read('website/customer.html');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- the shipped server rule, executed -------------------------------------
function loadServerRule() {
  const start = backend.indexOf('function clearableReason');
  const end = backend.indexOf('async function handleDeleteJob');
  if (start < 0 || end < 0) throw new Error('clearableReason() not found in data.js');
  // eslint-disable-next-line no-new-func
  return new Function(backend.slice(start, end) + '\nreturn clearableReason;')();
}

// --- the shipped UI rule, executed -----------------------------------------
function loadUiRule() {
  const start = page.indexOf('function jobCanBeCleared');
  const end = page.indexOf('function deleteJob');
  if (start < 0 || end < 0) throw new Error('jobCanBeCleared() not found in customer.html');
  // eslint-disable-next-line no-new-func
  return new Function(page.slice(start, end) + '\nreturn jobCanBeCleared;')();
}

const clearableReason = loadServerRule();
const jobCanBeCleared = loadUiRule();
const canClear = (j) => clearableReason(j) === null;

// --- the headline requirement ---------------------------------------------
// Printed and cancelled work is clearable even when it still carries a PIN.
for (const j of [
  { status: 'completed', paid: true, print_pin: '4821' },
  { status: 'completed', paid: true, print_pin: null },
  { status: 'cancelled', paid: false, print_pin: '4821' },
]) {
  ok(canClear(j), 'clear ' + j.status + ' (pin=' + (j.print_pin || 'none') + ')');
}

// Unpaid work is clearable too, PIN or not: a PIN buys nothing without payment.
ok(canClear({ status: 'pending', paid: false, print_pin: '4821' }),
   'clear a not-paid job even though it has a PIN');
ok(canClear({ status: 'pending', paid: false, print_pin: null }), 'clear a not-paid job');

// --- the PIN must still protect work that has not printed ------------------
for (const j of [
  { status: 'printing',       paid: true, print_pin: '4821' },
  { status: 'ready_to_print', paid: true, print_pin: '4821' },
  { status: 'printing',       paid: true, print_pin: null },
]) {
  ok(!canClear(j), 'keep ' + j.status + ' (pin=' + (j.print_pin || 'none') + ') - still collectable');
}

// --- paid jobs needing staff must survive ---------------------------------
for (const j of [
  { status: 'failed',        paid: true, print_pin: null },
  { status: 'refund_issued', paid: true, print_pin: null },
  { status: 'pending',       paid: true, print_pin: null },
]) {
  ok(!canClear(j), 'keep ' + j.status + ' + paid');
}

// --- the two copies must agree on every shape ------------------------------
// This is the whole point of executing both: a drift here is a button that is
// offered and then refused (or the reverse).
const MATRIX = [];
for (const status of ['completed', 'cancelled', 'pending', 'printing', 'ready_to_print', 'failed', 'refund_issued', 'partial']) {
  for (const paid of [true, false]) {
    for (const print_pin of ['4821', null]) MATRIX.push({ status, paid, print_pin });
  }
}
const disagreements = MATRIX.filter((j) => jobCanBeCleared(j) !== canClear(j));
ok(disagreements.length === 0,
   'the UI mirror and the server rule agree on all ' + MATRIX.length + ' shapes'
   + (disagreements.length
     ? ': ' + JSON.stringify(disagreements.slice(0, 3))
     : ''));

// --- the rule must be enforced server-side, not only hidden in the UI -------
const deleteJobSrc = backend.split('async function handleDeleteJob')[1] || '';
ok(/validateSession\(event\)/.test(deleteJobSrc), 'delete-job requires a session');
ok(/job\.user_id !== session\.users\.id/.test(deleteJobSrc),
   'delete-job checks the job belongs to the caller');
ok(/const blocked = clearableReason\(job\)/.test(deleteJobSrc),
   'delete-job enforces clearableReason() server-side');

// --- bulk clear must agree with the single-job path -----------------------
ok(/async function handleClearJobs/.test(backend), 'bulk clear handler exists');
ok(/action === 'clear-jobs'/.test(backend)
   && /return await handleClearJobs\(event\)/.test(backend),
  'clear-jobs route is wired');
ok(/dry_run: true/.test(backend), 'bulk clear supports a dry run so the UI can show what is kept');
ok(/body\.confirm !== true/.test(backend), 'bulk clear only deletes when confirm:true is sent');

const bulkSrc = backend.split('async function handleClearJobs')[1].split('async function ')[0];
ok(/clearableReason\(j\)/.test(bulkSrc), 'bulk clear reuses the same rule, not a second copy');

// It must not delete anything in a dry run.
const confirmAt = bulkSrc.indexOf('body.confirm !== true');
const deleteAfter = bulkSrc.indexOf("'PATCH'");
ok(confirmAt !== -1 && deleteAfter > confirmAt,
   'the delete write is unreachable before the confirm check');

// --- the UI must not offer what the server refuses -------------------------
ok(/jobCanBeCleared\(j\)/.test(page), 'the delete button is gated on the rule');
// The reason has to be VISIBLE text. It used to live in the tooltip of a grey
// padlock, so on a phone - where there is no hover - a customer saw a locked row
// and no reason at all.
ok(/You can still collect this/.test(page), 'the UI explains why a PIN job is kept');
ok(!/M7 11V7a5 5 0 0 1 10 0v4/.test(page),
   'and the padlock that hid the reason behind a hover is gone');

if (failed) { console.log('  -> failed'); process.exit(1); }
console.log('  ok      customer clear rules: one rule, enforced and mirrored');
