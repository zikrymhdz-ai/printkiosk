// Entities belong in HTML markup, not in JS strings.
//
// Converting the pages to pure ASCII replaced an ellipsis with "&hellip;".
// Inside markup that is correct, but showUploadOverlay() and the hints assign
// with textContent, so the customer saw the literal characters
// "Preparing your file&hellip;" on the uploading screen.
//
// This rewrites only the JS-string occurrences to plain ASCII "...".
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['website/customer.html', 'website/upload.html'];

const FIXES = [
  ["sub: 'Preparing your file&hellip;'", "sub: 'Preparing your file...'"],
  ["' of ' + bulkFiles.length + '&hellip;'", "' of ' + bulkFiles.length + '...'"],
  ["'Almost done&hellip;'", "'Almost done...'"],
  ["'Finalising your order&hellip;'", "'Finalising your order...'"],
  ["hint.textContent = 'Saving picture&hellip;'", "hint.textContent = 'Saving picture...'"],
  ["'Sending your document to the shop&hellip;'", "'Sending your document to the shop...'"],
  ["+ ' files\\u2026'", "+ ' files...'"],
  ["sub: 'Uploading file, please wait&hellip;'", "sub: 'Uploading file, please wait...'"],
];

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  let text = fs.readFileSync(full, 'utf8');
  let n = 0;
  for (const [bad, good] of FIXES) {
    if (text.includes(bad)) {
      n += text.split(bad).length - 1;
      text = text.split(bad).join(good);
    }
  }
  if (n) {
    fs.writeFileSync(full, text, 'utf8');
    console.log('  fixed ' + rel + '  (' + n + ')');
  }
}

// Report anything left inside a JS string, where an entity would show raw.
//
// The reliable test is whether we are inside a <script> block: entities in
// ordinary markup render as characters, but inside a script they are just text
// inside a string literal, and textContent prints them verbatim. Tracking angle
// brackets does not work, because text BETWEEN tags is still markup.
let bad = 0;
const ENTITY = /&(hellip|mdash|ndash|rsquo|ldquo|rdquo);/;
for (const rel of FILES) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  let inScript = false;
  lines.forEach((line, i) => {
    if (/<script\b/i.test(line)) inScript = true;
    const closing = /<\/script>/i.test(line);
    if (inScript && ENTITY.test(line)) {
      console.log('  STILL RAW  ' + rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 78));
      bad++;
    }
    if (closing) inScript = false;
  });
}
if (bad) process.exit(1);
console.log('  no entity is left where textContent will show it raw.');
