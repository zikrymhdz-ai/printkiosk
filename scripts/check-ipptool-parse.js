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

// "printer-name" + _TAG + r"\s*=\s*..."  ->  the pieces.
// A single-line match stopped working when the definition wrapped: it captured
// only "PRINTER_NAME_RE = re.compile(" and produced a pattern built from
// nothing. Read forward to the statement's closing parenthesis instead.
function patternFromDecl(decl) {
  const parts = [];
  const rx = /r"((?:[^"\\]|\\.)*)"|_TAG|_VALUE/g;
  let m;
  while ((m = rx.exec(decl)) !== null) {
    if (m[1] !== undefined) parts.push(pyR(m[1]));
    else if (m[0] === '_TAG') parts.push(TAG);
    else if (m[0] === '_VALUE') parts.push(VALUE);
  }
  return parts.join('');
}

// Cut the declaration at its real terminator. Scanning for the first ")"
// truncates inside the _TAG fragment itself, whose character class contains
// literal brackets and parens, and produces an "Unterminated group" pattern.
function declFrom(name) {
  const at = src.indexOf(name + ' = ');
  if (at === -1) throw new Error('cannot find ' + name);
  const compileAt = src.indexOf('re.compile(', at);
  const end = src.indexOf('re.MULTILINE)', compileAt);
  return src.slice(at, end === -1 ? src.indexOf('\n', compileAt) : end + 're.MULTILINE)'.length);
}

const TAG = pyR((/_TAG = r"((?:[^"\\]|\\.)*)"/.exec(src) || [])[1] || '');
const VALUE = pyR((/_VALUE = r"((?:[^"\\]|\\.)*)"/.exec(src) || [])[1] || '');

function flagsFrom(line) {
  const f = [];
  if (/re\.MULTILINE/.test(line)) f.push('m');
  return f.join('');
}

const TONER = {};
for (const line of src.split('\n')) {
  const m = /^\s*"(\w+)":\s*re\.compile\(/.exec(line);
  if (m) TONER[m[1]] = new RegExp(patternFromDecl(line), flagsFrom(line));
}
const PRINTER_NAME_RE = new RegExp(patternFromDecl(declFrom('PRINTER_NAME_RE')), 'm');

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

// Brother reports the SERIAL as printer-name, so a value-only capture must not
// swallow the rest of the response.
const BROTHER = [
  'Get-Printer-Attributes:',
  '    printer-name (nameWithoutLanguage) = BRW145A41F176AD',
  '    printer-make-and-model (nameWithoutLanguage) = Brother HL-L3240CDW series',
  '    printer-toner-black-remaining (integer) = 91 (% of supply)',
].join('\n');
const nameHit = PRINTER_NAME_RE.exec(BROTHER);
ok(nameHit && nameHit[1].trim() === 'BRW145A41F176AD',
  'the serial is captured on its own: ' + (nameHit ? JSON.stringify(nameHit[1].trim()) : 'none'));
ok(nameHit && !/\n/.test(nameHit[1]),
  'the capture stops at the end of the line, not the end of the response');

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

// --- the generated ipptool request must be valid ---------------------------
// This was the real cause: the test file used the RESPONSE form "value-charset"
// instead of the request form "charset". ipptool refused to parse it
// ("Unexpected token ATTRIBUTE seen on line 4"), never sent the request, and
// still exited 0 - so the worker reported "reachable" while asking nothing.
const tf = src.match(/def get_printer_attrs_test\(\):[\s\S]*?return p/);
ok(!!tf, 'get_printer_attrs_test found');
if (tf) {
  const body = tf[0];
  // Only the payload that is written matters. The docstring deliberately names
  // the bad forms to explain the bug, and an assertion that scanned it would
  // fail on its own explanation.
  // The LAST f.write in this function is the fallback IPP request; an earlier
  // one belongs to _auth_args, which the slice also drags in, so the first
  // match is not necessarily the one being asserted about.
  const writes = body.match(/f\.write\([\s\S]*?\)\s*\n/g) || [];
  ok(writes.length > 0, 'the hand-written fallback payload found');
  const payload = writes.length ? writes[writes.length - 1] : '';
  ok(!/value-charset|value-uri|value-naturalLanguage/.test(payload),
    'no response-style "value-*" used in a request');
  ok(payload.includes('charset "utf-8"'),
    'the fallback uses the request syntax');
  ok(payload.includes('requested-attributes all'),
    'the fallback requests all attributes too');

  // The MAIN path is now derived from CUPS's own file with the
  // requested-attributes block injected. Nothing hand-authored IPP is used when
  // CUPS is present, which is what removed our ability to produce an unparseable
  // request.
  ok(body.includes('CUPS_SYSTEM_TEST') && body.includes('requested-attributes all'),
    'the request is built from CUPS\'s own file with all attributes requested');
  ok(/return CUPS_SYSTEM_TEST/.test(body),
    'if the file cannot be enhanced, CUPS\'s original is used untouched');
}

// A completed request must contain attribute lines; without this check an
// exit-0 parse failure was reported as a reachable printer.
ok(/re\.search\(r"\^\\s\*\\\[\\d\+\]\/", text, re\.MULTILINE\)/.test(worker)
   || worker.includes('ipptool returned no attributes'),
  'a run with no attribute lines is not reported as reachable');

// --- an option this ipptool does not have must not read as an empty printer
// The build on the Pi rejects -k with "Unknown option" and prints its usage.
// The worker read that reply as "reachable, but no toner attributes", so a
// printer that was answering perfectly looked inkless for a day, with the
// usage text sitting in the error field where nobody would read it.
ok(/_ipptool_supports_k/.test(worker), 'the worker checks whether ipptool accepts -k');
// Position rather than a character window: the guard lives inside _auth_args,
// and a distance-based match is brittle against the docstring length.
const authAt = worker.indexOf('def _auth_args');
const guardAt = worker.indexOf('if not _ipptool_supports_k():');
ok(authAt > 0 && guardAt > authAt,
  'credentials are not sent when this ipptool cannot accept them');
ok(/Unknown option\|Usage:\\s\*ipptool/.test(worker),
  'a usage/usage-error reply is detected as ipptool refusing our arguments');
ok(/rejected our arguments and never reached the printer/.test(worker),
  'and is reported as never having reached the printer');
// The distinction that matters: a usage error must be decided BEFORE the
// "no toner attributes" conclusion, or the misdiagnosis returns.
const usageAt = worker.indexOf('rejected our arguments');
const noTonerAt = worker.indexOf('no toner attributes in the response');
ok(usageAt > 0 && noTonerAt > 0 && usageAt < noTonerAt,
  'the usage check runs before the empty-supplies conclusion');

// --- an authorization refusal must not end the search for a working request
// The enhanced request is refused by this printer while the plain one is
// allowed anonymously. A refusal still prints attribute lines, so it used to
// satisfy the "did anything answer" test and break the loop on the first
// candidate - meaning the request that works was never attempted, and the
// journal accused a printer that answers unauthenticated commands by hand.
ok(/def _looks_unauthorized/.test(worker), 'authorization refusals are recognised');

// Position matters: the refusal check must sit before the attribute-lines
// break, or the search still ends on the first refusal. Anchored on `text or ""`
// because the per-probe logger above re.searches the same pattern over `t`,
// and a bare pattern search finds that one instead.
const attrCheck = worker.indexOf('re.search(r"^\\s+\\S[^\\n]*?=\\s*\\S", text or ""');
const attrBreak = worker.indexOf('break', attrCheck);
const guard = worker.indexOf('if _looks_unauthorized(text):');
ok(guard > 0 && attrCheck > 0 && guard < attrCheck && attrBreak > attrCheck,
  'a refusal moves on to the next candidate instead of ending the search');
ok(worker.indexOf('auth_denied = True') > worker.indexOf('for test_path in candidates'),
  'the refusal is remembered for the final verdict');
ok(/supply probe/.test(worker),
  'each candidate request reports its own outcome, so the loop is diagnosable');

// Only claim the printer demands a password once every request was refused.
ok(/every request was refused for authentication/.test(worker),
  'the password is only blamed once all requests were refused');
ok(!/return None, False, \(\s*"printer requires authentication/.test(worker),
  'a single refusal no longer produces a blanket authentication demand');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      ipptool output parses in both shapes');