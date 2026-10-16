// Every CONFIG key the worker READS must also be DEFINED.
//
// This exists because of a silent, total outage. print-worker.py read
// CONFIG["printer_uri"] in four places and defined it in none, while
// install.sh went on writing PRINTER_URI into the env file - an environment
// variable nothing read. Every supply poll raised KeyError: 'printer_uri', the
// supplies block aborted before reporting anything, and the effect was:
//
//   - no toner or ink levels in admin or the kiosk, ever
//   - last_checked frozen, so freshness could not even reveal it
//   - the worker still running, still claiming jobs, still printing
//
// The journal said only "supply report failed: 'printer_uri'" once every five
// minutes. Easy to scroll past, and impossible to diagnose from the dashboard,
// where the printer had simply stopped existing.
//
// The general rule is the point, not this one key: a missing CONFIG entry is a
// crash inside a background thread of control, not a crash of the process, so
// nothing restarts and nothing surfaces it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(ROOT, 'pi', 'print-worker.py'), 'utf8');
const install = fs.readFileSync(path.join(ROOT, 'pi', 'install.sh'), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const block = worker.match(/CONFIG = \{[\s\S]*?\n\}/);
ok(!!block, 'the CONFIG literal was found');
if (!block) { console.log('  -> ' + failed + ' failed'); process.exit(1); }

// Keys as they are DEFINED inside the CONFIG literal.
const defined = new Set([...block[0].matchAll(/["'](\w+)["']\s*:/g)].map((m) => m[1]));
// Keys as they are READ anywhere in the file.
const read = new Set([...worker.matchAll(/CONFIG\[["'](\w+)["']\]/g)].map((m) => m[1]));

const missing = [...read].filter((k) => !defined.has(k));
ok(missing.length === 0,
  'every CONFIG key read is also defined'
  + (missing.length ? ' - missing: ' + missing.join(', ') : ' (' + read.size + ' checked)'));

// The specific key that caused the outage, named so the failure is legible.
ok(defined.has('printer_uri'), 'CONFIG defines printer_uri');
ok(/os\.environ\.get\(["']PRINTER_URI["']/.test(worker),
  'printer_uri is read from the environment install.sh writes');

// A hardcoded default would hide a missing env file behind a wrong address,
// pointing supplies at a printer that is not there.
ok(!/["']printer_uri["']\s*:\s*os\.environ\.get\(["']PRINTER_URI["'][^)]*\)\s*,/.test(block[0])
  || /_queue_device_uri/.test(worker),
  'a missing PRINTER_URI falls back to the CUPS device rather than to a guess');

// Printing must not depend on the supply URI. `lp` is given the queue name, so
// losing the address costs visibility, not service.
ok(!/sys\.exit\(1\)[\s\S]{0,200}printer_uri/.test(worker),
  'an unresolvable supply URI does not stop the worker from printing');
ok(/WARNING: no IPP address/.test(worker),
  'an unresolvable supply URI is announced loudly at startup');

// The startup line must name the supplies target, so this is diagnosable from
// one glance at the journal instead of 25 hours of scrolling.
ok(/supplies=%s/.test(worker), 'the startup log states where supplies are read from');

// install.sh must not keep writing a variable the worker ignores.
ok(/PRINTER_URI=/.test(install), 'install.sh writes PRINTER_URI to the env file');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      the worker cannot read a config key it never defined');