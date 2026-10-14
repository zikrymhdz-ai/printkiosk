// Keeps netlify/functions/_shared.js and kiosk/walkin.html on the same version.
//
// Run after bumping version.js:  node scripts/sync-version.js
//
// Exits non-zero if the two ever drift, so CI (or a habit) catches it before
// the kiosk is deployed into an infinite reload loop.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.js');
const SHARED = path.join(ROOT, 'netlify', 'functions', '_shared.js');
const WALKIN = path.join(ROOT, 'kiosk', 'walkin.html');

const target = require(VERSION_FILE).APP_VERSION;

const SHARED_RE = /const APP_VERSION = '([^']+)'/;
const WALKIN_RE = /var KIOSK_APP_VERSION = '([^']+)'/;

function rewrite(file, re, name, value) {
  const before = fs.readFileSync(file, 'utf8');
  const m = before.match(re);
  if (!m) throw new Error(name + ' not found in ' + path.relative(ROOT, file));

  if (m[1] === value) {
    console.log('  ok       ' + path.relative(ROOT, file) + '  ' + value);
    return false;
  }

  fs.writeFileSync(file, before.replace(re, function (full, _old) {
    return full.replace(_old, value);
  }));
  console.log('  updated  ' + path.relative(ROOT, file) + '  ' + m[1] + ' -> ' + value);
  return true;
}

console.log('syncing app version -> ' + target);
const changed = [
  rewrite(SHARED, SHARED_RE, 'APP_VERSION', target),
  rewrite(WALKIN, WALKIN_RE, 'KIOSK_APP_VERSION', target),
];

// Verify by re-reading, so a regex that silently failed to match cannot pass.
const check = [
  [SHARED, SHARED_RE],
  [WALKIN, WALKIN_RE],
].map(function (pair) {
  const found = fs.readFileSync(pair[0], 'utf8').match(pair[1]);
  return found ? found[1] : null;
});

const bad = check.filter(function (v) { return v !== target; });
if (bad.length) {
  console.error('\nFAILED: version drift remains -> ' + JSON.stringify(check));
  process.exit(1);
}

console.log(changed.length ? '\nversion synced.' : '\nalready in sync.');
