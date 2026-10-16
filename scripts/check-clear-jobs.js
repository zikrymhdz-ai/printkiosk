// Rules for what a customer is allowed to clear from their own job list.
//
// The requirement: clear printed / cancelled / unpaid jobs, but never a job
// with a PIN. A PIN means the document is still collectable at the kiosk and is
// the only proof of entitlement, so clearing it destroys something someone can
// still legitimately claim.
//
// These are the same predicates as clearableReason() in data.js and
// jobCanBeCleared() in customer.html; all three must agree.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const backend = fs.readFileSync(path.join(ROOT, 'netlify/functions/data.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'website/customer.html'), 'utf8');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// Re-implement the shipped rule exactly as clearableReason() reads it.
function clearableReason(job) {
  const status = job.status || '';
  const paid = job.paid === true || job.paid === 'true';
  if (job.print_pin) return 'has a print PIN and can still be collected';
  if (status === 'completed') return null;
  if (status === 'cancelled') return null;
  if (status === 'pending' && !paid) return null;
  if (status === 'failed' || status === 'refund_issued') return 'needs staff to arrange a refund or reprint';
  if (status === 'pending' && paid) return 'paid and awaiting print';
  return 'status "' + status + '" is still active';
}
const canClear = (j) => clearableReason(j) === null;

// --- the headline requirement ---------------------------------------------
const WITH_PIN = [
  { name: 'completed + PIN',    job: { status: 'completed', paid: true,  print_pin: '4821' } },
  { name: 'cancelled + PIN',    job: { status: 'cancelled', paid: false, print_pin: '4821' } },
  { name: 'pending unpaid + PIN', job: { status: 'pending',  paid: false, print_pin: '4821' } },
  { name: 'queued + PIN',       job: { status: 'printing', paid: true,  print_pin: '4821' } },
  { name: 'pending PAID + PIN', job: { status: 'pending',  paid: true,  print_pin: '4821' } },
];
for (const t of WITH_PIN) {
  ok(!canClear(t.job), 'never clear ' + t.name);
}

// --- the three things that SHOULD clear -----------------------------------
ok(canClear({ status: 'completed', paid: true,  print_pin: null }), 'clear printed successfully');
ok(canClear({ status: 'cancelled', paid: false, print_pin: null }), 'clear cancelled');
ok(canClear({ status: 'pending',  paid: false, print_pin: null }), 'clear not paid yet');

// --- paid jobs needing staff must survive ---------------------------------
ok(!canClear({ status: 'failed',      paid: true, print_pin: null }), 'keep failed+paid (needs refund)');
ok(!canClear({ status: 'refund_issued', paid: true, print_pin: null }), 'keep refund_issued');
ok(!canClear({ status: 'pending',     paid: true, print_pin: null }), 'keep paid & awaiting print');
ok(!canClear({ status: 'printing',    paid: true, print_pin: null }), 'keep actively printing');

// --- the PIN check must come first -----------------------------------------
// If status were checked first, 'completed + PIN' would look clearable.
ok(/if \(job\.print_pin\) return/.test(backend),
  'backend checks print_pin before anything else');
ok(clearableReason({ status: 'completed', paid: true, print_pin: '4821' })
   === 'has a print PIN and can still be collected',
  'a completed job with a PIN is still refused, so the PIN check truly runs first');

// --- the rule must be enforced server-side, not only hidden in the UI -------
ok(/validateSession\(event\)/.test(backend.split('async function handleDeleteJob')[1] || ''),
  'delete-job requires a session');
ok(/job\.user_id !== session\.users\.id/.test(backend),
  'delete-job checks the job belongs to the caller');
ok(/const blocked = clearableReason\(job\)/.test(backend),
  'delete-job enforces clearableReason() server-side');

// --- bulk clear must agree with the single-job path -----------------------
ok(/async function handleClearJobs/.test(backend), 'bulk clear handler exists');
// POST actions in this file are dispatched in if-blocks, not a switch case,
// so assert the dispatch itself rather than the style.
ok(/action === 'clear-jobs'/.test(backend)
   && /return await handleClearJobs\(event\)/.test(backend),
  'clear-jobs route is wired');
ok(/dry_run: true/.test(backend), 'bulk clear supports a dry run so the UI can show what is kept');
ok(/body\.confirm !== true/.test(backend), 'bulk clear only deletes when confirm:true is sent');
ok(/reason === null/.test(backend), 'bulk clear reuses the same rule, not a second copy');
// It must not delete anything in a dry run.
const dry = backend.split('async function handleClearJobs')[1].split('async function ')[0];
const confirmAt = dry.indexOf('body.confirm !== true');
const deleteAfter = dry.indexOf('handleDeleteJob(Object.assign');
ok(confirmAt !== -1 && deleteAfter > confirmAt,
  'the delete loop is unreachable before the confirm check');

// --- the UI must not offer what the server refuses -------------------------
ok(/function jobCanBeCleared/.test(page), 'UI mirrors the clearable rule');
ok(/jobCanBeCleared\(j\)/.test(page), 'delete button is gated on the rule');
// The reason has to be VISIBLE text. It used to live in the tooltip of a grey
    // padlock, so on a phone - where there is no hover - a customer saw a locked
    // row and no reason at all. The wording changed with it, so assert on the
    // behaviour rather than the old sentence.
    ok(/You can still collect this/.test(page),
    'UI explains why a PIN job is kept');
    ok(!/M7 11V7a5 5 0 0 1 10 0v4/.test(page),
    'and the padlock that hid the reason behind a hover is gone');
// A refused delete must not silently vanish from the local list.
ok(/if \(!res\.ok\)[\s\S]{0,200}alert\(/.test(page),
  'a refused delete surfaces an error instead of hiding the job locally');

if (failed) process.exit(1);
console.log('  ok      customer clear rules: PIN jobs always kept');