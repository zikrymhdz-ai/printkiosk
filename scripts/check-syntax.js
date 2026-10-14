// Syntax-checks every serverless function and every inline <script> block in
// the front-end HTML. There is no test suite in this project, so a stray
// syntax error only shows up as a blank page or a 500 on the kiosk at the far
// end of the building.
//
// Run: node scripts/check-syntax.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = require('os').tmpdir();
let failed = 0;

function check(file, code, label) {
  const out = path.join(tmp, 'pkcheck-' + Buffer.from(label).toString('hex').slice(0, 24) + '.js');
  fs.writeFileSync(out, code);
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    console.log('  ok      ' + label);
  } catch (e) {
    failed++;
    console.error('  FAILED  ' + label);
    console.error(String(e.stderr || e.stdout || e).split('\n').slice(0, 6).map(l => '            ' + l).join('\n'));
  } finally {
    fs.unlinkSync(out);
  }
}

// Functions
const fnDir = path.join(ROOT, 'netlify', 'functions');
for (const f of fs.readdirSync(fnDir)) {
  if (!f.endsWith('.js')) continue;
  check(f, fs.readFileSync(path.join(fnDir, f), 'utf8'), 'netlify/functions/' + f);
}

// Inline scripts in the kiosk / website / admin HTML
const htmlTargets = [
  'kiosk/walkin.html',
  'admin/admin.html',
  'website/upload.html',
  'website/customer.html',
];

for (const rel of htmlTargets) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log('  skip    ' + rel + ' (missing)'); continue; }
  const html = fs.readFileSync(abs, 'utf8');
  const blocks = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  let n = 0;
  for (const b of blocks) {
    const code = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    if (!code.trim()) continue;
    n++;
    check(rel, code, rel + ' (inline #' + n + ')');
  }
}

// Div balance catches a half-finished HTML restructure, which the JS syntax
// check cannot see.
for (const rel of htmlTargets) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const html = fs.readFileSync(abs, 'utf8');
  const open = (html.match(/<div\b/gi) || []).length;
  const close = (html.match(/<\/div>/gi) || []).length;
  if (open !== close) {
    failed++;
    console.error('  FAILED  ' + rel + ' unbalanced <div>: ' + open + ' open vs ' + close + ' close');
  } else {
    console.log('  ok      ' + rel + ' div balance (' + open + ')');
  }
}

console.log(failed ? '\n' + failed + ' problem(s).' : '\nall syntax checks passed.');
process.exit(failed ? 1 : 0);
