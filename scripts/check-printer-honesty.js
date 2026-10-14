// Printer status honesty checks.
//
// The problem this guards: printer_status.paper_level was never measured. No
// code read it from the printer, so the only writer was the admin override, and
// a hand-typed 50 ended up on the customer screen looking like a reading.
//
// These assertions fail if anything starts writing paper by hand again, or if
// the kiosk stops warning before the customer pays.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const printer = read('netlify/functions/printer.js');
const worker = read('pi/print-worker.py');
const walkin = read('kiosk/walkin.html');
const admin = read('admin/admin.html');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- paper must be derived, never measured or typed -------------------------
ok(/function computePaper/.test(printer),
  'paper is computed by computePaper()');
ok(/pages\s*\*\s*copies/.test(printer),
  'paper counts real sheets via pages * copies on completed jobs');
ok(!/levels\.paper/.test(printer),
  'reportSupplies ignores any paper value the worker sends (not a sensor)');
ok(!/paper_level:\s*paper/.test(admin),
  'admin no longer submits a hand-typed paper_level');
ok(!/readLevel\('setPaper'/.test(admin),
  'admin no longer validates/reads paper as a settable level');
ok(/function refillPaper/.test(admin) && /refill-paper/.test(admin),
  'admin has a "Paper topped up" action that moves the refill marker');
ok(/case 'refill-paper'/.test(printer) && /function refillPaper/.test(printer),
  'refill-paper route exists and is wired');

// --- the estimate must be labelled as an estimate --------------------------
ok(/paper_derived/.test(printer) && /derived/.test(walkin),
  'derived flag travels to the kiosk so the number is labelled an estimate');
ok(/~' \+ .*remaining.*sheets|sheets left/.test(walkin) ||
   /paperVal\.textContent\s*=\s*'~'/.test(walkin),
  'kiosk shows estimated sheets rather than a bare percentage');
ok(/not measured by a sensor|No standard IPP attribute/.test(admin + '\n' + printer),
  'the lack of a paper sensor is documented where staff will see it');

// --- the kiosk must warn BEFORE printing -----------------------------------
ok(/function printTapped/.test(walkin),
  'print button goes through printTapped() rather than straight to closeReceipt()');
const tap = walkin.match(/function printTapped\(\) \{([\s\S]*?)\n\}/);
ok(!!tap, 'printTapped body found');
if (tap) {
  ok(/can_print\s*===\s*false/.test(tap[1]),
    'printTapped blocks when the backend says the printer cannot print');
  ok(/warn\s*===\s*'paper low'/.test(tap[1]),
    'printTapped warns on low paper before sending the job');
  // A low-paper warning must not be a silent pass-through to printing.
  ok(!/g\.warn\s*===\s*'paper low'[\s\S]{0,400}?closeReceipt\(\);/.test(tap[1]),
    'low paper does NOT fall through to printing without warning');
}

// --- real CUPS stop reason must reach the dashboard ------------------------
ok(/printer_alert/.test(worker) && /"alert":\s*alert/.test(worker),
  'worker pushes printer_alert() on the periodic supply poll, not just at print time');
ok(/printer_alert/.test(printer) && /printer_alert\s*\|\|/.test(printer),
  'backend stores the stop reason on printer_status');
ok(/if \(alert\)/.test(walkin),
  'kiosk shows the real stop reason instead of a misleading "Online"');
// The old derivation: status was purely a function of toner reachability.
ok(!/status:\s*unreadable\s*\?\s*'unknown'\s*:\s*\(lowest\s*<=\s*15/.test(walkin),
  'kiosk no longer treats toner reachability alone as "Online"');

if (failed) process.exit(1);
console.log('  ok      printer status is real where it can be, honest where it cannot');