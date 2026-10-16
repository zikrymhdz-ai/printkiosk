// Make AGENT.md pure ASCII.
//
// The pages in this repo are kept ASCII on purpose, and PowerShell edits have
// twice corrupted UTF-8 here. A documentation file an agent will open and edit
// deserves the same protection, so the handful of typographic characters are
// swapped for their plain equivalents. The check script enforces it from now on.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'AGENT.md');
let text = fs.readFileSync(file, 'utf8');

const SWAPS = {
  '\u2014': '-',   // em dash
  '\u2013': '-',   // en dash
  // A middle dot inside a Markdown TABLE CELL must never become a pipe: that
  // silently turns one row into extra columns and the table stops rendering as
  // a table. A comma is the safe separator.
  '\u00b7': ',',
  '\u2192': '->',  // right arrow
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2026': '...', // ellipsis
  '\u00a0': ' ',   // non-breaking space
};

const before = [...new Set(text.match(/[^\x00-\x7F]/g) || [])];
for (const [from, to] of Object.entries(SWAPS)) {
  text = text.split(from).join(to);
}

const after = [...new Set(text.match(/[^\x00-\x7F]/g) || [])];
if (before.length) {
  fs.writeFileSync(file, text, 'utf8');
  console.log('  replaced ' + before.length + ' non-ASCII character type(s)');
  console.log('  from: ' + before.map((c) => 'U+' + c.charCodeAt(0).toString(16).toUpperCase()).join(' '));
}
console.log('  ' + (after.length ? 'still non-ASCII: ' + after.join('') : 'AGENT.md is pure ASCII'));
console.log('  lines: ' + text.split('\n').length);