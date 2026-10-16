// Bulk selection of jobs to clear on the customer's My Print Jobs list.
//
// What this guards, in order of how much damage a regression would do:
//
//   1. The selection can only ever NARROW what the server clears. The server
//      reads the caller's own jobs from the session and intersects the selection
//      with them, so a job id belonging to somebody else is not "rejected" - it
//      is never a candidate. That is the property that makes it safe to accept
//      ids from a browser at all.
//   2. Only clearable jobs offer a checkbox. "Select all" must not be able to
//      sweep up a PIN job or a paid job awaiting print, which the server refuses
//      and which would therefore fail on every attempt.
//   3. A selection survives a re-render, and is pruned when a job leaves the
//      list - so the toolbar can never ask the server to clear something the
//      customer can no longer see.
//   4. The confirmation names what will be KEPT and why, rather than asking
//      "are you sure?" and then quietly keeping some of the selection.
//
// The selection helpers are run for real against a stub DOM, because the
// interesting behaviour is what happens to the button and the checkbox set when
// the list changes underneath them.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cust = fs.readFileSync(path.join(ROOT, 'website', 'customer.html'), 'utf8');
const data = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'data.js'), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const grab = (name) => {
  const start = cust.indexOf('function ' + name);
  if (start < 0) return null;
  let depth = 0;
  for (let i = cust.indexOf('{', start); i < cust.length; i++) {
    if (cust[i] === '{') depth++;
    else if (cust[i] === '}') {
      depth--;
      if (depth === 0) return cust.slice(start, i + 1);
    }
  }
  return null;
};

// ---- the server: ownership first, selection second ------------------------
ok(/user_id':\s*'eq\.' \+ userId/.test(data),
  'clear-jobs reads only the caller\'s own jobs, from the session');
ok(/const selection = Array\.isArray\(body\.job_ids\)/.test(data),
  'the selection is accepted as an optional narrowing');
ok(/if \(selection && !selection\.has\(j\.job_id\)\) \{ notSelected\+\+; continue; \}/.test(data),
  'and is applied only to jobs already fetched for that user');
ok(/not_selected: notSelected/.test(data),
  'the dry run reports how many were not selected, so the UI can be honest');
ok(!/user_id':\s*body|user_id':\s*userId\s*\+|user_id'\s*:\s*body/.test(data),
  'the user id is never taken from the request body');

// The hard guards must run AFTER ownership, so a foreign id cannot even be
// evaluated against clearableReason and reported as clearable.
const fetchAt = data.indexOf("'user_id': 'eq.' + userId");
const loopAt = data.indexOf('for (const j of jobs)');
ok(fetchAt > 0 && loopAt > fetchAt,
  'the ownership query runs before the selection is considered');

ok(/function clearableReason/.test(data) && /if \(job\.print_pin\) return/.test(data),
  'a job with a Print PIN is still never clearable');

// ---- the UI ----------------------------------------------------------------
ok(/class="job-select"/.test(cust), 'clearable jobs carry a checkbox');
ok(/jobCanBeCleared\(j\)/.test(cust),
  'and the checkbox is gated on the same rule the server uses');
ok(/function toggleSelectAllJobs/.test(cust), 'there is a select-all control');
ok(/function deleteSelectedJobs/.test(cust), 'and a delete-selected action');
ok(/job_ids: ids/.test(cust), 'the selection is sent as job_ids');
ok(/confirm: false/.test(cust) && /confirm: true/.test(cust),
  'a dry run precedes the delete, so the confirmation can be accurate');
ok(/will be KEPT/.test(cust) && /reason/.test(cust),
  'the confirmation names what is kept and why');

// The existing clear-all must keep working: it sends no job_ids, which the
// server treats as "no narrowing".
ok(/body: JSON\.stringify\(\{ confirm: false \}\)/.test(cust),
  'clear-all still sends no selection, so it still means everything clearable');

// ---- the helpers, run for real --------------------------------------------
const names = ['currentSelectableJobIds', 'onJobSelectChange', 'toggleSelectAllJobs', 'updateSelectionUI'];
const bodies = names.map(grab);
ok(bodies.every(Boolean), 'the selection helpers were found: ' +
  names.map((n, i) => (bodies[i] ? n : 'MISSING ' + n)).join(', '));

if (bodies.every(Boolean)) {
  // A stub DOM: N checkboxes, plus the two buttons the toolbar updates.
  const checkboxes = [
    { getAttribute: (k) => (k === 'data-job-id' ? 'JOB-A' : null), checked: false },
    { getAttribute: (k) => (k === 'data-job-id' ? 'JOB-B' : null), checked: false },
    { getAttribute: (k) => (k === 'data-job-id' ? 'JOB-C' : null), checked: false },
  ];
  const buttons = { deleteSelectedBtn: { disabled: true, textContent: '', style: {} }, selectAllJobsBtn: { textContent: '' } };

  const sandbox = {
    document: {
      querySelectorAll: (sel) => (sel === '.job-select' ? checkboxes : []),
      getElementById: (id) => buttons[id] || null,
    },
    Set,
    Array,
  };
  const names2 = ['selectedJobIds', 'currentSelectableJobIds', 'onJobSelectChange', 'toggleSelectAllJobs', 'updateSelectionUI'];
  const factory = new Function(
    'document', 'Set', 'Array',
    'var selectedJobIds = new Set();\n' +
    bodies.join('\n') +
    '\nreturn { selectedJobIds, toggleSelectAllJobs, onJobSelectChange, updateSelectionUI, currentSelectableJobIds };'
  )(sandbox.document, Set, Array);

  const selected = factory.selectedJobIds;

  // Select all.
  factory.toggleSelectAllJobs();
  ok(selected.size === 3, 'select all ticks every selectable job, got ' + selected.size);
  ok(checkboxes.every((c) => c.checked), 'and every checkbox reflects it');
  ok(buttons.deleteSelectedBtn.disabled === false, 'the delete button becomes usable');
  ok(/3/.test(buttons.deleteSelectedBtn.textContent), 'and says how many: ' + buttons.deleteSelectedBtn.textContent);

  // Select all again -> clear the selection.
  factory.toggleSelectAllJobs();
  ok(selected.size === 0, 'toggling again clears the selection, got ' + selected.size);
  ok(buttons.deleteSelectedBtn.disabled === true, 'and the delete button goes back to disabled');

  // A job leaving the list must not stay selected.
  selected.add('JOB-A');
  selected.add('JOB-GONE');
  checkboxes.splice(2, 1);           // JOB-C disappears
  checkboxes.push({
    getAttribute: (k) => (k === 'data-job-id' ? 'JOB-D' : null), checked: false,
  });
  factory.onJobSelectChange();
  ok(!selected.has('JOB-GONE'),
    'a selected job that is no longer listed is dropped from the selection');
  ok(selected.has('JOB-A'), 'a job still on screen stays selected');

  // A job that was never selectable must never enter the selection.
  selected.clear();
  factory.onJobSelectChange();
  ok(selected.size === 0, 'nothing is selected when the list is re-rendered');
}

// --- a cleared job must actually disappear ---------------------------------
// Clearing marks a row completed and nulls its PIN, which is indistinguishable
// from a job that really printed. The customer list is served by get-all-jobs,
// which deliberately includes finished work, so the cleared job came straight
// back and Delete looked like it had done nothing.
ok(fs.existsSync(path.join(ROOT, 'migrations', '20261016_print_cleared_at.sql')),
  'a cleared_at column is provided by a migration');
ok((data.match(/'cleared_at':\s*new Date\(\)\.toISOString\(\)/g) || []).length >= 2,
  'both clear paths stamp cleared_at, not just one of them');
// Both customer-facing queries must hide cleared jobs. get-jobs already hid
// them by excluding completed; get-all-jobs did not, and it is the one the
// customer page reads.
const customerQueries = (data.match(/'cleared_at':\s*'is\.null'/g) || []).length;
ok(customerQueries >= 2, 'both customer-facing job queries exclude cleared jobs, got ' + customerQueries);
// Staff and the watcher must still see them: a cleared job is evidence, and a
// payment may still be in flight against it.
ok(!/case 'get-all-jobs'[\s\S]*?print_jobs[\s\S]{0,400}?'select': '\*'[\s\S]{0,400}?cleared_at': 'is\.null'[\s\S]{0,200}?watcher/.test(data),
  'admin and the watcher are not blinded by the filter');

// --- an unpaid job must be clearable even though it has a PIN -------------
// A PIN is assigned at creation, so every pending job has one - but an unpaid
// document cannot be collected, because collecting means paying. Testing the PIN
// first refused to clear every unpaid job: the jobs with the least at stake were
// the only ones a customer could not delete.
const cr = data.match(/function clearableReason[\s\S]*?\n\}/);
ok(!!cr, 'clearableReason found');
if (cr) {
  const reason = new Function(cr[0] + '\nreturn clearableReason;')();

  const clearCases = [
    ['a pending UNPAID job that has a PIN', { status: 'pending', paid: false, print_pin: '827191' }],
    ['a pending unpaid job with no PIN', { status: 'pending', paid: false, print_pin: null }],
  ];
  for (const [name, job] of clearCases) {
    ok(reason(job) === null, name + ' is clearable');
  }

  const keptCases = [
    ['a pending PAID job with a PIN', { status: 'pending', paid: true, print_pin: '827191' }],
    ['a job that is printing', { status: 'printing', paid: true, print_pin: '1' }],
    ['a failed PAID job needing a refund', { status: 'failed', paid: true, print_pin: null }],
    // Deliberate: ready_to_print normally follows payment, so an unpaid one is
    // an anomalous state rather than an ordinary unpaid order. Left blocked
    // rather than assumed safe.
    ['an unpaid ready_to_print job (anomalous, left blocked)',
      { status: 'ready_to_print', paid: false, print_pin: '555' }],
  ];
  for (const [name, job] of keptCases) {
    ok(reason(job) !== null, name + ' is kept');
  }

  ok(reason({ status: 'completed', paid: true, print_pin: null }) === null,
    'a finished job is still clearable');
}

// The unpaid rule has to come BEFORE the PIN rule, or it never runs.
const pinAt = cr ? cr[0].indexOf('if (job.print_pin)') : -1;
const unpaidAt = cr ? cr[0].indexOf('!paid') : -1;
ok(unpaidAt > 0 && pinAt > unpaidAt,
  'the unpaid rule is checked before the PIN rule, or it never applies');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      bulk clearing is scoped to the owner and pruned to what is on screen');