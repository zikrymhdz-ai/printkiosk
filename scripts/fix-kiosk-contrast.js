// Darken the kiosk's unreadable text.
//
// Reported as: on the screen where a customer asks to print their job, the
// words cannot be seen. The cause is not a missing colour, it is contrast. The
// receipt card and the other confirm overlays are painted with these greys:
//
//     #94a3b8  2.56:1 against white   - fails WCAG AA
//     #7d90ad  3.25:1 against white   - large text only
//     #60a5fa  2.54:1 against white   - fails WCAG AA
//
// At 13px, on a standing kiosk that may be behind glass or in daylight, that is
// not "low contrast", it is effectively invisible. Replacements are #334155
// (10.35:1) and #1d4ed8, both of which pass comfortably.
//
// Two uses are deliberately left muted rather than darkened, and are handled
// separately below: an SVG icon stroke, and the "Not reported" placeholder for
// an unreadable level, which should stay visually quiet because it is telling
// the customer there is no reading - but not so quiet it cannot be read.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'kiosk', 'walkin.html');
let text = fs.readFileSync(file, 'utf8');
const before = text;

// Guard the two special cases first so the blanket replace cannot touch them.
//
// Only the quoted COLOUR TOKEN is swapped, never the whole expression around
// it. An earlier version replaced the entire `level === null ? '#94a3b8' : ''`
// span and then restored only the placeholder inside it, which produced nested
// quotes and a syntax error on the kiosk's supply panel.
const KEEP_STROKE = '__KEEP_SVG_STROKE__';
const KEEP_UNREAD = '__KEEP_NOT_REPORTED__';

const stroke = text.includes('stroke="#94a3b8"') ? 'stroke="#94a3b8"' : null;
if (stroke) text = text.replace(stroke, 'stroke="' + KEEP_STROKE + '"');

const unread = text.includes("? '#94a3b8' : ''") ? "? '#94a3b8' : ''" : null;
if (unread) text = text.replace(unread, "? '" + KEEP_UNREAD + "' : ''");

const counts = {};
const swap = (from, to) => {
  const n = (text.match(new RegExp(from.replace('#', '\\#'), 'g')) || []).length;
  if (n) counts[from + ' -> ' + to] = n;
  text = text.split(from).join(to);
};

swap('#7d90ad', '#334155');
swap('#94a3b8', '#334155');
swap('#60a5fa', '#1d4ed8');

// Restore the special cases with readable-but-still-quiet values.
if (stroke) text = text.replace(KEEP_STROKE, 'stroke="#64748b"');
if (unread) text = text.replace(KEEP_UNREAD, '#64748b');

if (text === before) {
  console.log('  nothing to change');
} else {
  fs.writeFileSync(file, text, 'utf8');
  console.log('  contrast fixes applied:');
  for (const [k, v] of Object.entries(counts)) console.log('    ' + k + '  (' + v + ')');
  console.log('    SVG stroke #94a3b8 -> #64748b (kept, it is an icon)');
  if (unread) console.log("    'Not reported' #94a3b8 -> #64748b (kept muted, but readable)");
}