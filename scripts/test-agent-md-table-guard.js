// Prove the AGENT.md table-shape guard actually fires. Injects a deliberately
// malformed row, confirms the check fails, then restores the file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const file = path.join(__dirname, '..', 'AGENT.md');
const original = fs.readFileSync(file, 'utf8');

function runCheck() {
  try {
    const out = execFileSync(process.execPath,
      [path.join(__dirname, 'check-html-encoding.js')], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

try {
  // A row with one extra cell - exactly what a stray separator produces.
  const broken = original.replace(
    '| `website/upload.html` |',
    '| `website/upload.html` | EXTRA |');
  if (broken === original) throw new Error('injection did not match - test is invalid');

  fs.writeFileSync(file, broken, 'utf8');
  const bad = runCheck();
  const caught = bad.code !== 0 && /AGENT\.md:\d+ table row/.test(bad.out);
  console.log('  injected a 3-cell row into a 2-column table');
  console.log('  check exit code: ' + bad.code + (caught ? '  -> GUARD WORKS' : '  -> GUARD MISSED IT'));
  if (!caught) {
    const line = bad.out.split('\n').find((l) => /AGENT/.test(l));
    if (line) console.log('  ' + line.trim());
  }
} finally {
  fs.writeFileSync(file, original, 'utf8');
  const good = runCheck();
  console.log('  restored -> check exit code: ' + good.code + (good.code === 0 ? '  (clean)' : '  (STILL BROKEN)'));
}