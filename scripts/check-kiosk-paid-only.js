// After signing in with a face, the kiosk must only offer PAID documents.
//
// The job list used to render every job with a Paid/Unpaid badge and let the
// customer tap either. Everything downstream assumed "listed" meant "paid" -
// which is how an unpaid job could reach the printer. The fix is to list only
// paid jobs, and to say plainly that others are waiting for payment rather than
// silently showing an empty screen.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const kiosk = fs.readFileSync(path.join(ROOT, 'kiosk/walkin.html'), 'utf8');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

// --- the empty state can actually say what happened -----------------------
ok(/id="jobsEmptyMsg"/.test(kiosk), 'the empty state has a message we can set');
ok(/id="jobsEmptyTitle"/.test(kiosk), 'and a title of its own');

// --- the listing filters, and the filter is strict -----------------------
const showUserJobs = extractFn(kiosk, 'showUserJobs');
ok(!!showUserJobs, 'showUserJobs exists');
ok(/filter\(function \(j\) \{ return j\.paid === true; \}\)/.test(showUserJobs),
  'only jobs with paid === true survive the filter');

// A truthy-but-not-true value must not slip through. "paid" can arrive as a
// string from some clients; "false" is truthy and would print for free.
const filterMatch = showUserJobs.match(/var paid = jobs\.filter\((function[^\n]*?\})\);/);
ok(!!filterMatch, 'the filter expression was found');
if (filterMatch) {
  const filter = vm.runInNewContext('(' + filterMatch[1] + ')');
  const jobs = [
    { job_id: 'A', paid: true },
    { job_id: 'B', paid: false },
    { job_id: 'C' },
    { job_id: 'D', paid: 'false' },
    { job_id: 'E', paid: 1 },
  ];
  const kept = jobs.filter(filter).map((j) => j.job_id);
  ok(kept.length === 1 && kept[0] === 'A',
    'only a real boolean true passes: ' + JSON.stringify(kept));
  ok(kept.indexOf('D') === -1,
    'the string "false" is rejected rather than treated as paid');
  ok(kept.indexOf('E') === -1,
    'a truthy 1 is rejected too - strict equality, not truthiness');
  ok(kept.indexOf('C') === -1, 'a missing paid flag is rejected');
}

// --- nothing tappable is emitted for an unpaid job ------------------------
ok(!/isPaid \? 'Paid' : 'Unpaid'/.test(kiosk), 'the tappable Unpaid card is gone');
ok(!/background:#92400e/.test(kiosk), 'the Unpaid badge styling is gone');

// The render must run over the filtered list, not the raw one.
ok(/list\.innerHTML = paid\.map\(/.test(showUserJobs),
  'the cards are built from the filtered list');
ok(!/list\.innerHTML = jobs\.map\(/.test(showUserJobs),
  'and never from the unfiltered list');

// --- an account with nothing paid is told why, not shown a blank screen ----
ok(/var waiting = jobs\.length - paid\.length;/.test(showUserJobs),
  'unpaid documents are counted');
ok(/waiting for payment/.test(showUserJobs),
  'the customer is told a document is waiting for payment');
ok(/No documents ready to print/.test(kiosk),
  'and the plain empty case still reads sensibly');

// --- the shared path means the QR route gets the same rule ----------------
ok(/function qrMyJobs[\s\S]{0,400}showUserJobs\(/.test(kiosk),
  'the QR sign-in route uses the same filtered list');

// --- selecting a job must still be unable to print an unpaid one ----------
const selectJob = extractFn(kiosk, 'selectJob');
ok(!!selectJob, 'selectJob exists');
ok(/if \(job\.paid\)/.test(selectJob),
  'the receipt is still reached only through an explicit paid check');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      face sign-in offers paid documents only');
