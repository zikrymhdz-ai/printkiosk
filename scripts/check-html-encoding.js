// Fails if any page shows mojibake again.
//
// The pages were once rewritten by a PowerShell command that read them as
// Windows-1252 and wrote them back as UTF-8, encoding every non-ASCII
// character twice. The file picker rendered literal "Next a-circumflex-euro-
// quote Settings". Nothing about that is a syntax error, so every other check
// passed while the page was visibly broken.
//
// This looks for the tell-tale CP1252-of-UTF-8 lead character sequences, and
// also for U+FFFD, which is what a lossy decode leaves behind.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'website/customer.html',
  'website/upload.html',
  'website/pagerange.js',
  'website/pstore.js',
  'kiosk/walkin.html',
];

// U+00E2 is the first byte of most 3-byte UTF-8 sequences, so a mis-encoded
// run nearly always starts with it.
const MOJIBAKE = /[\u00C2-\u00E4][\u0080-\u00BF\u20AC\u201A-\u201E\u2020-\u2026]/;
const REPLACEMENT = /\uFFFD/;

let failed = 0;

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  const text = fs.readFileSync(full, 'utf8');

  if (REPLACEMENT.test(text)) {
    const line = text.split('\n').findIndex((l) => REPLACEMENT.test(l)) + 1;
    console.log('  FAILED  ' + rel + ':' + line + ' contains U+FFFD (lossy decode)');
    failed++;
    continue;
  }

  const m = text.match(MOJIBAKE);
  if (m) {
    const line = text.slice(0, m.index).split('\n').length;
    console.log('  FAILED  ' + rel + ':' + line + ' contains double-encoded UTF-8: '
      + Array.from(m[0]).map((c) => 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));
    console.log('          run: node scripts/fix-html-encoding.js');
    failed++;
    continue;
  }

  console.log('  ok      ' + rel + '  encoding clean');
}

if (failed) {
  console.log('  -> ' + failed + ' failed');
  process.exit(1);
}
console.log('  ok      no page is serving mojibake');
