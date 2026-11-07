// Guards the "Pending Jobs" number on the admin overview.
//
// The card counted every row ever left at status 'pending', including uploads
// abandoned weeks earlier. On the live table that read 32 pending jobs while
// the print queue held none: an unpaid job stops being matchable after
// JOB_PAYABLE_WINDOW_MIN, so those rows could never be paid and never print.
// Staff were being told there was a backlog that did not exist.
//
// Run: node scripts/check-admin-pending-count.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'admin.js'), 'utf8');
const shared = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', '_shared.js'), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok      ' + msg); return; }
  failed++;
  console.error('  FAILED  ' + msg);
}

const stats = (admin.match(/async function getStats\(\)[\s\S]*?\n\}/) || [''])[0];
ok(stats.length > 0, 'getStats() is present');

// --- one home for the rule --------------------------------------------------
// The payable window is owned by _shared.js. A second copy here would drift the
// moment one of them is tuned.
ok(/JOB_PAYABLE_WINDOW_MIN/.test(stats),
   'getStats() uses the shared payable window, not its own guess');
ok(!/=\s*\d+\s*;\s*\/\/.*payable/i.test(stats),
   'getStats() does not hardcode a payable window of its own');

// --- the count itself -------------------------------------------------------
ok(/created_at/.test(stats), 'getStats() reads created_at, so it can age a job');
ok(/pendingCutoff/.test(stats) ||
   /Date\.now\(\)\s*-\s*JOB_PAYABLE_WINDOW_MIN/.test(stats),
   'getStats() derives a cutoff from the payable window');

// The old code was a bare `if (job.status === 'pending') pendingJobs++;`.
// The count must never be that unguarded again.
ok(!/if\s*\(\s*job\.status\s*===\s*'pending'\s*\)\s*pendingJobs\+\+/.test(stats),
   'pending jobs are not counted on status alone');

// Unpaid rows must be inside the window; paid rows keep counting at any age,
// because that money changed hands and the document is still waiting for paper.
ok(/(paid[^\n]{0,80}(cutoff|created_at))|((cutoff|created_at)[^\n]{0,80}paid)/.test(stats),
   'the count separates paid rows from unpaid ones before ageing them');

// --- the window itself ------------------------------------------------------
ok(/const JOB_PAYABLE_WINDOW_MIN\s*=\s*\d+/.test(shared),
   'the payable window is defined in _shared.js');
ok(/module\.exports[\s\S]{0,600}JOB_PAYABLE_WINDOW_MIN/.test(shared),
   'the payable window is exported for admin.js to import');
ok(/const\s*\{[^}]*JOB_PAYABLE_WINDOW_MIN[^}]*\}\s*=\s*require\('\.\/_shared'\)/.test(admin),
   'admin.js imports it rather than redefining it');

console.log(failed ? '\n' + failed + ' problem(s).' : '\npending-count checks passed.');
process.exit(failed ? 1 : 0);
