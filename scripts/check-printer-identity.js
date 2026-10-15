// Which printer are we actually talking to?
//
// There are two Brother printers on this network (HL-L3240CDW and DCP-T430W),
// plus an HP. So:
//   - the CUPS queue name "Brother" identifies neither
//   - the default URI ipp://Brother.local/... does not resolve at all
//   - the migration originally seeded printer_target = 'Brother', which looks
//     like a real answer while meaning nothing
//
// Identity has to come from the device (the printer-name attribute it returns
// over IPP) and be checked against the model this shop expects.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const worker = read('pi/print-worker.py');
const backend = read('netlify/functions/printer.js');
const install = read('pi/install.sh');
const admin = read('admin/admin.html');
const migration = read('migrations/20261015_printer_diagnostics.sql');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- identity must be read from the device, not assumed -------------------
ok(/PRINTER_NAME_RE\s*=\s*re\.compile/.test(worker), 'the model string is parsed from the IPP response');
// The definition now wraps onto a second line because the pattern is built from
// _TAG and _VALUE fragments, so the attribute name is not adjacent to
// re.compile( any more.
ok(/"printer-name" \+ _TAG/.test(worker), 'the regex targets the printer-name attribute');
ok(/"printer-make-and-model" \+ _TAG/.test(worker), 'and printer-make-and-model');
ok(/"printer-info" \+ _TAG/.test(worker), 'and printer-info');
ok(/"printer_model":\s*model/.test(worker), 'the worker reports the model it was told by the printer');
ok(/def reported_model/.test(worker), 'reported_model() helper exists');

// --- read_supplies must actually return it --------------------------------
ok(/return levels, True, "", reported_model\(text\)/.test(worker),
  'read_supplies returns the reported model on success');
ok(/"ipptool not installed[^"]*", None/.test(worker),
  'failure paths return a None model rather than the wrong arity');

// --- the wrong Brother must not be filed as ours --------------------------
ok(/"expected_model"/.test(worker), 'worker config carries an expected model');
ok(/not any\(expected\.lower\(\) in s\.lower\(\) for s in identity\)/.test(worker),
  'the expected model is matched case-insensitively against every identity attribute');
// Brother reports printer-name as the unit serial, so a single-attribute
// comparison rejects the correct printer.
ok(/reported_model\(text\)/.test(worker) && /MAKE_MODEL_RE/.test(worker),
  'identity is gathered from printer-name, make-and-model and printer-info');
ok(/prefers the string naming the model|identity\[0\]/.test(worker),
  'the model is reported from whichever attribute actually names it');
ok(/wrong printer/.test(worker), 'a mismatch is reported as "wrong printer"');
ok(/levels, online = None, False/.test(worker),
  'levels are suppressed when the wrong printer answered');

// --- the backend must store and expose identity ---------------------------
ok(/printer_model:\s*String\(body\.printer_model/.test(backend), 'printer_model is stored');
ok(/printer_uri:\s*String\(body\.printer_uri/.test(backend), 'printer_uri is stored');
ok(/printer_model:\s*row\.printer_model \|\| null/.test(backend), 'printer_model is returned by the status API');
// Empty values must not erase what we already know.
for (const f of ['printer_target', 'printer_model', 'printer_uri']) {
  ok(new RegExp('if \\(!row\\[' + f + '\\]\\) delete row\\[' + f + '\\]').test(backend)
     || /for \(const f of \['printer_target', 'printer_model', 'printer_uri'\]\)/.test(backend),
    f + ' is not blanked by an empty report');
}

// --- no ambiguous brand may be asserted as identity -----------------------
ok(!/SET printer_target = 'Brother'/.test(migration),
  'the migration does NOT seed the ambiguous brand as the target');
ok(/two Brother printers/i.test(migration),
  'the migration explains why a brand name is not an identity');

// --- the admin must show which device, not just the queue -----------------
ok(/data\.printer_model/.test(admin), 'admin reads the model from the API');
ok(/Model: /.test(admin) && /Queue: /.test(admin) && /Address: /.test(admin),
  'admin shows model, queue and address');
ok(/printerIdentity/.test(admin), 'admin has a persistent identity line');

// --- install.sh must pick by model, not brand -----------------------------
ok(/EXPECTED_MODEL="\$\{EXPECTED_MODEL:-HL-L3240CDW\}"/.test(install),
  'install.sh pins the expected model');
ok(/Refusing to choose/.test(install),
  'install.sh refuses to guess when two printers match');

if (failed) process.exit(1);
console.log('  ok      printer identity comes from the device, not the brand');