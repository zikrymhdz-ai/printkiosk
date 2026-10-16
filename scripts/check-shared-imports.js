// Every _shared helper a function CALLS must also be one it IMPORTS.
//
// This exists because of an outage that looked like missing data rather than a
// crash. admin.js called computePaper() without importing it. At runtime that
// is a ReferenceError thrown inside getStats(), so the whole stats response 500s
// and the dashboard renders nothing at all - no paper, no toner, no job counts.
// The database was perfectly healthy the entire time.
//
// It survived because `node --check` only validates syntax: an unbound
// identifier is not a syntax error. And the test written to guard the fix
// asserted that the CALL existed - which is true whether or not the name is
// bound - so it passed confidently on broken code. Asserting that a function is
// called proves nothing about whether it can run.
//
// The export list is read from the real module rather than a hand-kept list, so
// this cannot drift when _shared grows or loses a helper.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'netlify', 'functions');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

// The real exports. _shared.js is plain CommonJS with no side effects at import.
require('./test-env');
const shared = require(path.join(FUNCTIONS, '_shared.js'));
const exportNames = Object.keys(shared);
ok(exportNames.length > 0, '_shared.js exports ' + exportNames.length + ' helper(s)');

const files = fs.readdirSync(FUNCTIONS)
  .filter((f) => f.endsWith('.js') && f !== '_shared.js');

let anyChecked = false;

for (const file of files) {
  const src = fs.readFileSync(path.join(FUNCTIONS, file), 'utf8');

  const req = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\/_shared['"]\)/);
  const imported = req
    ? new Set(req[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean))
    : new Set();

  // Identifiers from _shared that this file actually calls. Word-boundary
  // matched so `calculatePriceOnce` does not count as `calculatePrice`.
  //
  // String literals are blanked out first. Without that, an error message
  // reading "Check SMTP_USER / SMTP_PASS (Gmail App Password)" looks exactly
  // like a call - the name is followed by " (" - and the check reports a
  // perfectly good file as broken. A guard with false positives gets ignored,
  // which makes it worse than no guard at all.
  const stripped = src
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/const\s*\{[^}]*\}\s*=\s*require\(['"]\.\/_shared['"]\);?/g, '');

  const called = exportNames.filter((name) =>
    new RegExp('\\b' + name + '\\s*\\(').test(stripped));

  if (!req && called.length === 0) continue;
  anyChecked = true;

  const missing = called.filter((n) => !imported.has(n));
  ok(missing.length === 0,
    file + ': every _shared helper it calls is imported'
    + (missing.length ? ' - missing: ' + missing.join(', ') : ' (' + called.length + ' used)'));
}

// The specific pair that broke, named so the failure is unmistakable.
const admin = fs.readFileSync(path.join(FUNCTIONS, 'admin.js'), 'utf8');
ok(/const\s*\{[^}]*\bcomputePaper\b[^}]*\}\s*=\s*require\(['"]\.\/_shared['"]\)/.test(admin)
  && /computePaper\(printer\)/.test(admin),
  'admin.js both imports and calls computePaper (the regression that blanked the dashboard)');

// A called-but-unimported helper is a runtime crash, so name that failure
// plainly rather than letting it read as "missing data".
ok(!/\bcomputePaper\s*\(/.test(admin.replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/const\s*\{[^}]*\}\s*=\s*require\(['"]\.\/_shared['"]\);?/g, ''))
  || /computePaper/.test(admin.split('require')[0]),
  'computePaper is not called as a bare unbound name');

if (!anyChecked) {
  console.log('  FAILED  no function files were checked - the scan is broken');
  failed++;
}

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      no function calls a _shared helper it forgot to import');