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
// The wording had to change from "Cannot reach printer": toner is read over
// IPP, but the job goes out through the CUPS queue, so the read can fail while
// printing works. Seen live 2026-10-27 - the queue printed Brother-37 while
// every poll reported "Host is down", and the kiosk told customers the printer
// could not be reached.
ok(/Printer status unavailable/.test(walkin),
  'kiosk says the STATUS is unavailable rather than that the printer is gone');
ok(!/Cannot reach printer/.test(walkin),
  'it no longer claims a reachable-but-unreadable printer cannot be reached');
ok(/data\.printer_error/.test(admin), 'admin reads the reason');
ok(/function updatePrinterDiag/.test(admin), 'admin renders a diagnostics note');
// Identity moved to its own persistent line, because the queue name alone cannot
// identify which Brother is installed.
ok(/printerIdentity/.test(admin), 'admin shows which printer is installed');

// --- the reason must identify WHICH address failed -------------------------
ok(/cannot reach %s/.test(worker) && /CONFIG\["printer_uri"\]/.test(worker),
  'the worker names the URI it failed to reach');
ok(/printer_target:\s*String\(body\.printer_name/.test(backend),
  'the polled queue name is recorded');

// --- never overwrite a known identity with an empty one -------------------
// A poll that fails early (ipptool missing) sends no printer_name; blanking the
// column would erase the last thing we knew about which machine is installed.
ok(/for \(const f of \['printer_target', 'printer_model', 'printer_uri'\]\)/.test(backend)
   && /if \(!row\[f\]\) delete row\[f\]/.test(backend),
  'empty identity fields are dropped rather than blanking what we already know');

// --- a column from a newer migration must not cost the whole reading ------
// PostgREST rejects the ENTIRE row with 42703 (or PGRST204) when one column is
// missing. printer_error/target/model/uri arrived with
// 20261015_printer_diagnostics.sql, so deploying the function before running
// that SQL made every supply report fail - the printer then looked like it had
// never reported, which is the state in which the kiosk refuses to send a paid
// job. The three older fallbacks cover codes 23502/23503/23514 and did nothing
// for this.
ok(/42703/.test(backend) && /PGRST204/.test(backend),
  'reportSupplies retries when a column is missing from the schema cache');
ok(/OPTIONAL_SUPPLY_COLUMNS/.test(backend),
  'and names the newer columns it can drop as a last resort');

if (failed) process.exit(1);
console.log('  ok      an unreadable printer can explain itself');