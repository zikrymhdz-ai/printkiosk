// A printer that cannot be read must be able to say WHY.
//
// print-worker.py has always computed a concrete reason - "ipptool not
// installed", "connection refused", "no toner attributes" - and always sent it
// as `error`. printer.js dropped it on the floor and only stored `alert`, which
// is a CUPS stop reason that by definition only exists when the printer IS
// reachable. So the one message that explained an unreachable printer was the
// one message discarded, and the kiosk's final word was always "Status
// unknown".
//
// Same class of bug as the hand-entered paper level: a real diagnostic that
// exists, and reaches no one.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const backend = read('netlify/functions/printer.js');
const worker = read('pi/print-worker.py');
const walkin = read('kiosk/walkin.html');
const admin = read('admin/admin.html');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- the reason must be stored, not discarded ------------------------------
ok(/printer_error:\s*body\.error/.test(backend),
  'reportSupplies stores the worker-supplied failure reason');
ok(!/alert:\s*String\(body\.error/.test(backend),
  'the failure reason is not confused with the CUPS stop reason');

// A successful read must clear a stale reason, otherwise a fixed printer keeps
// showing the old failure.
const rs = backend.match(/async function reportSupplies[\s\S]*?\n\}/);
ok(!!rs, 'reportSupplies body found');
if (rs) {
  ok(/printer_error:\s*body\.error\s*\?\s*String\(body\.error\)[\s\S]{0,40}?:\s*null/.test(rs[0]),
    'printer_error is cleared to null when the read succeeds');
}

// --- the reason must reach the status response -----------------------------
ok(/printer_error:\s*row\.printer_error \|\| null/.test(backend),
  'the status endpoint returns printer_error');

// --- and the UI must show it ------------------------------------------------
ok(/d\.printer_error \|\| p\.printer_error/.test(walkin),
  'kiosk uses the concrete reason instead of a bare "Status unknown"');
ok(!/'Status unknown - printer not reporting'/.test(walkin),
  'the old unhelpful string is gone');
ok(/Cannot reach printer/.test(walkin), 'kiosk says the printer cannot be reached');
ok(/data\.printer_error/.test(admin), 'admin reads the reason');
ok(/function updatePrinterDiag/.test(admin), 'admin renders a diagnostics note');
ok(/polling queue/.test(admin), 'admin shows which queue is being polled');

// --- the reason must identify WHICH address failed -------------------------
ok(/cannot reach %s/.test(worker) && /CONFIG\["printer_uri"\]/.test(worker),
  'the worker names the URI it failed to reach');
ok(/printer_target:\s*String\(body\.printer_name/.test(backend),
  'the polled queue name is recorded');

// --- never overwrite a known target with an empty one ----------------------
ok(/if \(!row\.printer_target\) delete row\.printer_target/.test(backend),
  'an empty printer_name cannot blank out a known target');

if (failed) process.exit(1);
console.log('  ok      an unreadable printer can explain itself');