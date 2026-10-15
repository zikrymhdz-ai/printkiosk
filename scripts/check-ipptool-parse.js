// ipptool output parsing.
//
// The printer was reachable the whole time and reported
//   "reachable, but no toner attributes in the response"
// which looked exactly like a missing or broken printer. The actual cause was
// our patterns: ipptool -tv prints an optional parenthesised value tag between
// the attribute name and the '=', e.g.
//
//   [12] printer-toner-black-remaining (integer) = 87 (% of supply) (integer)
//   [13] printer-name (nameWithoutLanguage) = Brother HL-L3240CDW series
//
// and the patterns required '=' immediately after the name.
//
// Both shapes are exercised here, against the real patterns extracted from
// print-worker.py so this cannot drift from the implementation.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('netlify/../pi/print-worker.py', 'utf8');
const worker = src;

// TONER_RE is a dict literal, so it needs brace matching. The others are single
// statements containing re.compile(...) and no braces at all, where brace
// matching would run off into an unrelated block further down the file.
function extractBlock(name) {
  const start = src.indexOf(name + ' = ');
  if (start === -1) throw new Error('cannot find ' + name);
  const i = src.indexOf('{', start);
  let depth = 0, end = i;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  return src.slice(start, end + 1);
}

function extractLine(name) {
  const start = src.indexOf(name + ' = ');
  if (start === -1) throw new Error('cannot find ' + name);
  const nl = src.indexOf('\n', start);
  return src.slice(start, nl).trim();
}

// The worker is Python. The patterns are read straight out of the source and
// handed to RegExp as values -- they are never embedded in JavaScript source
// text. That distinction matters: inside a JS string literal "\s" collapses to
// "s" before RegExp sees it, so an earlier version of this test built
//   _TAG = "(?:s*([^)]*))?"
// and silently tested a pattern that could never match anything. Passing the
// raw characters to new RegExp() preserves them.
function pyR(text) {
  // A Python r-string is literal apart from \" and \', which are just quotes.
  return text.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

// "printer-toner-black-remaining" + _TAG + r"\s*=\s*(\d+)"  ->  the pieces
function patternFrom(line) {
  const parts = [];
  const rx = /r"((?:[^"\\]|\\.)*)"|_TAG/g;
  let m;
  while ((m = rx.exec(line)) !== null) {
    parts.push(m[1] === undefined ? TAG : pyR(m[1]));
  }
  return parts.join('');
}
const TAG = pyR((/_TAG = r"((?:[^"\\]|\\.)*)"/.exec(src) || [])[1] || '');

function flagsFrom(line) {
  const f = [];
  if (/re\.MULTILINE/.test(line)) f.push('m');
  return f.join('');
}

const TONER = {};
for (const line of src.split('\n')) {
  const m = /^\s*"(\w+)":\s*re\.compile\(/.exec(line);
  if (m) TONER[m[1]] = new RegExp(patternFrom(line), flagsFrom(line));
}
const nameLine = src.split('\n').find(l => /PRINTER_NAME_RE = re\.compile\(/.test(l)) || '';
const PRINTER_NAME_RE = new RegExp(patternFrom(nameLine), flagsFrom(nameLine));

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

const NO_TAG = [
  "    [12] printer-uri = 'dnssd://Brother%20HL-L3240CDW%20series._ipp._tcp.local/?uuid=e3'",
  "    [13] printer-name = 'Brother HL-L3240CDW series'",
  "    [14] printer-toner-black-remaining = 87 (% of supply) (integer)",
  "    [15] printer-toner-cyan-remaining = 42 (% of supply) (integer)",
  "    [16] printer-toner-magenta-remaining = 13 (% of supply) (integer)",
  "    [17] printer-toner-yellow-remaining = 0 (% of supply) (integer)",
].join('\n');

// This is the shape that actually broke it.
const WITH_TAG = [
  "    [12] printer-uri (uri) = 'dnssd://Brother%20HL-L3240CDW%20series._ipp._tcp.local/'",
  "    [13] printer-name (nameWithoutLanguage) = Brother HL-L3240CDW series",
  "    [14] printer-make-and-model (nameWithoutLanguage) = Brother HL-L3240CDW series",
  "    [15] printer-toner-black-remaining (integer) = 87 (% of supply)",
  "    [16] printer-toner-cyan-remaining (integer) = 42 (% of supply)",
  "    [17] printer-toner-magenta-remaining (integer) = 13 (% of supply)",
  "    [18] printer-toner-yellow-remaining (integer) = 0 (% of supply)",
].join('\n');

for (const [label, text] of [['no value tag', NO_TAG], ['with value tag', WITH_TAG]]) {
  const found = {};
  for (const [k, rx] of Object.entries(TONER)) {
    const m = rx.exec(text);
    if (m) found[k] = parseInt(m[1], 10);
  }
  ok(Object.keys(found).length === 4, label + ': all four toners parsed (' + Object.keys(found).length + '/4)');
  if (Object.keys(found).length === 4) {
    ok(found.toner_black === 87 && found.toner_cyan === 42
      && found.toner_magenta === 13 && found.toner_yellow === 0,
      label + ': values correct -> ' + JSON.stringify(found));
  }
  const nm = PRINTER_NAME_RE.exec(text);
  ok(!!nm, label + ': model captured');
  if (nm) {
    ok(nm[1].trim().replace(/["']/g, '') === 'Brother HL-L3240CDW series',
      label + ': model reads "' + nm[1].trim().replace(/["']/g, '') + '"');
  }
}

// Must not latch onto make-and-model, which sits next to printer-name.
ok(!/make-and-model/.test(String((PRINTER_NAME_RE.exec(WITH_TAG) || [])[1] || '')),
  'does not capture make-and-model instead of name');

// A zero reading is a REAL reading (empty toner), not "missing".
const z = TONER.toner_yellow.exec(WITH_TAG);
ok(z && parseInt(z[1], 10) === 0, 'a 0% cartridge parses as 0, not as absent');

// The other Brother on the network must parse too, so the wrong-printer guard
// has something to compare against.
const other = "    [13] printer-name (nameWithoutLanguage) = Brother DCP-T430W series";
ok(String((PRINTER_NAME_RE.exec(other) || [])[1] || '').trim() === 'Brother DCP-T430W series',
  'the other Brother parses too, so a mismatch can be detected');

// --- both streams must be searched -----------------------------------------
// ipptool writes the attribute dump to STDERR. Parsing only stdout saw a single
// echoed argument and concluded the printer was unreadable while it was
// answering perfectly.
ok(/text = \(proc\.stdout or ""\) \+ "\\n" \+ \(proc\.stderr or ""\)/.test(worker),
  'read_supplies searches both stdout and stderr');
// Substring rather than a regex: the literal "[:600]" is what ships, and a
// regex for it proved to be fussier than the fact it asserts.
ok(worker.includes('[:600]'),
  'a 600-char sample of the real response is reported when parsing fails');
ok(/Got: /.test(worker),
  'the failure message includes what ipptool actually returned');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      ipptool output parses in both shapes');