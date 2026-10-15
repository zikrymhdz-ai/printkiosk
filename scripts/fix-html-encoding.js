// Repairs double-encoded UTF-8 in the HTML pages.
//
// A PowerShell rewrite read these files as Windows-1252 and wrote them back as
// UTF-8, so every non-ASCII character was encoded twice and the pages showed
// literal mojibake in the file picker - "Next a-circumflex-euro-quote Settings"
// where an em dash belonged.
//
// The original bytes are recoverable exactly, because each mojibake character
// is one CP1252 byte of the UTF-8 sequence that was misread:
//
//   U+00E2 U+20AC U+201D -> E2 80 94 -> U+2014  em dash
//   U+00E2 U+20AC U+00A6 -> E2 80 A6 -> U+2026  ellipsis
//
// check-html-encoding.js fails the build if either ever comes back.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['website/customer.html', 'website/upload.html', 'website/pagerange.js'];

const REPAIRS = [
  ['\u00E2\u20AC\u201D', '\u2014'], // a-circumflex euro curly-quote  -> em dash
  ['\u00E2\u20AC\u00A6', '\u2026'], // a-circumflex euro broken-bar   -> ellipsis
];

let changed = 0;
for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  let text = fs.readFileSync(full, 'utf8');
  const before = text;
  let hits = 0;
  for (const [bad, good] of REPAIRS) {
    const parts = text.split(bad);
    hits += parts.length - 1;
    text = parts.join(good);
  }
  if (text !== before) {
    fs.writeFileSync(full, text, 'utf8');
    changed++;
    console.log('  repaired ' + rel + '  (' + hits + ' sequence(s))');
  }
}

console.log(changed ? '  done.' : '  nothing to repair.');
