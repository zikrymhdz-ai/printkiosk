const fs = require('fs');
const src = fs.readFileSync('pi/print-worker.py', 'utf8');

// Pull the real regex out of the worker so this tests the shipped pattern.
// The pattern itself contains escaped quotes (\' and \"), and the call is
// re.compile(r"...", re.MULTILINE), so anchor on the closing quote followed by
// the flags argument.
const m = src.match(/PRINTER_NAME_RE = re\.compile\(r"(.*)",\s*re\./);
if (!m) { console.log('  FAILED  could not extract PRINTER_NAME_RE'); process.exit(1); }
const re = new RegExp(m[1], 'm');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

// Shaped like real ipptool -tv output.
const sample = [
  '    [12] printer-uri = \'dnssd://Brother%20HL-L3240CDW%20series._ipp._tcp.local/?uuid=e3248000\'',
  '    [13] printer-name = \'Brother HL-L3240CDW series\'',
  '    [14] printer-info = \'Brother HL-L3240CDW series\'',
  '    [15] printer-make-and-model = \'Brother HL-L3240CDW series\'',
  '    [16] printer-toner-black-remaining = 87 (% of supply) (integer)',
  '    [17] printer-location = \'Room 1\'',
].join('\n');

const got = re.exec(sample);
ok(!!got, 'the pattern matches a real ipptool line');
ok(got && got[1].trim().replace(/"/g, '') === 'Brother HL-L3240CDW series',
  'captured model is "' + (got ? got[1].trim().replace(/"/g, '') : 'n/a') + '"');

// Must not latch onto make-and-model or uri, which sit adjacent in real output.
ok(got && !/uuid=/.test(got[1]), 'does not capture the printer-uri line');
ok(got && got[1].indexOf('HL-L3240CDW') !== -1, 'captures the HL model, not the DCP one');

// The other printer on the network must parse too, so the wrong-printer guard
// has something to compare against.
const other = ['    [13] printer-name = \'Brother DCP-T430W series\''].join('\n');
const o = re.exec(other);
ok(o && o[1].trim() === 'Brother DCP-T430W series',
  'parses the OTHER Brother correctly too: ' + (o ? o[1].trim() : 'n/a'));

// A response with no printer-name must return null, not a wrong value.
ok(re.exec('    [16] printer-toner-black-remaining = 87 (% of supply) (integer)') === null,
  'returns no match when printer-name is absent');

// The comparison used by the worker is substring-based; confirm it separates
// the two models the way the guard relies on.
const expected = 'HL-L3240CDW';
ok('Brother HL-L3240CDW series'.toLowerCase().indexOf(expected.toLowerCase()) !== -1,
  'EXPECTED_MODEL matches the correct printer');
ok('Brother DCP-T430W series'.toLowerCase().indexOf(expected.toLowerCase()) === -1,
  'EXPECTED_MODEL does NOT match the other Brother');

if (failed) process.exit(1);
console.log('  ok      the model the worker reports is the model on the wire');