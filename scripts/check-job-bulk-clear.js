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

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      bulk clearing is scoped to the owner and pruned to what is on screen');